/** Tipos del sustrato de mercado: instrumentos y velas. */

/**
 * Timeframes soportados. Se guardan como string legible pero el motor trabaja
 * con `timeframeToMinutes` para aritmética.
 */
export const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const TIMEFRAME_MINUTES: Readonly<Record<Timeframe, number>> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
};

export function timeframeToMinutes(tf: Timeframe): number {
  return TIMEFRAME_MINUTES[tf];
}

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * Instrumento negociable.
 *
 * `sessionTimezone` es crítico: todas las variables de calendario (hora, sesión,
 * apertura diaria) se derivan en la zona del mercado, no en UTC ni en la del
 * broker. Para NAS100 es America/New_York.
 */
export interface Instrument {
  readonly id: string;
  /** Símbolo tal como lo exporta MT5, p.ej. "NAS100" o "US100.cash". */
  readonly symbol: string;
  readonly description: string;
  /** IANA timezone del mercado subyacente. */
  readonly sessionTimezone: string;
  /** Tamaño de tick del precio (0.1 para índices CFD típicos). */
  readonly tickSize: number;
  /** Valor monetario de un punto completo de precio por lote. */
  readonly pointValue: number;
  /** Minuto del día (en `sessionTimezone`) en que abre la sesión regular. */
  readonly regularSessionOpenMinute: number;
  /** Minuto del día en que cierra la sesión regular. */
  readonly regularSessionCloseMinute: number;
}

/**
 * Vela OHLCV.
 *
 * `ts` es el timestamp de APERTURA de la vela, en epoch milliseconds UTC.
 * Guardar epoch en vez de strings evita todo el problema de zonas horarias en
 * el almacenamiento y hace que el índice de SQLite sea un entero.
 */
export interface Bar {
  readonly ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Volumen de ticks (MT5 lo llama TICKVOL). */
  readonly tickVolume: number;
  /** Volumen real, normalmente 0 en CFDs. */
  readonly volume: number;
  /** Spread en puntos en el momento de la vela. */
  readonly spread: number;
}

/** Vela con su instrumento y timeframe, tal como se persiste. */
export interface StoredBar extends Bar {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
}

export function barRange(bar: Bar): number {
  return bar.high - bar.low;
}

export function barBody(bar: Bar): number {
  return Math.abs(bar.close - bar.open);
}

export function barUpperWick(bar: Bar): number {
  return bar.high - Math.max(bar.open, bar.close);
}

export function barLowerWick(bar: Bar): number {
  return Math.min(bar.open, bar.close) - bar.low;
}

export function isBullish(bar: Bar): boolean {
  return bar.close > bar.open;
}
