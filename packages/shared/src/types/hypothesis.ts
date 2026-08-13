import type { CohortMetrics } from "../math/metrics.js";

/**
 * HIPÓTESIS — nivel 7.
 *
 * Una hipótesis es un predicado que ya pasó por el entrenamiento (nivel 6,
 * `discover` o `analyze:cohort` a mano) y se guarda para validarlo formalmente
 * contra un split que todavía no se ha mirado. El ciclo de vida es lineal a
 * propósito:
 *
 *   draft -> training_passed -> validated | rejected
 *
 * Una vez `validated` o `rejected`, la hipótesis queda fija: no se puede
 * revalidar (eso convertiría la validación en un segundo entrenamiento
 * disfrazado). Si se quiere reintentar con más datos o una definición
 * distinta, se crea una hipótesis NUEVA.
 */
export type HypothesisStatus = "draft" | "training_passed" | "validated" | "rejected" | "retired";

export interface Hypothesis {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** AST del predicado, serializado (`@trf/analyzer` `serializePredicate`/`parsePredicate`). */
  readonly predicateJson: string;
  readonly variables: readonly string[];
  /** Umbrales que se le exigieron al descubrirla (minTrades, minWinRate...). */
  readonly criteria: Readonly<Record<string, unknown>>;
  /** Métricas obtenidas en el split de ENTRENAMIENTO. `null` si aún no se ha evaluado. */
  readonly trainingMetrics: CohortMetrics | null;
  /**
   * Cuántas combinaciones se probaron en la búsqueda que la produjo (o 1 si
   * se guardó una hipótesis escrita a mano, sin búsqueda de por medio). Sin
   * este número el p-valor de entrenamiento no se puede corregir por
   * multiplicidad.
   */
  readonly searchSpaceSize: number;
  readonly status: HypothesisStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Un registro INMUTABLE de haber evaluado una hipótesis contra un split.
 * Se escribe pase lo que pase, incluso si la hipótesis se rechaza: es el
 * cuaderno de laboratorio, no un caché que se pueda reescribir.
 */
export interface ValidationRun {
  readonly id: string;
  readonly hypothesisId: string;
  readonly splitId: string;
  readonly metrics: CohortMetrics;
  readonly pValue: number | null;
  readonly qValue: number | null;
  readonly passed: boolean;
  readonly notes: string;
  readonly ranAt: string;
}
