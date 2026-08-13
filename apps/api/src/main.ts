import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  NAS100,
  applySchema,
  barCoverage,
  countTrades,
  createHypothesis,
  createSplit,
  createValidationRun,
  deleteSplit,
  findGaps,
  findHypothesis,
  getInstrument,
  getPluginInstall,
  iterateTrades,
  listEntryRules,
  listHypotheses,
  listImportBatches,
  listPluginInstalls,
  listSplits,
  listValidationRuns,
  listVariables,
  loadBars,
  openDatabase,
  optimize,
  removePluginInstall,
  setHypothesisStatus,
  setPluginConfig,
  setPluginEnabled,
  upsertInstrument,
  upsertPluginInstall,
} from "@trf/database";
import {
  analyzeAll,
  assertHypothesisSafe,
  bonferroniQValue,
  buildRegistry,
  collectVariables,
  decideValidation,
  describe as describePredicate,
  discoverPatterns,
  evaluateCohort,
  evaluateComplement,
  loadFeatureMatrix,
  parseExpression,
  parsePredicate,
  predictorKeys,
  recordSplitUse,
  resolveSplit,
  runResearch,
  serializePredicate,
  splitStability,
} from "@trf/analyzer";
import {
  formatAsMt5Csv,
  formatImportSummary,
  generateNas100Bars,
  importBarsFromFile,
} from "@trf/importer";
import { discoverManifests, importPlugin, loadPlugins, parseManifest, type PluginRegistry } from "@trf/plugin-sdk";
import { TrfError, ValidationError, equityCurve, isTimeframe, parseIsoDateUtc, summarize, type Timeframe } from "@trf/shared";

/**
 * API HTTP LOCAL.
 *
 * Capa finísima sobre `@trf/analyzer` y `@trf/database`: recibe, valida,
 * delega y serializa. No hay lógica de negocio aquí, y es deliberado — el
 * dashboard del nivel 8 y el CLI deben ver exactamente el mismo
 * comportamiento, así que ambos llaman a los mismos paquetes.
 *
 * Se usa el módulo `http` de Node sin framework: son pocas rutas y añadir una
 * dependencia de servidor para esto sólo aporta superficie de mantenimiento.
 * Si el dashboard crece hasta necesitar middlewares, autenticación o
 * websockets, el momento de traer Fastify será entonces, no ahora.
 *
 * SIN AUTENTICACIÓN A PROPÓSITO: escucha sólo en 127.0.0.1. Nada de esto debe
 * exponerse a una red.
 */

const PORT = Number(process.env["TRF_API_PORT"] ?? 4319);
const HOST = "127.0.0.1";
const WEB_ORIGIN = process.env["TRF_WEB_ORIGIN"] ?? "http://localhost:3000";

const { db, config } = openDatabase();
applySchema(db);

/**
 * Sincroniza `plugins/` con la tabla `plugin_installs` y carga el registro
 * ejecutable. Réplica de `loadRegistry()` en `apps/cli/src/context.ts` — se
 * duplica en vez de compartirse porque son ~15 líneas y ninguna de las dos
 * apps depende de la otra a propósito (ver ADR de arquitectura de plugins).
 * Sólo la usa la ruta `/api/data/run`: las demás rutas sólo necesitan el
 * CATÁLOGO de variables (`listVariables`), no el código de los plugins.
 */
