import type {
  Bucket,
  DiscoveryReport,
  DiscoveryResult,
  MarginalAnalysis,
  Predicate,
  RankedMarginal,
} from "@trf/analyzer";
import type { CohortMetrics, DatasetSplit, Hypothesis, ValidationRun, VariableDefinition } from "@trf/shared";

/**
 * CLIENTE DE LA API — la ÚNICA puerta entre el dashboard y el laboratorio.
 *
 * Regla 1 del README de nivel 8: cero lógica de análisis en componentes. Este
 * fichero no calcula nada; sólo tipa y llama a `@trf/api`. Si una pantalla
 * necesita un cálculo nuevo, se implementa en `@trf/analyzer` y se expone como
 * ruta ahí, no aquí.
 *
 * Los tipos (`Predicate`, `CohortMetrics`...) se importan con `import type`
 * a propósito: TypeScript los borra por completo al compilar, así que ni una
 * línea de `@trf/analyzer`/`@trf/shared` (y con ellas, better-sqlite3) llega
 * al bundle del navegador. Es sólo el vocabulario compartido con el servidor.
 */

const API_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://127.0.0.1:4319";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly context: Record<string, unknown> | undefined;

  constructor(status: number, message: string, code?: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.context = context;
  }
}

interface ErrorPayload {
  readonly error?: string;
  readonly message?: string;
  readonly code?: string;
  readonly context?: Record<string, unknown>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      0,
      "No se pudo contactar con la API local. ¿Está corriendo 'pnpm api' en otra terminal?",
    );
  }

  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    const err = (payload ?? {}) as ErrorPayload;
    throw new ApiError(response.status, err.message ?? err.error ?? "Error desconocido", err.code, err.context);
  }
  return payload as T;
}

function get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return request<T>(`${path}${query.length > 0 ? `?${query}` : ""}`);
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

// --- Instrumento / cobertura --------------------------------------------------

export interface InstrumentResponse {
  readonly instrumentId: string;
  readonly bars: { readonly count: number; readonly firstTs: number | null; readonly lastTs: number | null };
  readonly trades: number;
}

export function getInstrument(): Promise<InstrumentResponse> {
  return get<InstrumentResponse>("/api/instrument");
}

// --- Variables -----------------------------------------------------------------

export function getVariables(): Promise<{ variables: VariableDefinition[] }> {
  return get("/api/variables");
}

// --- Splits ----------------------------------------------------------------------

export function getSplits(): Promise<{ splits: DatasetSplit[] }> {
  return get("/api/splits");
}

/** Equivalente a `pnpm trf splits:create`. Rechaza validación/holdout que se solape con entrenamiento. */
export function createSplit(input: {
  name: string;
  role: "training" | "validation" | "holdout";
  from: string;
  to: string;
  embargoDays?: number;
  description?: string;
}): Promise<{ split: DatasetSplit }> {
  return post("/api/splits", input);
}

/** Borra un split (p.ej. para "editarlo": se borra y se crea de nuevo con las fechas nuevas). */
export function deleteSplit(id: string): Promise<{ deleted: boolean; id: string }> {
  return del(`/api/splits/${encodeURIComponent(id)}`);
}

// --- Cohortes (analyze:cohort) --------------------------------------------------

export interface SplitRef {
  readonly name: string;
  readonly role: string;
  readonly evaluationCount: number;
}

export interface CohortResponse {
  readonly split: SplitRef;
  readonly predicate: Predicate;
  readonly description: string;
  readonly coverage: number;
  readonly population: CohortMetrics;
  readonly cohort: CohortMetrics;
  readonly complement: CohortMetrics;
  readonly stability: { readonly first: CohortMetrics; readonly second: CohortMetrics; readonly winRateDelta: number };
  readonly curve: readonly number[];
  readonly warning: { readonly message: string } | null;
}

export function getCohort(params: {
  split: string;
  where: string;
  diagnostic?: boolean;
  rule?: string;
}): Promise<CohortResponse> {
  return get("/api/cohort", {
    split: params.split,
    where: params.where,
    diagnostic: params.diagnostic ? 1 : undefined,
    rule: params.rule,
  });
}

// --- Análisis marginal -----------------------------------------------------------

export interface MarginalResponse {
  readonly split: SplitRef;
  readonly size: number;
  readonly population: CohortMetrics;
  readonly variables: RankedMarginal[];
  readonly warning: { readonly message: string } | null;
}

export function getMarginal(params: { split: string; minCount?: number; rule?: string }): Promise<MarginalResponse> {
  return get("/api/marginal", { split: params.split, "min-count": params.minCount, rule: params.rule });
}

