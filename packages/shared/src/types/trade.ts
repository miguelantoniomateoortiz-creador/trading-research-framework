/**
 * La OPERACIÓN es la unidad de análisis del framework.
 *
 * Nota de diseño importante: una `Trade` aquí no es necesariamente una operación
 * que ejecutaste en el broker. Es una OBSERVACIÓN: "en este instante, bajo esta
 * regla de entrada, esto es lo que habría pasado". Las operaciones reales
 * importadas desde MT5 son un caso particular (`source: "broker"`).
 *
 * Esto es lo que permite descubrir patrones que nunca operaste, que es el punto
 * de un laboratorio de investigación.
 */

export type Direction = "long" | "short";

export type TradeSource =
  /** Generada por un plugin de entrada sobre datos históricos. */
  | "simulated"
  /** Importada del historial real de MT5. */
  | "broker"
  /** Inyectada manualmente (tests, casos de estudio). */
  | "manual";

export type ExitReason = "take_profit" | "stop_loss" | "time_limit" | "signal" | "session_end" | "unknown";

/**
 * Campos "calientes": se consultan en casi todo análisis, así que viven en
 * columnas nativas de SQLite con índices, no dentro del blob JSON de features.
 */
export interface TradeCore {
  readonly id: string;
  readonly instrumentId: string;
  readonly source: TradeSource;
  /** Regla de entrada que generó la operación (id del plugin de entrada). */
  readonly entryRuleId: string;
  readonly direction: Direction;

  /** Epoch ms UTC de la entrada. */
  readonly entryTs: number;
  /** Epoch ms UTC de la salida. */
  readonly exitTs: number;

  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly takeProfitPrice: number | null;
  readonly stopLossPrice: number | null;

  /** Resultado en puntos de precio, con signo, ya ajustado por dirección. */
  readonly pnlPoints: number;
  /** Resultado monetario (usa `Instrument.pointValue` y el tamaño). */
  readonly pnlMoney: number;
  readonly volumeLots: number;
  readonly exitReason: ExitReason;
  /** Duración en minutos. */
  readonly durationMinutes: number;
}

/**
 * Métricas de recorrido. TODAS son variables de RESULTADO: sólo se conocen
 * después de cerrar. El motor de descubrimiento las bloquea como predictores.
 */
export interface TradeExcursion {
  /** Maximum Adverse Excursion, en puntos, siempre >= 0. */
  readonly mae: number;
  /** Maximum Favourable Excursion, en puntos, siempre >= 0. */
  readonly mfe: number;
  /** Minutos desde la entrada hasta tocar el MAE. */
  readonly minutesToMae: number;
  /** Minutos desde la entrada hasta tocar el MFE. */
  readonly minutesToMfe: number;
  /** Máxima velocidad favorable observada, en puntos por minuto. */
  readonly maxSpeedPointsPerMin: number;
  /** Pendiente de la regresión lineal del precio durante la operación. */
  readonly slopePointsPerMin: number;
  /** Número de retrocesos significativos (ver `analyzer/excursion.ts`). */
  readonly pullbackCount: number;
  /** Eficiencia: pnl / mfe. Cuánto del movimiento favorable se capturó. */
  readonly efficiency: number;
}

/**
 * Operación completa tal como la ve el analizador.
 * `features` contiene todas las variables aportadas por plugins.
 */
export interface Trade extends TradeCore {
  readonly excursion: TradeExcursion;
  readonly features: Readonly<Record<string, number | null>>;
}

export function isWin(trade: Pick<TradeCore, "pnlMoney">): boolean {
  return trade.pnlMoney > 0;
}

/** Signo direccional: +1 para long, -1 para short. Útil para aritmética. */
export function directionSign(direction: Direction): 1 | -1 {
  return direction === "long" ? 1 : -1;
}

/** Calcula el P&L en puntos respetando la dirección. */
export function computePnlPoints(direction: Direction, entryPrice: number, exitPrice: number): number {
  return (exitPrice - entryPrice) * directionSign(direction);
}
