import { benjaminiHochberg, summarize, type CohortMetrics, type VariableDefinition } from "@trf/shared";
import { compileMask, countMask, intersect, selectPnl } from "./cohort.js";
import type { FeatureMatrix } from "./feature-matrix.js";
import { analyzeVariable } from "./marginal.js";
import { and, type Predicate } from "./predicate.js";

/**
 * PATTERN DISCOVERY — nivel 6.
 *
 * Busca automáticamente COMBINACIONES de condiciones (no una variable a la
 * vez, como `analyze:marginal`) que cumplan los umbrales que el investigador
 * fije: mínimo de operaciones, win rate, profit factor, drawdown máximo.
 *
 * ALGORITMO (estilo Apriori):
 *
 *   Nivel 1: cada tramo del análisis marginal de cada variable predictora es
 *            un candidato ("ATR en el quintil superior", "hora == 9:30"...).
 *   Nivel k: se combinan con AND los supervivientes del nivel k-1 con
 *            candidatos de nivel 1 de OTRA variable, en orden canónico
 *            (índice creciente) para no repetir la misma combinación dos
 *            veces ni mezclar dos tramos de la misma variable entre sí.
 *
 * POST-MONOTONICIDAD — la clave de por qué esto es viable: el tamaño de una
 * cohorte nunca puede crecer al añadir una condición con AND. Si "ATR > 18"
 * ya deja menos de `minTrades` operaciones, NINGUNA conjunción que la
 * contenga llegará a `minTrades`, así que esa rama entera se descarta sin
 * evaluarla más allá de ese punto (poda anti-monótona).
 *
 * RIGOR ESTADÍSTICO: cada candidato evaluado —sobreviva o no— aporta su
 * p-valor al "universo" de la corrección de Benjamini-Hochberg. Un resultado
 * no se compara sólo contra los que finalmente se muestran, sino contra TODO
 * lo que el motor llegó a probar para encontrarlo. Sin ese número, el motor
 * es un generador de ilusiones: buscar entre 50.000 combinaciones garantiza
 * encontrar "patrones" que son puro azar si no se corrige por ello.
 *
 * ORDEN DE RESULTADOS: por q-valor (rigor) primero, por R² de la curva de
 * equity (estabilidad) después. Un PF de 8 sostenido por tres operaciones
 * enormes (R² bajo) se ordena por DEBAJO de un PF de 2 con una equity que
 * sube en línea recta (R² alto).
 */

export interface DiscoveryOptions {
  /** Mínimo de operaciones exigido. También es el umbral de poda. */
  readonly minTrades: number;
  readonly minWinRate?: number;
  readonly minProfitFactor?: number;
  /** Fracción, no porcentaje: 0.05 = 5%. */
  readonly maxDrawdownPct?: number;
  /** Profundidad máxima de la conjunción (número de condiciones). Por defecto 3. */
  readonly maxConditions?: number;
  /** Cuantiles usados para variables continuas sin binning propio. Por defecto 5. */
  readonly quantileCount?: number;
  /** Máximo de categorías antes de tratar una variable como continua. Por defecto 24. */
  readonly maxCategories?: number;
  /** Cuántos resultados devolver, ya ordenados. Por defecto 20. */
  readonly top?: number;
  /**
   * Válvula de seguridad: si el espacio de búsqueda evaluado alcanza este
   * tamaño, se deja de expandir (se conserva lo ya encontrado). Por defecto
   * 2.000.000 — a esa escala, con miles de operaciones, el resto del proceso
   * seguiría siendo instantáneo, así que el límite existe para configuraciones
   * patológicas (p.ej. `minTrades` casi 0 con cientos de variables), no para
   * el uso normal.
   */
  readonly maxSearchSpace?: number;
  /**
   * Válvula de seguridad de MEMORIA: cuántos nodos puede tener el frontier de
   * un nivel al mismo tiempo. Cada nodo guarda una máscara de `matrix.size`
   * bytes, así que sin este límite un dataset grande (cientos de miles de
   * operaciones) con `minTrades` bajo puede acumular miles de máscaras vivas
   * a la vez y agotar la memoria del proceso — no un error, un CRASH del
   * servidor entero. Por defecto se calcula solo, apuntando a un presupuesto
   * de ~250MB de máscaras vivas por nivel.
   */
  readonly maxFrontierNodes?: number;
}

