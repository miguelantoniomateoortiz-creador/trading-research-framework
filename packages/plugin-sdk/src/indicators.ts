/**
 * Indicadores INCREMENTALES.
 *
 * Todos actualizan en O(1) por vela. Es la diferencia entre que construir las
 * features de 5 años de M1 tarde segundos o minutos: recalcular una EMA200
 * sobre una ventana en cada vela es O(n·200); con estado incremental es O(n).
 *
 * Cada indicador expone `ready`: hasta que no ha visto suficientes velas,
 * `value` es NaN. Nunca devuelven un valor "de calentamiento" que
 * contaminaría el análisis con números que no significan nada.
 */

import type { Bar } from "@trf/shared";

export interface Indicator {
  readonly ready: boolean;
  readonly value: number;
  reset(): void;
}

/** Media móvil exponencial. Se siembra con una SMA de `period` velas. */
export class Ema implements Indicator {
  private readonly period: number;
  private readonly alpha: number;
  private seedSum = 0;
  private seedCount = 0;
  private current = Number.NaN;

  constructor(period: number) {
    if (period < 1) throw new RangeError("El periodo de la EMA debe ser >= 1");
    this.period = period;
    this.alpha = 2 / (period + 1);
  }

  get ready(): boolean {
    return this.seedCount >= this.period;
  }

  get value(): number {
    return this.ready ? this.current : Number.NaN;
  }

  update(x: number): number {
    if (this.seedCount < this.period) {
      this.seedSum += x;
      this.seedCount++;
      if (this.seedCount === this.period) this.current = this.seedSum / this.period;
      return this.value;
    }
    this.current = this.alpha * x + (1 - this.alpha) * this.current;
    return this.current;
  }

  reset(): void {
    this.seedSum = 0;
    this.seedCount = 0;
    this.current = Number.NaN;
  }
}

/** Media móvil simple sobre ventana deslizante. */
export class Sma implements Indicator {
  private readonly window: Float64Array;
  private readonly period: number;
  private index = 0;
  private count = 0;
  private total = 0;

  constructor(period: number) {
    this.period = Math.max(1, period);
    this.window = new Float64Array(this.period);
  }

  get ready(): boolean {
    return this.count >= this.period;
  }

  get value(): number {
    return this.ready ? this.total / this.period : Number.NaN;
  }

  update(x: number): number {
    if (this.count === this.period) this.total -= this.window[this.index] as number;
    else this.count++;
    this.window[this.index] = x;
    this.total += x;
    this.index = (this.index + 1) % this.period;
    return this.value;
  }

  reset(): void {
    this.window.fill(0);
    this.index = 0;
    this.count = 0;
    this.total = 0;
  }
}

/** True Range de una vela respecto al cierre anterior. */
export function trueRange(bar: Bar, previousClose: number | null): number {
  if (previousClose === null || !Number.isFinite(previousClose)) return bar.high - bar.low;
  return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
}

/**
 * ATR con suavizado de Wilder (el mismo que usa MT5).
 * Nota: Wilder usa alpha = 1/period, NO 2/(period+1). Confundirlos hace que el
 * ATR de la plataforma no cuadre con el del gráfico y arruina la comparación.
 */
export class Atr implements Indicator {
  private readonly period: number;
  private previousClose: number | null = null;
  private seedSum = 0;
  private seedCount = 0;
  private current = Number.NaN;

  constructor(period: number) {
    this.period = Math.max(1, period);
  }

  get ready(): boolean {
    return this.seedCount >= this.period;
  }

  get value(): number {
    return this.ready ? this.current : Number.NaN;
  }

  update(bar: Bar): number {
    const tr = trueRange(bar, this.previousClose);
    this.previousClose = bar.close;

    if (this.seedCount < this.period) {
      this.seedSum += tr;
      this.seedCount++;
      if (this.seedCount === this.period) this.current = this.seedSum / this.period;
      return this.value;
    }
    this.current = (this.current * (this.period - 1) + tr) / this.period;
    return this.current;
  }

