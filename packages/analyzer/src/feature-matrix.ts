import { countTrades, iterateTradeColumns, type SqliteDatabase, type TradeQuery } from "@trf/database";
import type { RowAccessor } from "./predicate.js";

/**
 * MATRIZ COLUMNAR — el corazón del rendimiento del analizador.
 *
 * Problema: el motor de descubrimiento evalúa decenas de miles de predicados
 * sobre el mismo conjunto de operaciones. Leer la base una vez por predicado
 * es inviable.
 *
 * Solución: se lee la base UNA vez, proyectando SÓLO las columnas necesarias, y
 * se guardan en `Float64Array` (una por variable). A partir de ahí, evaluar un
 * predicado es recorrer arrays de números contiguos: sin objetos, sin
 * indirecciones, sin presión de recolector de basura.
 *
 * Coste de memoria: 8 bytes por valor. 1 millón de operaciones × 30 variables
 * = 240 MB. Por eso `variables` es explícito: se cargan las que se van a usar,
 * no todas. Eso es lo que significa "no cargar toda la base en memoria": se
 * carga una proyección acotada, elegida por el analista.
 *
 * Los nulos se guardan en un `Uint8Array` aparte en vez de usar NaN, porque
 * NaN se propaga en silencio por las comparaciones y acaba contando como
 * "condición falsa" sin que nadie se entere de cuántas filas se perdieron.
 */

export interface FeatureMatrix {
  /** Número de operaciones cargadas. */
  readonly size: number;
  readonly variables: readonly string[];
  /** P&L monetario por operación, en orden cronológico. */
  readonly pnl: Float64Array;
  readonly entryTs: Float64Array;
  readonly tradeIds: readonly string[];

  column(variable: string): Float64Array;
  nullMask(variable: string): Uint8Array;
  /** `true` si el valor es nulo (ausente o no calculado). */
  isNull(variable: string, index: number): boolean;
  /** Accesor de fila para `evaluate()` del módulo de predicados. */
  rowAccessor(index: number): RowAccessor;
  /** Cuántos nulos tiene cada variable: diagnóstico de cobertura de datos. */
  nullCounts(): Map<string, number>;
}

export interface LoadMatrixOptions {
  /** Variables a proyectar. Las claves con punto salen del blob JSON. */
  readonly variables: readonly string[];
  readonly query?: TradeQuery;
}

const PNL_COLUMN = "pnlMoney";
const TS_COLUMN = "entryTs";
const ID_COLUMN = "id";

export function loadFeatureMatrix(db: SqliteDatabase, options: LoadMatrixOptions): FeatureMatrix {
  const query = options.query ?? {};
  const size = countTrades(db, query);

  // Se piden siempre P&L, timestamp e id, además de las variables solicitadas.
  const requested = [...new Set(options.variables)].filter(
    (v) => v !== PNL_COLUMN && v !== TS_COLUMN && v !== ID_COLUMN,
  );
  const columns = [ID_COLUMN, TS_COLUMN, PNL_COLUMN, ...requested];

  const data = new Map<string, Float64Array>();
  const nulls = new Map<string, Uint8Array>();
  for (const variable of requested) {
    data.set(variable, new Float64Array(size));
    nulls.set(variable, new Uint8Array(size));
  }

  const pnl = new Float64Array(size);
  const entryTs = new Float64Array(size);
  const tradeIds = new Array<string>(size);

  let index = 0;
  for (const row of iterateTradeColumns(db, columns, query)) {
    if (index >= size) break; // la base cambió entre el COUNT y el SELECT
    tradeIds[index] = String(row[ID_COLUMN] ?? "");
    entryTs[index] = Number(row[TS_COLUMN] ?? 0);
    pnl[index] = Number(row[PNL_COLUMN] ?? 0);

    for (const variable of requested) {
      const value = row[variable];
      if (value === null || value === undefined || value === "") {
        (nulls.get(variable) as Uint8Array)[index] = 1;
      } else {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          (data.get(variable) as Float64Array)[index] = numeric;
        } else {
          (nulls.get(variable) as Uint8Array)[index] = 1;
        }
      }
    }
    index++;
  }

  const actualSize = index;
  return createMatrix({ size: actualSize, variables: requested, data, nulls, pnl, entryTs, tradeIds });
}

interface MatrixParts {
  size: number;
  variables: string[];
  data: Map<string, Float64Array>;
  nulls: Map<string, Uint8Array>;
  pnl: Float64Array;
  entryTs: Float64Array;
  tradeIds: string[];
}

function createMatrix(parts: MatrixParts): FeatureMatrix {
  const empty = new Float64Array(0);
  const emptyMask = new Uint8Array(0);

  return {
    size: parts.size,
    variables: parts.variables,
    pnl: parts.pnl,
    entryTs: parts.entryTs,
    tradeIds: parts.tradeIds,

    column(variable: string): Float64Array {
      return parts.data.get(variable) ?? empty;
    },
    nullMask(variable: string): Uint8Array {
      return parts.nulls.get(variable) ?? emptyMask;
    },
    isNull(variable: string, index: number): boolean {
      const mask = parts.nulls.get(variable);
      return mask === undefined ? true : mask[index] === 1;
    },
    rowAccessor(index: number): RowAccessor {
      return (variable: string): number | null => {
        const mask = parts.nulls.get(variable);
        if (mask === undefined || mask[index] === 1) return null;
        return (parts.data.get(variable) as Float64Array)[index] ?? null;
      };
    },
    nullCounts(): Map<string, number> {
      const counts = new Map<string, number>();
      for (const variable of parts.variables) {
        const mask = parts.nulls.get(variable) as Uint8Array;
        let count = 0;
        for (let i = 0; i < parts.size; i++) count += mask[i] as number;
        counts.set(variable, count);
      }
      return counts;
    },
  };
}

/** Construye una matriz en memoria. Para tests y para datos ya cargados. */
export function matrixFromRows(
  rows: readonly { id?: string; entryTs: number; pnl: number; features: Record<string, number | null> }[],
  variables: readonly string[],
): FeatureMatrix {
  const size = rows.length;
  const data = new Map<string, Float64Array>();
  const nulls = new Map<string, Uint8Array>();
  for (const variable of variables) {
    data.set(variable, new Float64Array(size));
    nulls.set(variable, new Uint8Array(size));
  }
  const pnl = new Float64Array(size);
  const entryTs = new Float64Array(size);
  const tradeIds = new Array<string>(size);

  rows.forEach((row, i) => {
    pnl[i] = row.pnl;
    entryTs[i] = row.entryTs;
    tradeIds[i] = row.id ?? `row-${i}`;
    for (const variable of variables) {
      const value = row.features[variable];
      if (value === null || value === undefined || !Number.isFinite(value)) {
        (nulls.get(variable) as Uint8Array)[i] = 1;
      } else {
        (data.get(variable) as Float64Array)[i] = value;
      }
    }
  });

  return createMatrix({ size, variables: [...variables], data, nulls, pnl, entryTs, tradeIds });
}
