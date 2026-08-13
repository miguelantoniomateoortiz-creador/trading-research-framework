import type { Bar } from "@trf/shared";

/**
 * SEGUIMIENTO DE LA APERTURA.
 *
 * Mantiene, sesión a sesión, todo lo necesario para responder a la hipótesis
 * de investigación:
 *
 *   "El NAS100 hace con frecuencia un impulso inicial y después revierte."
 *
 * Concretamente registra:
 *   - dirección del impulso inicial (medido al cerrar el rango de apertura);
 *   - recorrido a favor y en contra de ese impulso;
 *   - retroceso desde el extremo alcanzado;
 *   - si el precio ha vuelto a cruzar la apertura del día y cuánto tardó.
 *
 * Todo se actualiza con velas YA CERRADAS, así que cualquier lectura es
 * información disponible en el momento de decidir.
 */
export class OpeningSessionTracker {
  private readonly openingRangeMinutes: number;
  private readonly sessionOpenMinute: number;

  private sessionDate: string | null = null;

  /** Apertura de la sesión regular (primera vela en o después del minuto de apertura). */
  private openPrice: number | null = null;
  private openMinute: number | null = null;

  private rangeHigh = Number.NEGATIVE_INFINITY;
  private rangeLow = Number.POSITIVE_INFINITY;
  private rangeComplete = false;

  /** Precio al cerrar el rango de apertura: define el impulso inicial. */
  private impulseClose: number | null = null;

  private sessionHigh = Number.NEGATIVE_INFINITY;
  private sessionLow = Number.POSITIVE_INFINITY;

  private breakoutSide: 0 | 1 | -1 = 0;
  private breakoutMinute: number | null = null;

  private crossedBackOpen = false;
  private openCrossMinute: number | null = null;

  private lastMinuteOfDay = 0;
  private lastClose = Number.NaN;

  constructor(openingRangeMinutes: number, sessionOpenMinute: number) {
    this.openingRangeMinutes = Math.max(1, openingRangeMinutes);
    this.sessionOpenMinute = sessionOpenMinute;
  }

  /** Debe llamarse una vez por vela cerrada, en orden cronológico. */
  update(bar: Bar, sessionDate: string, minuteOfDay: number): void {
    if (this.sessionDate !== sessionDate) this.startSession(sessionDate);

    this.lastMinuteOfDay = minuteOfDay;
    this.lastClose = bar.close;

    // Antes de la apertura regular no se registra nada: el premercado tiene
    // otra dinámica y mezclarlo contaminaría el rango de apertura.
    if (minuteOfDay < this.sessionOpenMinute) return;

    if (this.openPrice === null) {
      this.openPrice = bar.open;
      this.openMinute = minuteOfDay;
    }

    const minutesSinceOpen = minuteOfDay - (this.openMinute ?? this.sessionOpenMinute);

    if (!this.rangeComplete) {
      this.rangeHigh = Math.max(this.rangeHigh, bar.high);
      this.rangeLow = Math.min(this.rangeLow, bar.low);
      if (minutesSinceOpen >= this.openingRangeMinutes - 1) {
        this.rangeComplete = true;
        this.impulseClose = bar.close;
      }
    }

    this.sessionHigh = Math.max(this.sessionHigh, bar.high);
    this.sessionLow = Math.min(this.sessionLow, bar.low);

    if (this.rangeComplete && this.breakoutSide === 0) {
      if (bar.close > this.rangeHigh) {
        this.breakoutSide = 1;
        this.breakoutMinute = minuteOfDay;
      } else if (bar.close < this.rangeLow) {
        this.breakoutSide = -1;
        this.breakoutMinute = minuteOfDay;
      }
    }

    // Reversión: el precio vuelve a atravesar la apertura del día en contra
    // del impulso inicial.
    if (this.rangeComplete && !this.crossedBackOpen && this.openPrice !== null && this.impulseClose !== null) {
      const direction = Math.sign(this.impulseClose - this.openPrice);
      if (direction > 0 && bar.low <= this.openPrice) {
        this.crossedBackOpen = true;
        this.openCrossMinute = minuteOfDay;
      } else if (direction < 0 && bar.high >= this.openPrice) {
        this.crossedBackOpen = true;
        this.openCrossMinute = minuteOfDay;
      }
    }
  }