async function loadRegistry(): Promise<PluginRegistry> {
  for (const discovered of discoverManifests(config.pluginsDir)) {
    upsertPluginInstall(db, {
      id: discovered.manifest.id,
      version: discovered.manifest.version,
      name: discovered.manifest.name,
      author: discovered.manifest.author,
      description: discovered.manifest.description,
      directory: discovered.directory,
      enabled: discovered.manifest.enabledByDefault,
      config: discovered.manifest.config,
    });
  }

  const overrides = new Map(
    listPluginInstalls(db).map((install) => [install.id, { enabled: install.enabled, config: install.config }]),
  );

  return loadPlugins(config.pluginsDir, {
    overrides,
    tolerant: true,
    onError: (pluginId, error) => {
      console.warn(`⚠  El plugin "${pluginId}" no se pudo cargar y se ha omitido:`);
      console.warn(`   ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}

/** Resuelve un nombre de fichero de importación: relativo a `data/imports/` o ruta absoluta tal cual. */
function resolveImportPath(file: string): string {
  return isAbsolute(file) ? file : join(config.importsDir, file);
}

/** El NAS100 se crea solo la primera vez, igual que `openContext()` en el CLI. */
function getOrCreateInstrument(instrumentId: string) {
  const existing = getInstrument(db, instrumentId);
  if (existing !== null) return existing;
  upsertInstrument(db, NAS100);
  return NAS100;
}

/**
 * Un plugin subido desde la web nunca pasa por `pnpm install`, así que no
 * tiene el symlink que pnpm crearía en su `node_modules/@trf/*` para
 * resolver `import ... from "@trf/plugin-sdk"`. Son los únicos dos paquetes
 * que un plugin puede necesitar, así que se crean a mano — mismo resultado
 * que `pnpm install`, sin depender de la terminal del usuario.
 */
function ensurePluginModuleLinks(pluginDir: string): void {
  const repoRoot = resolvePath(config.pluginsDir, "..");
  const scopeDir = join(pluginDir, "node_modules", "@trf");
  mkdirSync(scopeDir, { recursive: true });
  for (const pkg of ["plugin-sdk", "shared"] as const) {
    const linkPath = join(scopeDir, pkg);
    if (existsSync(linkPath)) continue;
    symlinkSync(join(repoRoot, "packages", pkg), linkPath, "dir");
  }
}

// --- Utilidades compartidas por varias rutas --------------------------------

/** Reduce una serie a como mucho `maxPoints` puntos, conservando el último. */
function downsample(values: ArrayLike<number>, maxPoints: number): number[] {
  const n = values.length;
  if (n <= maxPoints) return Array.from(values);
  const step = n / maxPoints;
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(values[Math.floor(i * step)] as number);
  const last = values[n - 1] as number;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function labelsFrom(definitions: ReturnType<typeof listVariables>): Map<string, string> {
  return new Map(definitions.map((d) => [d.key, d.label]));
}

function ruleFilter(url: URL): { entryRuleId?: string } {
  const rule = url.searchParams.get("rule");
  return rule === null ? {} : { entryRuleId: rule };
}

function numberParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new ValidationError(`El parámetro '${key}' debe ser numérico`, { key, raw });
  return parsed;
}

function requireParam(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (value === null || value.length === 0) {
    throw new ValidationError(`Falta el parámetro obligatorio '${key}'`, { key });
  }
  return value;
}

// --- Router mínimo: método + patrón con :parámetros ------------------------

interface RouteContext {
  readonly url: URL;
  readonly instrumentId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type Handler = (context: RouteContext) => unknown | Promise<unknown>;

interface Route {
  readonly method: "GET" | "POST" | "DELETE";
  readonly pattern: readonly string[];
  readonly handler: Handler;
}

function pattern(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

function matchRoute(route: Route, method: string, pathname: string): Record<string, string> | null {
  if (route.method !== method) return null;
  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (segments.length !== route.pattern.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const expected = route.pattern[i] as string;
    const actual = segments[i] as string;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 5_000_000) reject(new ValidationError("Cuerpo de la petición demasiado grande"));
    });
    request.on("end", () => {
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new ValidationError("El cuerpo no es JSON válido", { raw: raw.slice(0, 200) }));
      }
    });
    request.on("error", reject);
  });
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) {
    throw new ValidationError("Se esperaba un cuerpo JSON con campos");
  }
  return body as Record<string, unknown>;
}

function requireBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`El campo '${key}' es obligatorio y debe ser una cadena`, { key });
  }
  return value;
}

function bodyNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`El campo '${key}' debe ser numérico`, { key, value });
  }
  return value;
}

// --- Discovery: jobs en segundo plano -----------------------------------------
//
// `discoverPatterns` puede tardar minutos con datasets grandes. En vez de
// bloquear la respuesta HTTP hasta que termine, se guarda el progreso en
// memoria y el cliente lo sondea. Guardado en memoria a propósito: es una app
// local de un solo usuario y un solo proceso, no hace falta persistir jobs
// entre reinicios de la API.

interface DiscoveryJob {
  status: "running" | "done" | "error";
  evaluated: number;
  startedAt: number;
  result?: unknown;
  errorPayload?: { name: string; code: string; message: string; context: Record<string, unknown> };
}

const discoveryJobs = new Map<string, DiscoveryJob>();

/** Se ejecuta en cada arranque de job: descarta jobs terminados de hace más de 30 minutos. */
function pruneDiscoveryJobs(): void {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of discoveryJobs) {
    if (job.status !== "running" && job.startedAt < cutoff) discoveryJobs.delete(id);
  }
}

// --- Rutas -------------------------------------------------------------------

