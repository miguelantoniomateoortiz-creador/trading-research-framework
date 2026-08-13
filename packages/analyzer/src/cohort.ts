import { summarize, type CohortMetrics } from "@trf/shared";
import type { FeatureMatrix } from "./feature-matrix.js";
import type { Predicate } from "./predicate.js";

/**
 * EVALUACIÓN DE COHORTES.
 *
 * Un predicado se compila a una MÁSCARA DE BITS (`Uint8Array`) sobre las filas
 * de la matriz. La compilación es vectorizada: cada nodo del árbol recorre una
 * columna entera de una vez, en lugar de evaluar el árbol fila a fila.
 *
 * Diferencia práctica con 1M de operaciones y un predicado de 3 condiciones:
 * evaluación por filas ≈ 3M llamadas a función; por columnas, 3 bucles sobre
 * arrays contiguos. Un orden de magnitud.
 *
 * La máscara además se reutiliza: el motor de descubrimiento intersecta
 * máscaras ya calculadas en vez de reevaluar los predicados hijos.
 */

export interface CohortResult {
  readonly metrics: CohortMetrics;
  /** 1 = la fila cumple el predicado. */
  readonly mask: Uint8Array;
  /** P&L de las filas seleccionadas, en orden cronológico. */
  readonly pnl: Float64Array;
  /** Fracción de la población total que cubre la cohorte. */
  readonly coverage: number;
}

/** Compila un predicado a máscara de filas. */
export function compileMask(matrix: FeatureMatrix, predicate: Predicate): Uint8Array {
  const n = matrix.size;

  switch (predicate.type) {
    case "always": {
      const mask = new Uint8Array(n);
      mask.fill(1);
      return mask;
    }

    case "compare": {
      const mask = new Uint8Array(n);
      const values = matrix.column(predicate.variable);
      const nulls = matrix.nullMask(predicate.variable);
      const target = predicate.value;

      // El switch está FUERA del bucle a propósito: dentro impediría que el
      // motor de JavaScript especialice el bucle.
      switch (predicate.op) {
        case ">":
          for (let i = 0; i < n; i++) if (nulls[i] === 0 && (values[i] as number) > target) mask[i] = 1;
          break;
        case ">=":
          for (let i = 0; i < n; i++) if (nulls[i] === 0 && (values[i] as number) >= target) mask[i] = 1;
          break;
        case "<":
          for (let i = 0; i < n; i++) if (nulls[i] === 0 && (values[i] as number) < target) mask[i] = 1;
          break;
        case "<=":
          for (let i = 0; i < n; i++) if (nulls[i] === 0 && (values[i] as number) <= target) mask[i] = 1;
          break;
        case "==":
          for (let i = 0; i < n; i++) if (nulls[i] === 0 && (values[i] as number) === target) mask[i] = 1;
          break;
        case "!=":
          for (let i = 0; i < n; i++) if (nulls[i] === 0 && (values[i] as number) !== target) mask[i] = 1;
          break;
        default:
          break;
      }
      return mask;
    }

    case "between": {
      const mask = new Uint8Array(n);
      const values = matrix.column(predicate.variable);
      const nulls = matrix.nullMask(predicate.variable);
      const inclusive = predicate.inclusiveMax === true;
      for (let i = 0; i < n; i++) {
        if (nulls[i] === 1) continue;
        const value = values[i] as number;
        if (value >= predicate.min && (inclusive ? value <= predicate.max : value < predicate.max)) mask[i] = 1;
      }
      return mask;
    }

    case "in": {
      const mask = new Uint8Array(n);
      const values = matrix.column(predicate.variable);
      const nulls = matrix.nullMask(predicate.variable);
      const allowed = new Set(predicate.values);
      for (let i = 0; i < n; i++) {
        if (nulls[i] === 0 && allowed.has(values[i] as number)) mask[i] = 1;
      }
      return mask;
    }

    case "isNull": {
      const mask = new Uint8Array(n);
      const nulls = matrix.nullMask(predicate.variable);
      for (let i = 0; i < n; i++) if (nulls[i] === 1) mask[i] = 1;
      return mask;
    }

    case "and": {
      let mask: Uint8Array | null = null;
      for (const operand of predicate.operands) {
        const next = compileMask(matrix, operand);
        if (mask === null) {
          mask = next;
        } else {
          for (let i = 0; i < n; i++) mask[i] = (mask[i] as number) & (next[i] as number);
        }
      }
      if (mask === null) {
        mask = new Uint8Array(n);
        mask.fill(1);
      }
      return mask;
    }

    case "or": {
      const mask = new Uint8Array(n);
      for (const operand of predicate.operands) {
        const next = compileMask(matrix, operand);
        for (let i = 0; i < n; i++) mask[i] = (mask[i] as number) | (next[i] as number);
      }
      return mask;
    }

    case "not": {
      const inner = compileMask(matrix, predicate.operand);
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = inner[i] === 1 ? 0 : 1;
      return mask;
    }

    default:
      return new Uint8Array(n);
  }
}

export function countMask(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i] as number;
  return count;
}

/** Extrae los P&L de las filas marcadas, conservando el orden cronológico. */
export function selectPnl(matrix: FeatureMatrix, mask: Uint8Array): Float64Array {
  const count = countMask(mask);
  const out = new Float64Array(count);
  let index = 0;
  for (let i = 0; i < matrix.size; i++) {
    if (mask[i] === 1) out[index++] = matrix.pnl[i] as number;
  }
  return out;
}

/** Evalúa un predicado y devuelve las métricas de la cohorte resultante. */
export function evaluateCohort(matrix: FeatureMatrix, predicate: Predicate): CohortResult {
  const mask = compileMask(matrix, predicate);
  const pnl = selectPnl(matrix, mask);
  return {
    metrics: summarize(pnl),
    mask,
    pnl,
    coverage: matrix.size === 0 ? 0 : pnl.length / matrix.size,
  };
}

/** Métricas del complemento: qué pasa con las operaciones que NO cumplen. */
export function evaluateComplement(matrix: FeatureMatrix, mask: Uint8Array): CohortMetrics {
  const inverse = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inverse[i] = mask[i] === 1 ? 0 : 1;
  return summarize(selectPnl(matrix, inverse));
}

/** Intersección de dos máscaras ya calculadas. */
export function intersect(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) & (b[i] as number);
  return out;
}

/**
 * Divide una cohorte por la mitad temporal.
 *
 * Es la prueba de estabilidad más barata que existe: si un patrón funciona en
 * la primera mitad del periodo de entrenamiento y desaparece en la segunda,
 * no hace falta gastar el dataset de validación para descartarlo.
 */
export interface StabilitySplit {
  readonly first: CohortMetrics;
  readonly second: CohortMetrics;
  /** Diferencia de win rate entre mitades. Cerca de 0 = estable. */
  readonly winRateDelta: number;
  /** Diferencia relativa de expectancy. */
  readonly expectancyRatio: number;
}

export function splitStability(matrix: FeatureMatrix, mask: Uint8Array): StabilitySplit {
  const pnl = selectPnl(matrix, mask);
  const half = Math.floor(pnl.length / 2);
  const first = summarize(pnl.subarray(0, half));
  const second = summarize(pnl.subarray(half));
  return {
    first,
    second,
    winRateDelta: second.winRate - first.winRate,
    expectancyRatio: first.expectancy === 0 ? Number.NaN : second.expectancy / first.expectancy,
  };
}