export type { Bucket, MarginalAnalysis, RankedMarginal };

// --- Pattern Discovery (nivel 6) --------------------------------------------------

export interface DiscoveryResultWithDescription extends DiscoveryResult {
  readonly description: string;
  readonly predicateJson: string;
}

export interface DiscoverResponse {
  readonly split: SplitRef;
  readonly report: Omit<DiscoveryReport, "results"> & { readonly results: readonly DiscoveryResultWithDescription[] };
  readonly warning: { readonly message: string } | null;
}

export interface DiscoverParams {
  split: string;
  minTrades?: number;
  minWinrate?: number;
  minPf?: number;
  maxDdPct?: number;
  maxConditions?: number;
  top?: number;
  rule?: string;
}

/**
 * Inicia una búsqueda de Discovery EN SEGUNDO PLANO y devuelve un `jobId` al
 * instante. Con muchas operaciones el cálculo puede tardar minutos; hay que
 * sondear el progreso con `getDiscoverJob`.
 */
export function startDiscover(params: DiscoverParams): Promise<{ jobId: string }> {
  return post("/api/discover", params);
}

export type DiscoverJobStatus =
  | { status: "running"; evaluated: number }
  | ({ status: "done" } & DiscoverResponse)
  | { status: "error"; error: { name: string; code: string; message: string; context: Record<string, unknown> } };

export function getDiscoverJob(jobId: string): Promise<DiscoverJobStatus> {
  return get(`/api/discover/${encodeURIComponent(jobId)}`);
}

/**
 * Conveniencia: inicia el job y hace polling hasta que termine, reportando
 * el progreso por `onProgress`. Lanza `ApiError` si el job termina en error.
 */
export async function runDiscover(
  params: DiscoverParams,
  onProgress?: (evaluated: number) => void,
): Promise<DiscoverResponse> {
  const { jobId } = await startDiscover(params);
  for (;;) {
    const job = await getDiscoverJob(jobId);
    if (job.status === "running") {
      onProgress?.(job.evaluated);
      await new Promise((resolve) => setTimeout(resolve, 700));
      continue;
    }
    if (job.status === "error") {
      throw new ApiError(422, job.error.message, job.error.code, job.error.context);
    }
    const { status: _status, ...rest } = job;
    return rest as DiscoverResponse;
  }
}

// --- Hipótesis (nivel 7) ----------------------------------------------------------

export interface HypothesisWithDescription extends Hypothesis {
  readonly description: string;
}

export function getHypotheses(status?: string): Promise<{ hypotheses: HypothesisWithDescription[] }> {
  return get("/api/hypotheses", { status });
}

export interface HypothesisDetailResponse {
  readonly hypothesis: Hypothesis;
  readonly predicate: Predicate;
  readonly description: string;
  readonly validationRuns: readonly ValidationRun[];
}

export function getHypothesis(idOrName: string): Promise<HypothesisDetailResponse> {
  return get(`/api/hypotheses/${encodeURIComponent(idOrName)}`);
}

export interface SaveHypothesisInput {
  readonly name: string;
  readonly description?: string;
  /** Texto del minilenguaje (`volatility.atr > 18 and ...`). Alternativa a `predicateJson`. */
  readonly where?: string;
  /** AST ya serializado, tal como lo devuelve cada resultado de `/api/discover`. */
  readonly predicateJson?: string;
  readonly split: string;
  readonly searchSpaceSize?: number;
  readonly criteria?: Record<string, unknown>;
}

export interface SaveHypothesisResponse {
  readonly hypothesis: Hypothesis;
  readonly description: string;
  readonly bonferroniQ: number | null;
}

export function saveHypothesis(input: SaveHypothesisInput): Promise<SaveHypothesisResponse> {
  return post("/api/hypotheses", input);
}

export interface ValidateHypothesisPreview {
  readonly requiresConfirmation: true;
  readonly split: SplitRef;
  readonly message: string;
}

export interface ValidateHypothesisResult {
  readonly requiresConfirmation?: false;
  readonly decision: { readonly passed: boolean; readonly reason: string };
  readonly run: ValidationRun;
  readonly validationMetrics: CohortMetrics;
  readonly curve: readonly number[];
  readonly hypothesis: Hypothesis;
  readonly warning: { readonly message: string } | null;
}

export function validateHypothesis(
  idOrName: string,
  params: { split: string; confirm?: boolean },
): Promise<ValidateHypothesisPreview | ValidateHypothesisResult> {
  return post(`/api/hypotheses/${encodeURIComponent(idOrName)}/validate`, params);
}