  reset(): void {
    this.previousClose = null;
    this.seedSum = 0;
    this.seedCount = 0;
    this.current = Number.NaN;
  }
}

/** Máximo y mínimo sobre una ventana deslizante. */
export class RollingExtremes {
  private readonly highs: Float64Array;
  private readonly lows: Float64Array;
  private readonly period: number;
  private index = 0;
  private count = 0;

  constructor(period: number) {
    this.period = Math.max(1, period);
    this.highs = new Float64Array(this.period);
    this.lows = new Float64Array(this.period);
  }

  get ready(): boolean {
    return this.count > 0;
  }

  update(high: number, low: number): void {
    this.highs[this.index] = high;
    this.lows[this.index] = low;
    this.index = (this.index + 1) % this.period;
    if (this.count < this.period) this.count++;
  }

  get highest(): number {
    if (this.count === 0) return Number.NaN;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.count; i++) max = Math.max(max, this.highs[i] as number);
    return max;
  }

  get lowest(): number {
    if (this.count === 0) return Number.NaN;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.count; i++) min = Math.min(min, this.lows[i] as number);
    return min;
  }

  get range(): number {
    return this.highest - this.lowest;
  }

  reset(): void {
    this.index = 0;
    this.count = 0;
  }
}

/**
 * VWAP anclado a la sesión.
 *
 * Se reinicia cuando cambia el día de mercado. Como precio típico usa
 * (H+L+C)/3 y como peso el volumen de ticks, que es lo único que un CFD de
 * índice suele traer.
 */
export class SessionVwap implements Indicator {
  private sumPriceVolume = 0;
  private sumVolume = 0;
  private currentSessionDate: string | null = null;

  get ready(): boolean {
    return this.sumVolume > 0;
  }

  get value(): number {
    return this.ready ? this.sumPriceVolume / this.sumVolume : Number.NaN;
  }

  update(bar: Bar, sessionDate: string): number {
    if (this.currentSessionDate !== sessionDate) {
      this.currentSessionDate = sessionDate;
      this.sumPriceVolume = 0;
      this.sumVolume = 0;
    }
    const typical = (bar.high + bar.low + bar.close) / 3;
    // Si no hay volumen (dato ausente), se pondera por 1 para no perder la vela.
    const weight = bar.tickVolume > 0 ? bar.tickVolume : 1;
    this.sumPriceVolume += typical * weight;
    this.sumVolume += weight;
    return this.value;
  }

  reset(): void {
    this.sumPriceVolume = 0;
    this.sumVolume = 0;
    this.currentSessionDate = null;
  }
}

/** Cuenta velas consecutivas alcistas y bajistas. */
export class StreakCounter {
  private bullish = 0;
  private bearish = 0;

  update(bar: Bar): void {
    if (bar.close > bar.open) {
      this.bullish++;
      this.bearish = 0;
    } else if (bar.close < bar.open) {
      this.bearish++;
      this.bullish = 0;
    } else {
      this.bullish = 0;
      this.bearish = 0;
    }
  }

  get consecutiveBullish(): number {
    return this.bullish;
  }

  get consecutiveBearish(): number {
    return this.bearish;
  }

  reset(): void {
    this.bullish = 0;
    this.bearish = 0;
  }
}

/** Media y desviación típica incrementales (Welford) sobre ventana infinita. */
export class RunningStats {
  private n = 0;
  private m = 0;
  private m2 = 0;

  update(x: number): void {
    this.n++;
    const delta = x - this.m;
    this.m += delta / this.n;
    this.m2 += delta * (x - this.m);
  }

  get count(): number {
    return this.n;
  }

  get mean(): number {
    return this.n > 0 ? this.m : Number.NaN;
  }

  get stdDev(): number {
    return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : Number.NaN;
  }

  reset(): void {
    this.n = 0;
    this.m = 0;
    this.m2 = 0;
  }
}