const routes: Route[] = [
  { method: "GET", pattern: pattern("/api/health"), handler: () => ({ status: "ok", database: db.name }) },

  {
    method: "GET",
    pattern: pattern("/api/instrument"),
    handler: ({ instrumentId }) => ({
      instrumentId,
      bars: barCoverage(db, instrumentId, "M1"),
      trades: countTrades(db, { instrumentId }),
    }),
  },

  { method: "GET", pattern: pattern("/api/variables"), handler: () => ({ variables: listVariables(db) }) },

  {
    method: "GET",
    pattern: pattern("/api/splits"),
    handler: ({ instrumentId }) => ({ splits: listSplits(db, { instrumentId }) }),
  },

  /**
   * POST /api/splits
   * body: { name, role: "training"|"validation"|"holdout", from, to, embargoDays?, description? }
   *
   * Equivalente a `pnpm trf splits:create`. `createSplit` rehúsa un split de
   * validación/holdout que solape con uno de entrenamiento (embargo
   * incluido) — es la barrera que evita la fuga de datos, no un aviso.
   */
  {
    method: "POST",
    pattern: pattern("/api/splits"),
    handler: ({ body, instrumentId }) => {
      const input = bodyObject(body);
      const name = requireBodyString(input, "name");
      const role = requireBodyString(input, "role");
      if (role !== "training" && role !== "validation" && role !== "holdout") {
        throw new ValidationError('"role" debe ser training, validation o holdout', { role });
      }
      const from = requireBodyString(input, "from");
      const to = requireBodyString(input, "to");
      const embargoDays = typeof input["embargoDays"] === "number" ? input["embargoDays"] : 5;
      const description = typeof input["description"] === "string" ? input["description"] : "";

      const split = createSplit(db, {
        id: `${instrumentId}_${name}`,
        name,
        instrumentId,
        role,
        startTs: parseIsoDateUtc(from),
        endTs: parseIsoDateUtc(to),
        embargoDays,
        description,
      });

      return { split };
    },
  },

  /**
   * DELETE /api/splits/:id
   *
   * `createSplit` no tiene "editar" — la web lo simula borrando y volviendo a
   * crear con las fechas nuevas (ver POST /api/splits). Borrar reinicia el
   * contador de usos, que es lo correcto: ese contador mide cuántas veces se
   * ha mirado ESE rango de fechas, y si el rango cambia ya no es el mismo.
   */
  {
    method: "DELETE",
    pattern: pattern("/api/splits/:id"),
    handler: ({ params }) => {
      const id = params["id"] as string;
      const deleted = deleteSplit(db, id);
      if (!deleted) throw new ValidationError(`No hay ningún split con id "${id}"`);
      return { deleted: true, id };
    },
  },

  /**
   * GET /api/cohort?split=train&where=<expresión>[&diagnostic=1][&rule=<id>]
   *
   * Métricas de la cohorte, su complemento, estabilidad entre mitades y una
   * curva de equity ya reducida para graficar. La guarda anti-lookahead se
   * aplica igual que en el CLI.
   */
  {
    method: "GET",
    pattern: pattern("/api/cohort"),
    handler: ({ url, instrumentId }) => {
      const splitName = requireParam(url, "split");
      const expression = url.searchParams.get("where") ?? "";
      const diagnostic = url.searchParams.get("diagnostic") === "1";

      const { split, query } = resolveSplit(db, instrumentId, splitName, ruleFilter(url));
      const definitions = listVariables(db);
      const registry = buildRegistry(definitions);

      const predicate = parseExpression(expression);
      assertHypothesisSafe(predicate, registry, diagnostic ? { purpose: "diagnostic" } : {});

      const matrix = loadFeatureMatrix(db, { variables: collectVariables(predicate), query });
      const result = evaluateCohort(matrix, predicate);
      const warning = recordSplitUse(db, split);

      return {
        split: { name: split.name, role: split.role, evaluationCount: split.evaluationCount + 1 },
        predicate,
        description: describePredicate(predicate, labelsFrom(definitions)),
        coverage: result.coverage,
        population: summarize(matrix.pnl),
        cohort: result.metrics,
        complement: evaluateComplement(matrix, result.mask),
        stability: splitStability(matrix, result.mask),
        curve: downsample(equityCurve(result.pnl), 300),
        warning,
      };
    },
  },

  /**
   * GET /api/marginal?split=train[&minCount=50][&rule=<id>]
   *
   * Equivalente a `analyze:marginal`: qué hace cada variable predictora por su
   * cuenta, ya corregido por multiplicidad (Benjamini-Hochberg). Devuelve la
   * lista completa (incluidos los tramos de cada variable) para que la tabla
   * del dashboard ordene y filtre sin más peticiones.
   */
  {
    method: "GET",
    pattern: pattern("/api/marginal"),
    handler: ({ url, instrumentId }) => {
      const splitName = requireParam(url, "split");
      const minCount = numberParam(url, "min-count") ?? 50;

      const { split, query } = resolveSplit(db, instrumentId, splitName, ruleFilter(url));
      const definitions = listVariables(db);
      const registry = buildRegistry(definitions);
      const predictors = predictorKeys(definitions);

      const matrix = loadFeatureMatrix(db, { variables: predictors, query });
      const population = summarize(matrix.pnl);
      const analyses = analyzeAll(matrix, predictors, registry, { minCount });
      const warning = recordSplitUse(db, split);

      return {
        split: { name: split.name, role: split.role, evaluationCount: split.evaluationCount + 1 },
        size: matrix.size,
        population,
        variables: analyses,
        warning,
      };
    },
  },

  /**
   * POST /api/discover
   * body: { split, minTrades?, minWinrate?, minPf?, maxDdPct?, maxConditions?, top?, rule? }
   *
   * Nivel 6: búsqueda combinatoria. Con datasets grandes (cientos de miles de
   * operaciones) el cálculo puede tardar minutos — bloquear la respuesta
   * hasta el final dejaría al usuario sin ninguna señal de vida, así que esto
   * arranca el trabajo EN SEGUNDO PLANO y devuelve un `jobId` al instante.
   * El progreso y el resultado se consultan sondeando
   * `GET /api/discover/:jobId`. Cada resultado incluye su q-valor sobre TODO
   * el espacio evaluado y una descripción legible del predicado, lista para
   * convertirse en `hypothesis:save` desde el dashboard.
   */
  {
    method: "POST",
    pattern: pattern("/api/discover"),
    handler: ({ body, instrumentId }) => {
      const input = bodyObject(body);
      const splitName = requireBodyString(input, "split");
      const minTrades = bodyNumber(input, "minTrades") ?? 100;
      const minWinRate = bodyNumber(input, "minWinrate");
      const minProfitFactor = bodyNumber(input, "minPf");
      const maxDrawdownPct = bodyNumber(input, "maxDdPct");
      const maxConditions = bodyNumber(input, "maxConditions") ?? 3;
      const top = bodyNumber(input, "top") ?? 20;
      const rule = typeof input["rule"] === "string" && input["rule"].length > 0 ? input["rule"] : undefined;

      const { split, query } = resolveSplit(db, instrumentId, splitName, rule === undefined ? {} : { entryRuleId: rule });
      const definitions = listVariables(db);
      const registry = buildRegistry(definitions);
      const predictors = predictorKeys(definitions);
      const labels = labelsFrom(definitions);

      // La carga de la matriz es rápida (lectura de SQLite); lo lento es la
      // búsqueda combinatoria de abajo, que es la que se manda a segundo plano.
      const matrix = loadFeatureMatrix(db, { variables: predictors, query });

      const jobId = `disc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const job: DiscoveryJob = { status: "running", evaluated: 0, startedAt: Date.now() };
      discoveryJobs.set(jobId, job);
      pruneDiscoveryJobs();

      discoverPatterns(
        matrix,
        predictors,
        registry,
        { minTrades, minWinRate, minProfitFactor, maxDrawdownPct, maxConditions, top },
        (evaluated) => {
          job.evaluated = evaluated;
        },
      )
        .then((report) => {
          const warning = recordSplitUse(db, split);
          job.status = "done";
          job.result = {
            split: { name: split.name, role: split.role, evaluationCount: split.evaluationCount + 1 },
            report: {
              ...report,
              results: report.results.map((result) => ({
                ...result,
                description: describePredicate(result.predicate, labels),
                predicateJson: serializePredicate(result.predicate),
              })),
            },
            warning,
          };
        })
        .catch((error: unknown) => {
          job.status = "error";
          job.errorPayload =
            error instanceof TrfError
              ? error.toJSON()
              : { name: "Error", code: "E_UNKNOWN", message: error instanceof Error ? error.message : String(error), context: {} };
        });

      return { jobId };
    },
  },

  /**
   * GET /api/discover/:jobId
   *
   * Sondeo de un job iniciado con `POST /api/discover`. Devuelve siempre 200:
   * el estado del job ("running"/"done"/"error") va en el cuerpo, no en el
   * código HTTP, para que sondear no dispare el manejo de errores del cliente
   * mientras el trabajo simplemente sigue en curso.
   */
  {
    method: "GET",
    pattern: pattern("/api/discover/:jobId"),
    handler: ({ params }) => {
      const job = discoveryJobs.get(params["jobId"] ?? "");
      if (job === undefined) {
        return { status: "error", error: { name: "NotFoundError", code: "E_JOB_NOT_FOUND", message: "Ese job de búsqueda no existe (¿expiró o se reinició la API?)", context: {} } };
      }
      if (job.status === "running") return { status: "running", evaluated: job.evaluated };
      if (job.status === "error") return { status: "error", error: job.errorPayload };
      return { status: "done", ...(job.result as Record<string, unknown>) };
    },
  },

  // --- Hipótesis (nivel 7) ---------------------------------------------------

  {
    method: "GET",
    pattern: pattern("/api/hypotheses"),
    handler: ({ url }) => {
      const status = url.searchParams.get("status");
      const definitions = listVariables(db);
      const labels = labelsFrom(definitions);
      const hypotheses = listHypotheses(db, status === null ? {} : { status: status as never });
      return {
        hypotheses: hypotheses.map((h) => ({
          ...h,
          description: describePredicate(parsePredicate(h.predicateJson), labels),
        })),
      };
    },
  },

  /**
   * POST /api/hypotheses
   * body: { name, description?, where | predicateJson, split, searchSpaceSize?, criteria? }
   *
   * Equivalente a `hypothesis:save`: evalúa el predicado en el split de
   * ENTRENAMIENTO indicado y congela ese resultado. No toca ningún split de
   * validación.
   *
   * Acepta el predicado de dos formas: `where` (texto del minilenguaje, igual
   * que el CLI) o `predicateJson` (el AST ya serializado que devuelve
   * `/api/discover` en cada resultado). La segunda evita un viaje de ida y
   * vuelta por el parser de texto cuando la hipótesis nace de un resultado de
   * discovery en vez de escribirse a mano.
   */
  {
    method: "POST",
    pattern: pattern("/api/hypotheses"),
    handler: ({ body, instrumentId }) => {
      const input = bodyObject(body);
      const name = requireBodyString(input, "name");
      const splitName = requireBodyString(input, "split");
      const description = typeof input["description"] === "string" ? input["description"] : "";
      const searchSpaceSize =
        typeof input["searchSpaceSize"] === "number" && Number.isFinite(input["searchSpaceSize"])
          ? input["searchSpaceSize"]
          : 1;
      const criteria =
        typeof input["criteria"] === "object" && input["criteria"] !== null
          ? (input["criteria"] as Record<string, unknown>)
          : {};

      const { query } = resolveSplit(db, instrumentId, splitName);
      const definitions = listVariables(db);
      const registry = buildRegistry(definitions);

      const predicateJsonInput = input["predicateJson"];
      const predicate =
        typeof predicateJsonInput === "string"
          ? parsePredicate(predicateJsonInput)
          : parseExpression(requireBodyString(input, "where"));
      assertHypothesisSafe(predicate, registry);

      const variables = collectVariables(predicate);
      const matrix = loadFeatureMatrix(db, { variables, query });
      const result = evaluateCohort(matrix, predicate);

      if (result.metrics.count === 0) {
        throw new ValidationError("Ninguna operación del split de entrenamiento cumple esta hipótesis. No se guarda.");
      }

      const hypothesis = createHypothesis(db, {
        name,
        description,
        predicateJson: serializePredicate(predicate),
        variables,
        criteria,
        trainingMetrics: result.metrics,
        searchSpaceSize,
      });

      return {
        hypothesis,
        description: describePredicate(predicate, labelsFrom(definitions)),
        bonferroniQ: searchSpaceSize > 1 ? bonferroniQValue(result.metrics.pValue, searchSpaceSize) : null,
      };
    },
  },

  {
    method: "GET",
    pattern: pattern("/api/hypotheses/:id"),
    handler: ({ params }) => {
      const hypothesis = findHypothesis(db, params["id"] as string);
      if (hypothesis === null) throw new ValidationError(`No existe la hipótesis "${params["id"]}"`);
      const definitions = listVariables(db);
      const predicate = parsePredicate(hypothesis.predicateJson);
      return {
        hypothesis,
        predicate,
        description: describePredicate(predicate, labelsFrom(definitions)),
        validationRuns: listValidationRuns(db, hypothesis.id),
      };
    },
  },

  /**
   * POST /api/hypotheses/:id/validate
   * body: { split, confirm? }
   *
   * Sin `confirm: true` NO EJECUTA NADA: sólo devuelve cuántas veces se ha
   * usado ese split, para que la interfaz obligue a una segunda confirmación
   * explícita antes de gastar el dataset de validación (regla 3 del
   * dashboard: "el botón de validación debe doler").
   */
  {
    method: "POST",
    pattern: pattern("/api/hypotheses/:id/validate"),
    handler: ({ params, body, instrumentId }) => {
      const input = bodyObject(body);
      const splitName = requireBodyString(input, "split");
      const confirm = input["confirm"] === true;

      const hypothesis = findHypothesis(db, params["id"] as string);
      if (hypothesis === null) throw new ValidationError(`No existe la hipótesis "${params["id"]}"`);
      if (hypothesis.status === "validated" || hypothesis.status === "rejected") {
        throw new ValidationError(
          `La hipótesis "${hypothesis.name}" ya fue ${hypothesis.status === "validated" ? "VALIDADA" : "RECHAZADA"} ` +
            "y no se puede revalidar. Crea una hipótesis nueva si quieres reintentar.",
        );
      }
      if (hypothesis.trainingMetrics === null) {
        throw new ValidationError(`La hipótesis "${hypothesis.name}" no tiene métricas de entrenamiento.`);
      }

      const { split, query } = resolveSplit(db, instrumentId, splitName);
      if (split.role === "training") {
        throw new ValidationError(`"${splitName}" es un split de ENTRENAMIENTO; la validación necesita uno de validación u holdout.`);
      }

      if (!confirm) {
        return {
          requiresConfirmation: true,
          split: { name: split.name, role: split.role, evaluationCount: split.evaluationCount },
          message:
            split.evaluationCount > 0
              ? `Este split se ha usado ${split.evaluationCount} vez/veces antes. Cada mirada adicional gasta parte de su valor como fuera de muestra.`
              : "Sería la primera vez que se mira este split — la comprobación más limpia posible.",
        };
      }

      const definitions = listVariables(db);
      const predicate = parsePredicate(hypothesis.predicateJson);
      const registry = buildRegistry(definitions);
      assertHypothesisSafe(predicate, registry);

      const variables = collectVariables(predicate);
      const matrix = loadFeatureMatrix(db, { variables, query });
      const result = evaluateCohort(matrix, predicate);

      const decision = decideValidation(hypothesis.trainingMetrics, result.metrics);

      const run = createValidationRun(db, {
        hypothesisId: hypothesis.id,
        splitId: split.id,
        metrics: result.metrics,
        pValue: result.metrics.pValue,
        qValue: result.metrics.pValue,
        passed: decision.passed,
        notes: decision.reason,
      });
      setHypothesisStatus(db, hypothesis.id, decision.passed ? "validated" : "rejected");
      const warning = recordSplitUse(db, split);

      return {
        decision,
        run,
        validationMetrics: result.metrics,
        curve: downsample(equityCurve(result.pnl), 300),
        hypothesis: findHypothesis(db, hypothesis.id),
        warning,
      };
    },
  },

  // --- Plugins -----------------------------------------------------------------

  /**
   * GET /api/plugins
   *
   * Combina lo persistido (activo/inactivo, config) con lo declarado en cada
   * `plugin.json` en disco (kind, variables que aporta). `discoverManifests`
   * sólo lee JSON, no importa código: listar plugins nunca ejecuta nada.
   */
  {
    method: "GET",
    pattern: pattern("/api/plugins"),
    handler: () => {
      const installs = listPluginInstalls(db);
      const manifests = new Map(discoverManifests(config.pluginsDir).map((d) => [d.manifest.id, d.manifest]));
      return {
        plugins: installs.map((install) => {
          const manifest = manifests.get(install.id);
          return {
            ...install,
            kind: manifest?.kind ?? [],
            provides: manifest?.provides ?? [],
          };
        }),
      };
    },
  },

  /**
   * POST /api/plugins/upload
   * body: { manifest: object, code: string }
   *
   * Instala un plugin nuevo sin CLI ni `pnpm install`: escribe `plugin.json`
   * y `src/index.ts` en `plugins/<id>/`, resuelve sus imports a mano
   * (`ensurePluginModuleLinks`) y hace una importación de PRUEBA antes de
   * registrarlo — si el código no carga, se borra todo y se devuelve el
   * error, así un plugin roto nunca llega a la lista ni puede tumbar una
   * corrida futura.
   *
   * DEBE declararse antes que `POST /api/plugins/:id`: el router usa la
   * primera coincidencia, y ese patrón con `:id` también encajaría con
   * "upload" tratándolo como si fuera un id de plugin.
   */
  {
    method: "POST",
    pattern: pattern("/api/plugins/upload"),
    handler: async ({ body }) => {
      const input = bodyObject(body);
      const manifestRaw = input["manifest"];
      if (typeof manifestRaw !== "object" || manifestRaw === null) {
        throw new ValidationError("Falta 'manifest' (el contenido de plugin.json) o no es un objeto");
      }
      const code = requireBodyString(input, "code");

      const parsed = parseManifest(manifestRaw, "subida desde la web");
      // El entry siempre se fuerza a src/index.ts: es donde se escribe el código,
      // sin importar qué diga el manifiesto subido.
      const manifest = { ...parsed, entry: "./src/index.ts" };

      const alreadyInstalled = discoverManifests(config.pluginsDir).some((d) => d.manifest.id === manifest.id);
      if (alreadyInstalled) {
        throw new ValidationError(
          `Ya existe un plugin instalado con id "${manifest.id}". Elimínalo primero si quieres reemplazarlo.`,
          { id: manifest.id },
        );
      }

      const directory = resolvePath(join(config.pluginsDir, manifest.id));
      mkdirSync(join(directory, "src"), { recursive: true });
      writeFileSync(join(directory, "plugin.json"), JSON.stringify(manifest, null, 2));
      writeFileSync(join(directory, "src", "index.ts"), code);
      ensurePluginModuleLinks(directory);

      try {
        await importPlugin({ manifest, directory });
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw new ValidationError(
          `El plugin se escribió pero no se pudo cargar, así que se deshizo la instalación: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { id: manifest.id },
        );
      }

      upsertPluginInstall(db, {
        id: manifest.id,
        version: manifest.version,
        name: manifest.name,
        author: manifest.author,
        description: manifest.description,
        directory,
        enabled: manifest.enabledByDefault,
        config: manifest.config,
      });

      return { plugin: getPluginInstall(db, manifest.id) };
    },
  },

  /**
   * POST /api/plugins/:id
   * body: { enabled?: boolean, config?: object }
   *
   * `config` se FUSIONA sobre la configuración actual (igual que
   * `plugins:config --set`), no la reemplaza. Cambiar la config cambia la
   * huella de la regla de entrada: las operaciones antiguas y nuevas conviven,
   * filtrables por `entryRuleId`.
   */
  {
    method: "POST",
    pattern: pattern("/api/plugins/:id"),
    handler: ({ params, body }) => {
      const id = params["id"] as string;
      const current = getPluginInstall(db, id);
      if (current === null) throw new ValidationError(`No hay ningún plugin instalado con id "${id}"`);

      const input = bodyObject(body);
      if (typeof input["enabled"] === "boolean") {
        setPluginEnabled(db, id, input["enabled"]);
      }
      if (typeof input["config"] === "object" && input["config"] !== null) {
        const merged = { ...current.config, ...(input["config"] as Record<string, unknown>) };
        setPluginConfig(db, id, merged);
      }

      return { plugin: getPluginInstall(db, id) };
    },
  },

  /**
   * DELETE /api/plugins/:id
   *
   * Borra el plugin de disco y de `plugin_installs`. Las operaciones que ya
   * generó NO se tocan — siguen viéndose en Repetición/Discovery como
   * registro histórico; simplemente no se podrán generar operaciones nuevas
   * con este plugin hasta que se reinstale.
   */
  {
    method: "DELETE",
    pattern: pattern("/api/plugins/:id"),
    handler: ({ params }) => {
      const id = params["id"] as string;
      const install = getPluginInstall(db, id);
      if (install === null) throw new ValidationError(`No hay ningún plugin instalado con id "${id}"`);

      removePluginInstall(db, id);
      if (existsSync(install.directory)) {
        rmSync(install.directory, { recursive: true, force: true });
      }

      return { deleted: true, id };
    },
  },

  // --- Datos ---------------------------------------------------------------------

  /**
   * GET /api/data/status?tf=M1
   * Equivalente a `data:status`: cobertura, huecos de más de 24h y el
   * historial de importaciones.
   */
  {
    method: "GET",
    pattern: pattern("/api/data/status"),
    handler: ({ url, instrumentId }) => {
      const timeframeRaw = url.searchParams.get("tf") ?? "M1";
      if (!isTimeframe(timeframeRaw)) throw new ValidationError(`Timeframe desconocido: ${timeframeRaw}`);
      const timeframe = timeframeRaw as Timeframe;

      getOrCreateInstrument(instrumentId);
      return {
        timeframe,
        coverage: barCoverage(db, instrumentId, timeframe),
        trades: countTrades(db, { instrumentId }),
        gaps: findGaps(db, { instrumentId, timeframe }, 24 * 60).slice(0, 30),
        batches: listImportBatches(db, instrumentId).slice(0, 20),
      };
    },
  },

  /**
   * GET /api/data/files
   * Lista los ficheros ya presentes en `data/imports/` para poder elegirlos
   * en vez de escribir una ruta a mano (ahí caen tanto lo que genera
   * `data:generate`/"Generar" como lo que hayas copiado tú, p.ej. exports de
   * MT5 o el histórico de Dukascopy).
   */
  {
    method: "GET",
    pattern: pattern("/api/data/files"),
    handler: () => {
      const files = existsSync(config.importsDir)
        ? readdirSync(config.importsDir)
            .map((name) => {
              const full = join(config.importsDir, name);
              const stats = statSync(full);
              return stats.isFile() ? { name, sizeBytes: stats.size, modifiedAt: stats.mtime.toISOString() } : null;
            })
            .filter((f): f is { name: string; sizeBytes: number; modifiedAt: string } => f !== null)
            .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
        : [];
      return { dir: config.importsDir, files };
    },
  },

  /**
   * POST /api/data/generate
   * body: { from, to, seed?, injectPattern?, filename? }
   * Equivalente a `data:generate`: velas M1 sintéticas de NAS100, escritas en
   * `data/imports/`. No importa nada todavía — ese es el siguiente paso.
   */
  {
    method: "POST",
    pattern: pattern("/api/data/generate"),
    handler: ({ body }) => {
      const input = bodyObject(body);
      const from = requireBodyString(input, "from");
      const to = requireBodyString(input, "to");
      const seed = typeof input["seed"] === "number" ? input["seed"] : 20240101;
      const injectPattern = input["injectPattern"] === true;
      const filename =
        typeof input["filename"] === "string" && input["filename"].length > 0
          ? input["filename"]
          : `nas100-synthetic-${from}_${to}.csv`;

      const bars = [...generateNas100Bars({ startDate: from, endDate: to, seed, injectPattern })];
      const outPath = join(config.importsDir, filename);
      writeFileSync(outPath, formatAsMt5Csv(bars), "utf8");

      return { file: basename(outPath), barsGenerated: bars.length };
    },
  },

  /**
   * POST /api/data/import
   * body: { file, tf?, tz? }
   * Equivalente a `data:import`. `file` puede ser un nombre dentro de
   * `data/imports/` (los que devuelve `/api/data/files`) o una ruta absoluta.
   */
  {
    method: "POST",
    pattern: pattern("/api/data/import"),
    handler: async ({ body, instrumentId }) => {
      const input = bodyObject(body);
      const file = requireBodyString(input, "file");
      const timeframeRaw = typeof input["tf"] === "string" ? input["tf"] : "M1";
      if (!isTimeframe(timeframeRaw)) throw new ValidationError(`Timeframe desconocido: ${timeframeRaw}`);
      const sourceTimezone = typeof input["tz"] === "string" && input["tz"].length > 0 ? input["tz"] : "UTC";

      const filePath = resolveImportPath(file);
      if (!existsSync(filePath)) throw new ValidationError(`No se encuentra el fichero: ${filePath}`, { filePath });

      getOrCreateInstrument(instrumentId);
      const summary = await importBarsFromFile({
        db,
        instrumentId,
        timeframe: timeframeRaw as Timeframe,
        filePath,
        sourceTimezone,
      });
      optimize(db);

      return {
        summary,
        summaryText: formatImportSummary(summary),
        utcTimezoneWarning:
          sourceTimezone === "UTC"
            ? "Se importó como UTC. Si el CSV viene del terminal MT5, casi seguro está en la hora del servidor del bróker (UTC+2/+3), no en UTC."
            : null,
      };
    },
  },

  /**
   * POST /api/data/run
   * body: { tf?, from?, to? }
   * Equivalente a `run`: genera operaciones aplicando los plugins de entrada
   * activos y calcula todas las variables. Abre una conexión de ESCRITURA
   * separada, igual que el CLI (ver el comentario en `RunOptions.writerDb` de
   * `packages/analyzer/src/runner.ts`).
   */
  {
    method: "POST",
    pattern: pattern("/api/data/run"),
    handler: async ({ body, instrumentId }) => {
      const input = bodyObject(body);
      const timeframeRaw = typeof input["tf"] === "string" ? input["tf"] : "M1";
      if (!isTimeframe(timeframeRaw)) throw new ValidationError(`Timeframe desconocido: ${timeframeRaw}`);
      const timeframe = timeframeRaw as Timeframe;
      const fromTs = typeof input["from"] === "string" ? parseIsoDateUtc(input["from"]) : undefined;
      const toTs = typeof input["to"] === "string" ? parseIsoDateUtc(input["to"]) : undefined;

      const instrument = getOrCreateInstrument(instrumentId);
      const coverage = barCoverage(db, instrumentId, timeframe);
      if (coverage.count === 0) {
        throw new ValidationError(
          `No hay velas ${timeframe} para ${instrument.symbol}. Importa datos con ese timeframe primero.`,
        );
      }

      const registry = await loadRegistry();
      const writer = openDatabase();
      let summary;
      try {
        summary = await runResearch({
          db,
          writerDb: writer.db,
          instrument,
          registry,
          timeframe,
          ...(fromTs !== undefined ? { fromTs } : {}),
          ...(toTs !== undefined ? { toTs } : {}),
        });
      } finally {
        writer.db.close();
      }
      optimize(db);

      return { summary };
    },
  },

  // --- Repetición visual (velas + operaciones crudas) --------------------------

  /**
   * GET /api/data/bars?tf=M1&from=<iso>&to=<iso>[&limit=3000]
   * Velas OHLC crudas de un rango acotado, para dibujar un gráfico de velas.
   * Pensado para un día o unos pocos días a la vez, no para el histórico
   * completo (por eso el límite de seguridad).
   */
  {
    method: "GET",
    pattern: pattern("/api/data/bars"),
    handler: ({ url, instrumentId }) => {
      const timeframeRaw = url.searchParams.get("tf") ?? "M1";
      if (!isTimeframe(timeframeRaw)) throw new ValidationError(`Timeframe desconocido: ${timeframeRaw}`);
      const fromTs = parseIsoDateUtc(requireParam(url, "from"));
      const toTs = parseIsoDateUtc(requireParam(url, "to"));
      const limit = numberParam(url, "limit") ?? 3000;

      const bars = loadBars(db, { instrumentId, timeframe: timeframeRaw as Timeframe, fromTs, toTs, limit });
      return { bars, truncated: bars.length >= limit };
    },
  },

  /**
   * GET /api/data/trades?from=<iso>&to=<iso>[&rule=<id>][&limit=500]
   * Operaciones crudas (precio y hora de entrada/salida) de un rango, para
   * dibujarlas como marcadores sobre el gráfico de velas.
   */
  {
    method: "GET",
    pattern: pattern("/api/data/trades"),
    handler: ({ url, instrumentId }) => {
      const fromTs = parseIsoDateUtc(requireParam(url, "from"));
      const toTs = parseIsoDateUtc(requireParam(url, "to"));
      const limit = numberParam(url, "limit") ?? 500;

      const trades = [
        ...iterateTrades(db, { instrumentId, fromTs, toTs, limit, ...ruleFilter(url) }),
      ].map((t) => ({
        id: t.id,
        entryRuleId: t.entryRuleId,
        direction: t.direction,
        entryTs: t.entryTs,
        exitTs: t.exitTs,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        takeProfitPrice: t.takeProfitPrice,
        stopLossPrice: t.stopLossPrice,
        pnlMoney: t.pnlMoney,
        pnlPoints: t.pnlPoints,
        exitReason: t.exitReason,
      }));
      return { trades };
    },
  },

  /**
   * GET /api/rules
   * Catálogo de reglas de entrada ya generadas (id técnico + nombre
   * amigable del plugin que las produjo), para elegir cuál mirar en la
   * repetición visual sin tener que copiar un id a mano.
   */
  {
    method: "GET",
    pattern: pattern("/api/rules"),
    handler: () => ({ rules: listEntryRules(db) }),
  },
];

