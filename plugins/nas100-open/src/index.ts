import { defineFeaturePlugin, type FeatureContext, type MarketView, type PluginInitContext } from "@trf/plugin-sdk";
import { calendarParts, type Bar } from "@trf/shared";
import { OpeningSessionTracker } from "./calculator.js";
import { variables } from "./variables.js";

/**
 * PLUGIN DE INVESTIGACIÓN: apertura del NAS100.
 *
 * Hipótesis a estudiar: el índice hace con frecuencia un impulso inicial en la
 * apertura y después revierte. Este plugin no afirma nada: simplemente MIDE las
 * cinco cosas que hacen falta para contrastarlo con datos.
 *
 *   1. Dirección inicial      -> nas100.impulseDirection
 *   2. Movimiento contrario   -> nas100.excursionAgainstImpulseAtr
 *   3. Prob. de recuperación  -> nas100.crossedBackOpen (agregado por cohortes)
 *   4. Tiempo de reversión    -> nas100.minutesToOpenCross
 *   5. Máxima distancia en    -> nas100.excursionAgainstImpulseAtr combinado
 *      contra antes de volver    con nas100.crossedBackOpen
 *
 * Todas las magnitudes van en ATRs, no en puntos: el NAS100 ha pasado de 12.000
 * a más de 20.000 en el periodo de estudio y un umbral fijo en puntos mezclaría
 * regímenes incomparables.
 */

interface Config {
  readonly openingRangeMinutes: number;
  readonly sessionOpenMinute: number;
}

let tracker = new OpeningSessionTracker(15, 570);

export default defineFeaturePlugin<Config>({
  provides: variables,

  init(ctx: PluginInitContext<Config>): void {
    tracker = new OpeningSessionTracker(
      ctx.config.openingRangeMinutes ?? 15,
      ctx.config.sessionOpenMinute ?? ctx.instrument.regularSessionOpenMinute,
    );
  },

  reset(): void {
    tracker.reset();
  },

  onBar(bar: Bar, market: MarketView): void {
    const parts = calendarParts(bar.ts, market.instrument.sessionTimezone);
    tracker.update(bar, parts.sessionDate, parts.minuteOfDay);
  },

  compute(ctx: FeatureContext<Config>) {
    if (!tracker.hasOpened) return empty();

    const atr = ctx.feature("volatility.atr");
    const usableAtr = atr !== null && atr > 0 ? atr : null;
    const perAtr = (value: number | null): number | null =>
      value === null || usableAtr === null ? null : value / usableAtr;

    const range = tracker.openingRange;
    const breakout = tracker.breakout;
    const price = ctx.market.price();

    return {
      "nas100.minutesSinceOpen": tracker.minutesSinceOpen,
      "nas100.openingRangeHigh": range?.high ?? null,
      "nas100.openingRangeLow": range?.low ?? null,
      "nas100.openingRangeSizeAtr": perAtr(range?.size ?? null),
      "nas100.openingRangeComplete": tracker.isRangeComplete ? 1 : 0,
      "nas100.impulseDirection": tracker.impulseDirection,
      "nas100.impulseSizeAtr": perAtr(tracker.impulseSize),
      "nas100.breakoutSide": breakout.side,
      "nas100.minutesSinceBreakout": breakout.minutesSince,
      "nas100.excursionWithImpulseAtr": perAtr(tracker.excursionWithImpulse),
      "nas100.excursionAgainstImpulseAtr": perAtr(tracker.excursionAgainstImpulse),
      "nas100.pullbackFromExtremeAtr": perAtr(tracker.pullbackFromExtreme),
      "nas100.pullbackFraction": tracker.pullbackFraction,
      "nas100.crossedBackOpen": tracker.hasCrossedBackOpen ? 1 : 0,
      "nas100.minutesToOpenCross": tracker.minutesToOpenCross,
      "nas100.distanceToRangeMidAtr": range === null ? null : perAtr(price - range.mid),
    };
  },
});

function empty(): Record<string, null> {
  return Object.fromEntries(variables.map((v) => [v.key, null]));
}

export { OpeningSessionTracker } from "./calculator.js";
export { variables } from "./variables.js";
