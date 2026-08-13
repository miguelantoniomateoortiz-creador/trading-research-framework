/**
 * DATASETS — separación estricta entre entrenamiento y validación.
 *
 * La regla del laboratorio: el dataset de validación se toca UNA VEZ por
 * hipótesis. Por eso el modelo guarda `validationUses`: si una hipótesis se
 * valida diez veces contra 2025, 2025 ya no es fuera de muestra.
 */

export type DatasetRole = "training" | "validation" | "holdout";

export interface DatasetSplit {
  readonly id: string;
  readonly name: string;
  readonly role: DatasetRole;
  readonly instrumentId: string;
  /** Epoch ms UTC, inclusivo. */
  readonly startTs: number;
  /** Epoch ms UTC, exclusivo. */
  readonly endTs: number;
  /**
   * Días de "embargo" tras `endTs` del training antes de que empiece la
   * validación. Evita fuga por operaciones solapadas o indicadores con memoria
   * larga (una EMA200 en M1 arrastra ~3 días de información).
   */
  readonly embargoDays: number;
  readonly description: string;
  /** Cuántas veces se ha evaluado algo contra este split. */
  readonly evaluationCount: number;
}

export function splitContains(split: Pick<DatasetSplit, "startTs" | "endTs">, ts: number): boolean {
  return ts >= split.startTs && ts < split.endTs;
}

/** Comprueba que dos splits no se solapan (incluyendo el embargo). */
export function splitsOverlap(
  training: Pick<DatasetSplit, "startTs" | "endTs" | "embargoDays">,
  validation: Pick<DatasetSplit, "startTs" | "endTs">,
): boolean {
  const embargoMs = training.embargoDays * 24 * 60 * 60 * 1000;
  const trainingEndWithEmbargo = training.endTs + embargoMs;
  return validation.startTs < trainingEndWithEmbargo && training.startTs < validation.endTs;
}
