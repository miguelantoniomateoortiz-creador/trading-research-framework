import {
  benjaminiHochberg,
  pearson,
  quantile,
  summarize,
  type CohortMetrics,
  type VariableBinning,
  type VariableDefinition,
} from "@trf/shared";
import type { FeatureMatrix } from "./feature-matrix.js";
import { between, eq, isNull, type Predicate } from "./predicate.js";

/**
 * ANÁLISIS MARGINAL — "¿qué hace cada variable por su cuenta?".
 *
 * Divide la población en tramos según una variable y mide cada tramo. Es el
 * paso previo obligatorio al motor de descubrimiento: antes de combinar
 * variables conviene saber cuáles tienen señal por sí solas y con qué forma
 * (monótona, en U, un solo tramo bueno...).
 *
 * También produce los CORTES que el motor de descubrimiento usará como
 * candidatos. Cortes derivados de los datos (cuantiles) en vez de números
 * redondos elegidos a mano: "ATR > 18" es un umbral arbitrario; "ATR en el
 * quintil superior" es una pregunta con sentido estadístico.
 *
 * AVISO METODOLÓGICO: este módulo mira el dataset de ENTRENAMIENTO. Los cortes
 * que salen de aquí ya han visto los datos, así que forman parte del espacio de
 * búsqueda y hay que contarlos al corregir por multiplicidad.
 */

export interface Bucket {
  readonly label: string;
  readonly predicate: Predicate;
  readonly metrics: CohortMetrics;
  readonly count: number;
  readonly coverage: number;
  /** Diferencia de expectancy respecto a la población completa. */
  readonly lift: number;
}

export interface MarginalAnalysis {
  readonly variable: string;
  readonly definition: VariableDefinition | null;
  readonly baseline: CohortMetrics;
  readonly buckets: readonly Bucket[];
  /** Tramo con mayor expectancy entre los que superan `minCount`. */
  readonly bestBucket: Bucket | null;
  /** Correlación de Pearson entre la variable y el P&L. */
  readonly correlation: number;
  /** Cuántas filas tienen la variable sin valor. */
  readonly nullCount: number;
  /** p-valor del mejor tramo, sin corregir. */
  readonly bestPValue: number;
}

export interface MarginalOptions {
  /** Tramos con menos operaciones se ignoran para elegir el mejor. */
  readonly minCount?: number;
  /** Número de cuantiles cuando la variable no declara binning. */
  readonly quantileCount?: number;
  /** Máximo de categorías distintas antes de tratar la variable como continua. */
  readonly maxCategories?: number;
}

/** Cortes efectivos de una variable, calculados sobre los datos presentes. */
export function computeEdges(
  matrix: FeatureMatrix,
  variable: string,
  binning: VariableBinning | undefined,
  quantileCount: number,
): number[] {
  const values = presentValues(matrix, variable);
  if (values.length === 0) return [];

  const spec: VariableBinning = binning ?? { kind: "quantile", count: quantileCount };

  switch (spec.kind) {
    case "none":
      return [];
    case "edges":
      return [...spec.edges];
    case "width": {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < values.length; i++) {
        const v = values[i] as number;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const edges: number[] = [];
      // Límite de seguridad: una anchura mal elegida podría generar millones
      // de tramos y bloquear el proceso.
      for (let x = spec.origin; x <= max && edges.length < 500; x += spec.width) {
        if (x > min) edges.push(x);
      }
      return edges;
    }
    case "quantile": {
      const edges: number[] = [];
      for (let i = 1; i < spec.count; i++) {
        const value = quantile(values, i / spec.count);
        // Cortes repetidos aparecen cuando la variable tiene muchos valores
        // iguales; duplicarlos crearía tramos vacíos.
        if (edges.length === 0 || value > (edges[edges.length - 1] as number)) edges.push(value);
      }
      return edges;
    }
    default:
      return [];
  }
}

function presentValues(matrix: FeatureMatrix, variable: string): Float64Array {
  const column = matrix.column(variable);
  const nulls = matrix.nullMask(variable);
  let count = 0;
  for (let i = 0; i < matrix.size; i++) if (nulls[i] === 0) count++;
  const out = new Float64Array(count);
  let index = 0;
  for (let i = 0; i < matrix.size; i++) if (nulls[i] === 0) out[index++] = column[i] as number;
  return out;
}

/** Valores distintos, hasta `limit`. `null` si hay más de `limit`. */
function distinctValues(matrix: FeatureMatrix, variable: string, limit: number): number[] | null {
  const column = matrix.column(variable);
  const nulls = matrix.nullMask(variable);
  const set = new Set<number>();
  for (let i = 0; i < matrix.size; i++) {
    if (nulls[i] === 1) continue;
    set.add(column[i] as number);
    if (set.size > limit) return null;
  }
  return [...set].sort((a, b) => a - b);
}