// --- Plugins -----------------------------------------------------------------------

export interface PluginResponse {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly author: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  readonly kind: readonly string[];
  readonly provides: readonly VariableDefinition[];
}

export function getPlugins(): Promise<{ plugins: PluginResponse[] }> {
  return get("/api/plugins");
}

export function updatePlugin(
  id: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> },
): Promise<{ plugin: PluginResponse }> {
  return post(`/api/plugins/${encodeURIComponent(id)}`, patch);
}

/**
 * Instala un plugin nuevo escribiendo su `plugin.json` y `src/index.ts`
 * directamente en `plugins/`, sin terminal ni `pnpm install` — la API
 * resuelve sus imports y hace una carga de prueba antes de aceptarlo.
 */
export function uploadPlugin(input: { manifest: unknown; code: string }): Promise<{ plugin: PluginResponse }> {
  return post("/api/plugins/upload", input);
}

/** Borra un plugin de disco y de la lista. No borra las operaciones ya generadas. */
export function deletePlugin(id: string): Promise<{ deleted: boolean; id: string }> {
  return del(`/api/plugins/${encodeURIComponent(id)}`);
}

// --- Datos -------------------------------------------------------------------------

export interface Gap {
  readonly fromTs: number;
  readonly toTs: number;
  readonly minutes: number;
}

export interface ImportBatchRecord {
  readonly id: string;
  readonly format: string;
  readonly sourceFile: string;
  readonly rowsRead: number;
  readonly rowsAccepted: number;
  readonly rowsRejected: number;
  readonly errors: readonly string[];
}

export interface DataStatusResponse {
  readonly timeframe: string;
  readonly coverage: { readonly count: number; readonly firstTs: number | null; readonly lastTs: number | null };
  readonly trades: number;
  readonly gaps: readonly Gap[];
  readonly batches: readonly ImportBatchRecord[];
}

export function getDataStatus(tf = "M1"): Promise<DataStatusResponse> {
  return get("/api/data/status", { tf });
}

export interface ImportFile {
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

export function getDataFiles(): Promise<{ dir: string; files: ImportFile[] }> {
  return get("/api/data/files");
}

export function generateData(input: {
  from: string;
  to: string;
  seed?: number;
  injectPattern?: boolean;
  filename?: string;
}): Promise<{ file: string; barsGenerated: number }> {
  return post("/api/data/generate", input);
}

export interface ImportSummary {
  readonly batchId: string;
  readonly rowsRead: number;
  readonly rowsAccepted: number;
  readonly rowsRejected: number;
  readonly rowsInserted: number;
  readonly duplicatesSkipped: number;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  readonly previousBatchId: string | null;
  readonly elapsedMs: number;
}

export function importData(input: { file: string; tf?: string; tz?: string }): Promise<{
  summary: ImportSummary;
  summaryText: string;
  utcTimezoneWarning: string | null;
}> {
  return post("/api/data/import", input);
}

export interface RunSummary {
  readonly barsProcessed: number;
  readonly signalsGenerated: number;
  readonly tradesClosed: number;
  readonly tradesWritten: number;
  readonly entryRuleIds: readonly string[];
  readonly featureSetVersion: string;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  readonly elapsedMs: number;
}

export function runResearch(input: { tf?: string; from?: string; to?: string }): Promise<{ summary: RunSummary }> {
  return post("/api/data/run", input);
}

// --- Repetición visual ---------------------------------------------------------------

export interface RawBar {
  readonly ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly tickVolume: number;
  readonly volume: number;
  readonly spread: number;
}

export function getBars(params: { tf: string; from: string; to: string; limit?: number }): Promise<{
  bars: RawBar[];
  truncated: boolean;
}> {
  return get("/api/data/bars", params);
}

export interface RawTrade {
  readonly id: string;
  readonly entryRuleId: string;
  readonly direction: "long" | "short";
  readonly entryTs: number;
  readonly exitTs: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly takeProfitPrice: number | null;
  readonly stopLossPrice: number | null;
  readonly pnlMoney: number;
  readonly pnlPoints: number;
  readonly exitReason: string;
}

export function getTrades(params: { from: string; to: string; rule?: string; limit?: number }): Promise<{
  trades: RawTrade[];
}> {
  return get("/api/data/trades", params);
}

export interface EntryRule {
  readonly id: string;
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly config: Record<string, unknown>;
}

export function getRules(): Promise<{ rules: EntryRule[] }> {
  return get("/api/rules");
}
