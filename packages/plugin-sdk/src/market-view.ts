import {
  LookaheadError,
  calendarParts,
  timeframeToMinutes,
  type Bar,
  type CalendarParts,
  type Instrument,
  type Timeframe,
} from "@trf/shared";

/**
 * VISTA DE MERCADO SELLADA — la garantía anti-lookahead del framework.
 *
 * Un plugin NUNCA recibe el array completo de velas. Recibe una `MarketView`
 * anclada a un instante `now` que, por construcción, sólo puede devolver velas
 * YA CERRADAS en ese instante.
 *
 * Por qué es tan importante: el error más caro en investigación cuantitativa
 * no es un bug que rompe, es un bug que MEJORA los resultados. Si un indicador
 * usa por accidente el cierre de la vela en la que entras, el backtest sale
 * espectacular y en real pierde. Con esta vista, ese error es imposible de
 * escribir: la API no expone el dato.
 */

/** Estadísticas agregadas de un día de mercado. */
export interface DailyStats {
  readonly sessionDate: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly barCount: number;
}

/** Lectura de una serie de velas de un timeframe concreto. */
export interface SeriesReader {
  readonly timeframe: Timeframe;
  /** Número de velas cerradas disponibles. */
  readonly length: number;
  /** `offset` 0 = última vela cerrada, 1 = la anterior… `null` si no existe. */
  at(offset: number): Bar | null;
  /** Últimas `count` velas en orden cronológico (la más reciente al final). */
  last(count: number): readonly Bar[];
  /** Cierres de las últimas `count` velas, listos para indicadores. */
  closes(count: number): Float64Array;
  highs(count: number): Float64Array;
  lows(count: number): Float64Array;
}

export interface MarketView {
  /** Instante de decisión, epoch ms UTC. Nada posterior es accesible. */
  readonly now: number;
  readonly instrument: Instrument;
  /** Partes de calendario de `now`, en la zona horaria del mercado. */
  readonly calendar: CalendarParts;

  /** Serie del timeframe primario (normalmente M1). */
  readonly primary: SeriesReader;
  /** Serie de otro timeframe declarado en `requires.timeframes`. */
  series(timeframe: Timeframe): SeriesReader;

  /** Último precio conocido = cierre de la última vela cerrada. */
  price(): number;

  /** Apertura del día de mercado actual, o `null` si aún no hay velas hoy. */
  dailyOpen(): number | null;
  /** Agregado del día actual hasta `now` (nunca incluye el resto del día). */
  today(): DailyStats | null;
  /** Agregado del día de mercado anterior, ya cerrado. */
  previousDay(): DailyStats | null;
}

// ---------------------------------------------------------------------------
// Buffer circular
// ---------------------------------------------------------------------------

/**
 * Ring buffer de velas cerradas.
 *
 * Capacidad fija = memoria constante sin importar cuántos años se procesen.
 * Se dimensiona como el máximo `warmupBars` que pida cualquier plugin activo,
 * más un margen.
 */
export class SeriesBuffer implements SeriesReader {
  readonly timeframe: Timeframe;
  private readonly capacity: number;
  private readonly buffer: Bar[];
  private count = 0;
  /** Índice donde se escribirá la próxima vela. */
  private head = 0;

  constructor(timeframe: Timeframe, capacity: number) {
    this.timeframe = timeframe;
    this.capacity = Math.max(2, capacity);
    this.buffer = new Array<Bar>(this.capacity);
  }

  get length(): number {
    return this.count;
  }