  private startSession(sessionDate: string): void {
    this.sessionDate = sessionDate;
    this.openPrice = null;
    this.openMinute = null;
    this.rangeHigh = Number.NEGATIVE_INFINITY;
    this.rangeLow = Number.POSITIVE_INFINITY;
    this.rangeComplete = false;
    this.impulseClose = null;
    this.sessionHigh = Number.NEGATIVE_INFINITY;
    this.sessionLow = Number.POSITIVE_INFINITY;
    this.breakoutSide = 0;
    this.breakoutMinute = null;
    this.crossedBackOpen = false;
    this.openCrossMinute = null;
  }

  reset(): void {
    this.sessionDate = null;
    this.startSession("");
    this.sessionDate = null;
  }

  // -------------------------------------------------------------------------
  // Lecturas
  // -------------------------------------------------------------------------

  get hasOpened(): boolean {
    return this.openPrice !== null;
  }

  get minutesSinceOpen(): number | null {
    if (this.openMinute === null) return null;
    return this.lastMinuteOfDay - this.openMinute;
  }

  get openingRange(): { high: number; low: number; mid: number; size: number } | null {
    if (!Number.isFinite(this.rangeHigh) || !Number.isFinite(this.rangeLow)) return null;
    return {
      high: this.rangeHigh,
      low: this.rangeLow,
      mid: (this.rangeHigh + this.rangeLow) / 2,
      size: this.rangeHigh - this.rangeLow,
    };
  }

  get isRangeComplete(): boolean {
    return this.rangeComplete;
  }

  /** +1 impulso alcista, -1 bajista, 0 plano. `null` si aún no hay rango. */
  get impulseDirection(): number | null {
    if (this.impulseClose === null || this.openPrice === null) return null;
    return Math.sign(this.impulseClose - this.openPrice);
  }

  get impulseSize(): number | null {
    if (this.impulseClose === null || this.openPrice === null) return null;
    return Math.abs(this.impulseClose - this.openPrice);
  }

  get breakout(): { side: number; minutesSince: number | null } {
    return {
      side: this.breakoutSide,
      minutesSince: this.breakoutMinute === null ? null : this.lastMinuteOfDay - this.breakoutMinute,
    };
  }

  /** Recorrido máximo A FAVOR del impulso desde la apertura, en puntos. */
  get excursionWithImpulse(): number | null {
    const direction = this.impulseDirection;
    if (direction === null || this.openPrice === null) return null;
    if (direction >= 0) return this.sessionHigh - this.openPrice;
    return this.openPrice - this.sessionLow;
  }

  /** Recorrido máximo EN CONTRA del impulso desde la apertura, en puntos. */
  get excursionAgainstImpulse(): number | null {
    const direction = this.impulseDirection;
    if (direction === null || this.openPrice === null) return null;
    if (direction >= 0) return this.openPrice - this.sessionLow;
    return this.sessionHigh - this.openPrice;
  }

  /** Cuánto ha retrocedido el precio desde el extremo de la sesión, en puntos. */
  get pullbackFromExtreme(): number | null {
    const direction = this.impulseDirection;
    if (direction === null || !Number.isFinite(this.lastClose)) return null;
    return direction >= 0 ? this.sessionHigh - this.lastClose : this.lastClose - this.sessionLow;
  }

  /** Retroceso como fracción del recorrido a favor. 1 = ha devuelto todo. */
  get pullbackFraction(): number | null {
    const pullback = this.pullbackFromExtreme;
    const excursion = this.excursionWithImpulse;
    if (pullback === null || excursion === null || excursion <= 0) return null;
    return pullback / excursion;
  }

  get hasCrossedBackOpen(): boolean {
    return this.crossedBackOpen;
  }

  get minutesToOpenCross(): number | null {
    if (this.openCrossMinute === null || this.openMinute === null) return null;
    return this.openCrossMinute - this.openMinute;
  }

  get dailyOpen(): number | null {
    return this.openPrice;
  }
}