// --- Servidor HTTP -------------------------------------------------------------

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, (_key, value) =>
    typeof value === "number" && !Number.isFinite(value) ? String(value) : value,
  );
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": WEB_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  response.end(body);
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": WEB_ORIGIN,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    response.end();
    return;
  }

  void (async () => {
    for (const route of routes) {
      const params = matchRoute(route, method, url.pathname);
      if (params === null) continue;

      try {
        const body = method === "POST" ? await readBody(request) : undefined;
        const instrumentId = url.searchParams.get("instrument") ?? NAS100.id;
        const result = await route.handler({ url, instrumentId, params, body });
        send(response, 200, result);
      } catch (error) {
        if (error instanceof TrfError) {
          // 422: la petición está bien formada pero pide algo metodológicamente
          // inválido (lookahead, split inexistente, variable desconocida,
          // hipótesis ya cerrada...).
          send(response, 422, error.toJSON());
        } else {
          send(response, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return;
    }
    send(response, 404, { error: "Ruta desconocida", available: routes.map((r) => `${r.method} /${r.pattern.join("/")}`) });
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`API del laboratorio escuchando en http://${HOST}:${PORT}`);
  console.log(`CORS habilitado para ${WEB_ORIGIN}`);
  console.log("Rutas:", routes.map((r) => `${r.method} /${r.pattern.join("/")}`).join(", "));
});

process.on("SIGINT", () => {
  server.close();
  db.close();
  process.exit(0);
});