  /** Añade una vela YA CERRADA. El motor sólo llama a esto tras el cierre. */
  push(bar: Bar): void {
    this.buffer[this.head] = bar;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  at(offset: number): Bar | null {
    if (offset < 0 || offset >= this.count) return null;
    const index = (this.head - 1 - offset + this.capacity * 2) % this.capacity;
    return this.buffer[index] ?? null;
  }

  last(count: number): readonly Bar[] {
    const n = Math.min(count, this.count);
    const out = new Array<Bar>(n);
    for (let i = 0; i < n; i++) out[n - 1 - i] = this.at(i) as Bar;
    return out;
  }

  closes(count: number): Float64Array {
    return this.extract(count, (b) => b.close);
  }

  highs(count: number): Float64Array {
    return this.extract(count, (b) => b.high);
  }

  lows(count: number): Float64Array {
    return this.extract(count, (b) => b.low);
  }

  private extract(count: number, pick: (bar: Bar) => number): Float64Array {
    const n = Math.min(count, this.count);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[n - 1 - i] = pick(this.at(i) as Bar);
    return out;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }
}

// ---------------------------------------------------------------------------
// Agregador diario
// ---------------------------------------------------------------------------

/** Mantiene el día en curso y el anterior a partir del flujo de velas. */
export class DailyAggregator {
  private readonly timeZone: string;
  private current: DailyStats | null = null;
  private previous: DailyStats | null = null;

  constructor(timeZone: string) {
    this.timeZone = timeZone;
  }

  push(bar: Bar): void {
    const sessionDate = calendarParts(bar.ts, this.timeZone).sessionDate;
    if (this.current === null || this.current.sessionDate !== sessionDate) {
      if (this.current !== null) this.previous = this.current;
      this.current = {
        sessionDate,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.tickVolume,
        barCount: 1,
      };
      return;
    }
    this.current = {
      sessionDate,
      open: this.current.open,
      high: Math.max(this.current.high, bar.high),
      low: Math.min(this.current.low, bar.low),
      close: bar.close,
      volume: this.current.volume + bar.tickVolume,
      barCount: this.current.barCount + 1,
    };
  }

  getToday(): DailyStats | null {
    return this.current;
  }

  getPrevious(): DailyStats | null {
    return this.previous;
  }

  reset(): void {
    this.current = null;
    this.previous = null;
  }
}

// ---------------------------------------------------------------------------
// Vista
// ---------------------------------------------------------------------------

export interface MarketViewSources {
  readonly instrument: Instrument;
  readonly primaryTimeframe: Timeframe;
  readonly buffers: ReadonlyMap<Timeframe, SeriesBuffer>;
  readonly daily: DailyAggregator;
}

/**
 * Crea la vista para el instante `now`.
 *
 * Barata de crear: no copia velas, sólo envuelve los buffers y comprueba que
 * la última vela de cada serie esté efectivamente cerrada antes de `now`.
 */
export function createMarketView(sources: MarketViewSources, now: number): MarketView {
  const { instrument, buffers, primaryTimeframe, daily } = sources;

  const guard = (reader: SeriesBuffer): SeriesReader => {
    const latest = reader.at(0);
    if (latest !== null) {
      const closeTs = latest.ts + timeframeToMinutes(reader.timeframe) * 60_000;
      if (closeTs > now) {
        throw new LookaheadError(
          `La serie ${reader.timeframe} contiene una vela que aún no ha cerrado en el instante de decisión`,
          { now, barTs: latest.ts, closeTs, timeframe: reader.timeframe },
        );
      }
    }
    return reader;
  };

  const primaryBuffer = buffers.get(primaryTimeframe);
  if (primaryBuffer === undefined) {
    throw new LookaheadError("No hay buffer para el timeframe primario", { primaryTimeframe });
  }

  const view: MarketView = {
    now,
    instrument,
    calendar: calendarParts(now, instrument.sessionTimezone),
    primary: guard(primaryBuffer),
    series(timeframe: Timeframe): SeriesReader {
      const buffer = buffers.get(timeframe);
      if (buffer === undefined) {
        throw new LookaheadError(
          `El plugin pidió el timeframe ${timeframe}, que no declaró en requires.timeframes`,
          { timeframe },
        );
      }
      return guard(buffer);
    },
    price(): number {
      const bar = primaryBuffer.at(0);
      return bar === null ? Number.NaN : bar.close;
    },
    dailyOpen(): number | null {
      return daily.getToday()?.open ?? null;
    },
    today(): DailyStats | null {
      return daily.getToday();
    },
    previousDay(): DailyStats | null {
      return daily.getPrevious();
    },
  };

  return Object.freeze(view);
}
