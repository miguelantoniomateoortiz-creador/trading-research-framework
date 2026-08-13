import { calendarParts, timeframeToMinutes, type Bar, type Timeframe } from "@trf/shared";

/**
 * AGREGACIÓN DE TIMEFRAMES.
 *
 * Sólo se almacena M1. Los timeframes superiores se construyen al vuelo a
 * partir de él.
 *
 * Por qué: guardar M1 + M5 + M15 + H1 multiplica el espacio por ~1,3 y, sobre
 * todo, crea cuatro copias de la verdad que pueden desincronizarse si una
 * importación falla a medias. Agregar en memoria cuesta una suma por vela y
 * garantiza coherencia por construcción.
 *
 * Una vela agregada se emite SÓLO cuando ha cerrado del todo. Si el histórico
 * tiene un hueco (fin de semana, festivo), la vela en curso se cierra con lo
 * que haya en vez de mezclar dos periodos distintos.
 */
export class TimeframeAggregator {
  private readonly timeframe: Timeframe;
  private readonly bucketMs: number;
  private readonly timeZone: string;
  private currentBucket: number | null = null;
  private current: { ts: number; open: number; high: number; low: number; close: number; tickVolume: number; volume: number; spread: number } | null =
    null;

  constructor(timeframe: Timeframe, timeZone: string) {
    this.timeframe = timeframe;
    this.bucketMs = timeframeToMinutes(timeframe) * 60_000;
    this.timeZone = timeZone;
  }

  /**
   * Añade una vela M1. Devuelve la vela agregada que acaba de CERRAR, si la hay.
   */
  push(bar: Bar): Bar | null {
    const bucket = this.bucketOf(bar.ts);
    let closed: Bar | null = null;

    if (this.currentBucket !== null && bucket !== this.currentBucket && this.current !== null) {
      closed = { ...this.current };
    }

    if (this.currentBucket === null || bucket !== this.currentBucket) {
      this.currentBucket = bucket;
      this.current = {
        ts: this.bucketStart(bar.ts, bucket),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        tickVolume: bar.tickVolume,
        volume: bar.volume,
        spread: bar.spread,
      };
      return closed;
    }

    const current = this.current as NonNullable<typeof this.current>;
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    current.tickVolume += bar.tickVolume;
    current.volume += bar.volume;
    current.spread = bar.spread;
    return closed;
  }

  /** Cierra la vela en curso al final del histórico. */
  flush(): Bar | null {
    const closed = this.current === null ? null : { ...this.current };
    this.current = null;
    this.currentBucket = null;
    return closed;
  }

  private bucketOf(ts: number): number {
    if (this.timeframe === "D1") {
      const parts = calendarParts(ts, this.timeZone);
      return Number(parts.sessionDate.replace(/-/g, ""));
    }
    return Math.floor(ts / this.bucketMs);
  }

  private bucketStart(ts: number, bucket: number): number {
    return this.timeframe === "D1" ? ts : bucket * this.bucketMs;
  }
}