/** Progreso durante una búsqueda larga: combinaciones evaluadas hasta ahora. */
export type DiscoveryProgress = (evaluated: number) => void;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface DiscoveryResult {
  readonly predicate: Predicate;
  readonly metrics: CohortMetrics;
  /** q-valor de Benjamini-Hochberg sobre TODO el espacio de búsqueda evaluado. */
  readonly qValue: number;
  /** Número de condiciones atómicas en la conjunción. */
  readonly depth: number;
  readonly coverage: number;
  readonly variables: readonly string[];
}

export interface DiscoveryReport {
  readonly results: readonly DiscoveryResult[];
  /** Cuántos resultados cumplían los umbrales antes de recortar a `top`. */
  readonly totalMatches: number;
  /** Total de combinaciones evaluadas (nivel 1 + todas las combinadas). Base del q-valor. */
  readonly searchSpaceSize: number;
  readonly candidateVariables: number;
  /** Candidatos de nivel 1 que superaron la poda de `minTrades`. */
  readonly level1Survivors: number;
  readonly maxConditions: number;
  /** `true` si se alcanzó `maxSearchSpace` y la búsqueda se cortó antes de tiempo. */
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

interface Level1Candidate {
  readonly variable: string;
  readonly predicate: Predicate;
  readonly mask: Uint8Array;
  readonly universeIndex: number;
}

interface Node {
  /** Índices en `level1`, en orden creciente: identifican la combinación de forma única. */
  readonly indices: readonly number[];
  readonly variables: ReadonlySet<string>;
  readonly predicate: Predicate;
  readonly mask: Uint8Array;
  readonly metrics: CohortMetrics;
  readonly universeIndex: number;
}

function passesThresholds(metrics: CohortMetrics, options: DiscoveryOptions): boolean {
  if (!(metrics.count >= options.minTrades)) return false;
  if (options.minWinRate !== undefined && !(metrics.winRate >= options.minWinRate)) return false;
  if (options.minProfitFactor !== undefined && !(metrics.profitFactor >= options.minProfitFactor)) return false;
  if (options.maxDrawdownPct !== undefined && !(metrics.maxDrawdownPct <= options.maxDrawdownPct)) return false;
  return true;
}

export async function discoverPatterns(
  matrix: FeatureMatrix,
  predictors: readonly string[],
  registry: ReadonlyMap<string, VariableDefinition>,
  options: DiscoveryOptions,
  onProgress?: DiscoveryProgress,
): Promise<DiscoveryReport> {
  const start = Date.now();
  const maxConditions = Math.max(1, Math.floor(options.maxConditions ?? 3));
  const quantileCount = options.quantileCount ?? 5;
  const maxCategories = options.maxCategories ?? 24;
  const top = options.top ?? 20;
  const maxSearchSpace = options.maxSearchSpace ?? 2_000_000;
  // Presupuesto de ~250MB de máscaras vivas por nivel (cada una pesa
  // `matrix.size` bytes). Con pocas operaciones esto permite miles de nodos
  // en paralelo sin problema; con cientos de miles, lo limita para no tumbar
  // el proceso por memoria.
  const maxFrontierNodes = options.maxFrontierNodes ?? Math.max(200, Math.floor(250_000_000 / Math.max(1, matrix.size)));
  // Cada cuántas combinaciones evaluadas se cede el hilo (setImmediate) y se
  // reporta progreso. Ni tan seguido que el overhead de ceder domine, ni tan
  // poco que el servidor quede "congelado" varios segundos entre reportes.
  const YIELD_EVERY = 2_000;

  for (const variable of predictors) {
    const definition = registry.get(variable);
    if (definition !== undefined && definition.causality !== "predictor") {
      throw new Error(
        `"${variable}" no es una variable predictora (es "${definition.causality}"); no puede usarse en el descubrimiento de patrones.`,
      );
    }
  }

  // --- Universo del espacio de búsqueda: TODOS los p-valores evaluados -------
  const universePValues: number[] = [];
  let truncated = false;

  // --- Nivel 1: un candidato por cada tramo del análisis marginal ------------
  const level1: Level1Candidate[] = [];
  for (const variable of predictors) {
    const analysis = analyzeVariable(matrix, variable, registry.get(variable) ?? null, {
      minCount: 1,
      quantileCount,
      maxCategories,
    });
    for (const bucket of analysis.buckets) {
      // El tramo "sin valor" describe datos ausentes, no una condición de
      // mercado: no es un candidato útil para una regla de entrada.
      if (bucket.label === "sin valor") continue;

      const universeIndex = universePValues.length;
      universePValues.push(bucket.metrics.pValue);

      // Poda anti-monótona: si el tramo por sí solo ya no llega a minTrades,
      // ninguna conjunción que lo contenga llegará tampoco.
      if (bucket.count < options.minTrades) continue;

      level1.push({
        variable,
        predicate: bucket.predicate,
        mask: compileMask(matrix, bucket.predicate),
        universeIndex,
      });
    }
  }

  // --- Búsqueda por niveles ----------------------------------------------------
  const found: { node: Node; depth: number }[] = [];

  let frontier: Node[] = level1.map((c, i) => ({
    indices: [i],
    variables: new Set([c.variable]),
    predicate: c.predicate,
    mask: c.mask,
    metrics: summarize(selectPnl(matrix, c.mask)),
    universeIndex: c.universeIndex,
  }));

  onProgress?.(universePValues.length);
  await yieldToEventLoop();

  for (let depth = 1; depth <= maxConditions; depth++) {
    for (const node of frontier) {
      if (passesThresholds(node.metrics, options)) found.push({ node, depth });
    }

    if (depth === maxConditions) break;
    if (truncated) break;

    const nextFrontier: Node[] = [];
    outer: for (const nodeA of frontier) {
      const lastIndex = nodeA.indices[nodeA.indices.length - 1] as number;
      for (let k = lastIndex + 1; k < level1.length; k++) {
        const candidateB = level1[k] as Level1Candidate;
        if (nodeA.variables.has(candidateB.variable)) continue;

        if (universePValues.length >= maxSearchSpace) {
          truncated = true;
          break outer;
        }

        // Tope de memoria: si el frontier del siguiente nivel ya acumula
        // demasiadas máscaras vivas, se corta aquí — igual que el tope de
        // espacio de búsqueda, pero protegiendo RAM en vez de tiempo. Es
        // mejor un resultado parcial y marcado como truncado que un proceso
        // que se cae sin avisar.
        if (nextFrontier.length >= maxFrontierNodes) {
          truncated = true;
          break outer;
        }

        const mask = intersect(nodeA.mask, candidateB.mask);
        const count = countMask(mask);
        const metrics = count === 0 ? summarize(new Float64Array(0)) : summarize(selectPnl(matrix, mask));
        const universeIndex = universePValues.length;
        universePValues.push(metrics.pValue);

        if (universePValues.length % YIELD_EVERY === 0) {
          onProgress?.(universePValues.length);
          await yieldToEventLoop();
        }

        // Poda: la cohorte combinada sólo puede ser igual o más pequeña.
        if (count < options.minTrades) continue;

        nextFrontier.push({
          indices: [...nodeA.indices, k],
          variables: new Set([...nodeA.variables, candidateB.variable]),
          predicate: and(nodeA.predicate, candidateB.predicate),
          mask,
          metrics,
          universeIndex,
        });
      }
    }
    frontier = nextFrontier;
    onProgress?.(universePValues.length);
    await yieldToEventLoop();
  }

  // --- Corrección por multiplicidad sobre TODO lo evaluado --------------------
  const qValues = benjaminiHochberg(universePValues);

  const allResults: DiscoveryResult[] = found.map(({ node, depth }) => ({
    predicate: node.predicate,
    metrics: node.metrics,
    qValue: qValues[node.universeIndex] ?? 1,
    depth,
    coverage: matrix.size === 0 ? 0 : node.metrics.count / matrix.size,
    variables: [...node.variables].sort(),
  }));

  allResults.sort((a, b) => {
    if (a.qValue !== b.qValue) return a.qValue - b.qValue;
    const r2a = Number.isFinite(a.metrics.equityR2) ? a.metrics.equityR2 : -1;
    const r2b = Number.isFinite(b.metrics.equityR2) ? b.metrics.equityR2 : -1;
    if (r2a !== r2b) return r2b - r2a;
    return b.metrics.profitFactor - a.metrics.profitFactor;
  });

  return {
    results: allResults.slice(0, top),
    totalMatches: allResults.length,
    searchSpaceSize: universePValues.length,
    candidateVariables: predictors.length,
    level1Survivors: level1.length,
    maxConditions,
    truncated,
    elapsedMs: Date.now() - start,
  };
}