export function analyzeVariable(
  matrix: FeatureMatrix,
  variable: string,
  definition: VariableDefinition | null = null,
  options: MarginalOptions = {},
): MarginalAnalysis {
  const minCount = options.minCount ?? 30;
  const quantileCount = options.quantileCount ?? 5;
  const maxCategories = options.maxCategories ?? 24;

  const baseline = summarize(matrix.pnl);
  const column = matrix.column(variable);
  const nulls = matrix.nullMask(variable);

  let nullCount = 0;
  for (let i = 0; i < matrix.size; i++) nullCount += nulls[i] as number;

  const buckets: Bucket[] = [];

  const treatAsCategorical =
    definition?.valueType === "categorical" ||
    definition?.valueType === "boolean" ||
    (definition === null && distinctValues(matrix, variable, maxCategories) !== null);

  const categories = treatAsCategorical ? distinctValues(matrix, variable, maxCategories) : null;

  if (categories !== null) {
    for (const value of categories) {
      const indices: number[] = [];
      for (let i = 0; i < matrix.size; i++) {
        if (nulls[i] === 0 && (column[i] as number) === value) indices.push(i);
      }
      buckets.push(makeBucket(matrix, indices, labelFor(definition, value), eq(variable, value), baseline));
    }
  } else {
    const edges = computeEdges(matrix, variable, definition?.binning, quantileCount);
    const bounds = [Number.NEGATIVE_INFINITY, ...edges, Number.POSITIVE_INFINITY];
    for (let b = 0; b < bounds.length - 1; b++) {
      const min = bounds[b] as number;
      const max = bounds[b + 1] as number;
      const indices: number[] = [];
      for (let i = 0; i < matrix.size; i++) {
        if (nulls[i] === 1) continue;
        const value = column[i] as number;
        if (value >= min && value < max) indices.push(i);
      }
      buckets.push(
        makeBucket(matrix, indices, formatRange(min, max), between(variable, min, max), baseline),
      );
    }
  }

  if (nullCount > 0) {
    const indices: number[] = [];
    for (let i = 0; i < matrix.size; i++) if (nulls[i] === 1) indices.push(i);
    buckets.push(makeBucket(matrix, indices, "sin valor", isNull(variable), baseline));
  }

  const eligible = buckets.filter((b) => b.count >= minCount && b.label !== "sin valor");
  const bestBucket =
    eligible.length === 0
      ? null
      : eligible.reduce((best, current) => (current.metrics.expectancy > best.metrics.expectancy ? current : best));

  return {
    variable,
    definition,
    baseline,
    buckets,
    bestBucket,
    correlation: correlationWithPnl(matrix, variable),
    nullCount,
    bestPValue: bestBucket?.metrics.pValue ?? 1,
  };
}

function makeBucket(
  matrix: FeatureMatrix,
  indices: readonly number[],
  label: string,
  predicate: Predicate,
  baseline: CohortMetrics,
): Bucket {
  const pnl = new Float64Array(indices.length);
  for (let i = 0; i < indices.length; i++) pnl[i] = matrix.pnl[indices[i] as number] as number;
  const metrics = summarize(pnl);
  return {
    label,
    predicate,
    metrics,
    count: indices.length,
    coverage: matrix.size === 0 ? 0 : indices.length / matrix.size,
    lift: Number.isFinite(metrics.expectancy) ? metrics.expectancy - baseline.expectancy : Number.NaN,
  };
}

function labelFor(definition: VariableDefinition | null, value: number): string {
  const category = definition?.categories?.find((c) => c.value === value);
  return category?.label ?? String(value);
}

function formatRange(min: number, max: number): string {
  const lo = Number.isFinite(min) ? trim(min) : "-∞";
  const hi = Number.isFinite(max) ? trim(max) : "+∞";
  return `[${lo}, ${hi})`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function correlationWithPnl(matrix: FeatureMatrix, variable: string): number {
  const column = matrix.column(variable);
  const nulls = matrix.nullMask(variable);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < matrix.size; i++) {
    if (nulls[i] === 1) continue;
    xs.push(column[i] as number);
    ys.push(matrix.pnl[i] as number);
  }
  return pearson(xs, ys);
}

/**
 * Analiza varias variables y las ordena por señal.
 *
 * Los p-valores se corrigen con Benjamini-Hochberg sobre el conjunto de
 * variables examinadas: si miras 40 variables, alguna parecerá significativa
 * por puro azar.
 */
export interface RankedMarginal extends MarginalAnalysis {
  readonly qValue: number;
}

export function analyzeAll(
  matrix: FeatureMatrix,
  variables: readonly string[],
  registry: ReadonlyMap<string, VariableDefinition>,
  options: MarginalOptions = {},
): RankedMarginal[] {
  const analyses = variables.map((variable) =>
    analyzeVariable(matrix, variable, registry.get(variable) ?? null, options),
  );
  const qValues = benjaminiHochberg(analyses.map((a) => a.bestPValue));
  const liftOf = (analysis: MarginalAnalysis): number => {
    const lift = analysis.bestBucket?.lift;
    return lift === undefined || !Number.isFinite(lift) ? Number.NEGATIVE_INFINITY : lift;
  };

  return analyses
    .map((analysis, i) => ({ ...analysis, qValue: qValues[i] ?? 1 }))
    .sort((a, b) => a.qValue - b.qValue || liftOf(b) - liftOf(a));
}
