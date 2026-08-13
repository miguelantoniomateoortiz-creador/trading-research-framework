/**
 * REGISTRO DE VARIABLES — el mecanismo que hace la plataforma extensible.
 *
 * Cada número asociado a una operación (venga del núcleo o de un plugin) se
 * describe con un `VariableDefinition`. El registro es la "tabla de contenidos"
 * de la base de datos: permite que el esquema físico sea flexible (blob JSON)
 * sin perder tipado, unidades ni semántica.
 */

/**
 * Causalidad: EL CAMPO MÁS IMPORTANTE DE TODO EL FRAMEWORK.
 *
 * - `predictor`: conocido ANTES de decidir entrar. Sólo estas pueden usarse
 *    para descubrir patrones.
 * - `outcome`: sólo se conoce al cerrar (MAE, MFE, profit, duración). Sirven
 *    para MEDIR, jamás para FILTRAR una hipótesis.
 * - `meta`: identificadores y bookkeeping (id de importación, etc.).
 *
 * Motivo: filtrar por `MAE < 25` produce un win rate del 99% que no se puede
 * operar, porque en el momento de entrar no sabes cuál será el MAE. El motor
 * lanza `LookaheadError` si intentas usar un `outcome` como predictor, salvo
 * que pidas explícitamente modo diagnóstico.
 */
export type VariableCausality = "predictor" | "outcome" | "meta";

/**
 * Tipo de valor. Todo se almacena como `number | null` en la matriz columnar
 * (incluidos booleanos y categóricos), porque eso permite trabajar con
 * `Float64Array` y filtrar millones de filas sin presión de GC.
 */
export type VariableValueType =
  /** Número real continuo (ATR, distancia al VWAP). */
  | "continuous"
  /** Entero discreto con orden (hora, día de la semana como 1..7). */
  | "ordinal"
  /** Entero sin orden natural; el registro aporta `categories`. */
  | "categorical"
  /** 0 o 1. */
  | "boolean";

export interface VariableCategory {
  readonly value: number;
  readonly label: string;
}

export interface VariableDefinition {
  /**
   * Clave canónica, formato `namespace.nombre`, p.ej. `time.minuteOfDay`,
   * `volatility.atr14`, `nas100.openingImpulseDirection`.
   * El namespace evita colisiones entre plugins de terceros.
   */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly valueType: VariableValueType;
  readonly causality: VariableCausality;
  /** Unidad legible: "points", "minutes", "ratio", "percent", "count", "". */
  readonly unit: string;
  /** Id del plugin que la produce; `core` para las del núcleo. */
  readonly producedBy: string;
  /** Versión del plugin cuando se calculó; permite invalidar caches. */
  readonly producerVersion: string;
  /** Categorías, sólo para `categorical`. */
  readonly categories?: readonly VariableCategory[];
  /**
   * Sugerencia de binning para el análisis marginal y el motor de descubrimiento.
   * Si se omite, el motor usa cuantiles.
   */
  readonly binning?: VariableBinning;
  /** Rango esperado; se usa para validar y para ejes de gráficos. */
  readonly range?: { readonly min: number; readonly max: number };
}

export type VariableBinning =
  | { readonly kind: "none" }
  /** Cortes explícitos: [a, b, c] produce (-inf,a], (a,b], (b,c], (c,inf). */
  | { readonly kind: "edges"; readonly edges: readonly number[] }
  /** n cuantiles calculados sobre el dataset de entrenamiento. */
  | { readonly kind: "quantile"; readonly count: number }
  /** Ancho fijo desde `origin`. */
  | { readonly kind: "width"; readonly width: number; readonly origin: number };

/** Vector de variables producido por un plugin para una operación concreta. */
export type FeatureVector = Record<string, number | null>;

export function isPredictor(def: VariableDefinition): boolean {
  return def.causality === "predictor";
}

/** Valida que la clave respete `namespace.nombre`. */
export const VARIABLE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[A-Za-z0-9]*)\.[a-zA-Z][a-zA-Z0-9_]*$/;

export function isValidVariableKey(key: string): boolean {
  return VARIABLE_KEY_PATTERN.test(key);
}
