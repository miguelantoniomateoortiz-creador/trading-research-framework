import {
  defineEntryPlugin,
  type EntryContext,
  type EntrySignal,
  type PluginInitContext,
} from "@trf/plugin-sdk";
import { OpeningSessionTracker } from "@trf-plugin/nas100-open";

/**
 * PLUGIN DE ENTRADA: reversión CONFIRMADA de la apertura del NAS100.
 *
 * Distinto del "fade" ciego de `entry-opening-range-breakout` (que invierte
 * la dirección en el mismo instante en que rompe el rango): esta regla
 * ESPERA a que el mercado ya haya empezado a devolver una fracción real del
 * impulso inicial antes de apostar por la reversión. Comparar las dos —fade
 * ciego vs. reversión confirmada— es en sí mismo parte de la investigación:
 * si el NAS100 revierte, debería hacerlo mejor esperando confirmación que
 * adivinando en el instante exacto de la ruptura (el experimento con
 * tradeFade=true dio WR 26% / PF 0,68 — una pérdida sistemática, no ruido).
 *
 * Reutiliza `OpeningSessionTracker` de `nas100-open`: el mismo cálculo exacto
 * de impulso y retroceso que ya ves en `analyze:marginal`, en vez de
 * reimplementar la lógica una segunda vez con el riesgo de que las dos
 * definiciones diverjan con el tiempo.
 *
 * SECUENCIA:
 *   1. Se cierra el rango de apertura (primeros `openingRangeMinutes`).
 *   2. Debe existir un impulso de tamaño mínimo (`minImpulseAtr`, medido con
 *      un ATR aproximado calculado aquí mismo: un `EntryPlugin` no puede leer
 *      variables de otros plugins —esa tubería sólo existe entre
 *      `FeaturePlugin`s—, así que necesita su propia estimación de
 *      volatilidad, aunque sea más tosca que `volatility.atr`).
 *   3. Se espera a que `pullbackFraction` entre en la ventana
 *      [`confirmPullbackFraction`, `maxPullbackFraction`): retroceso
 *      suficiente para confirmar que el impulso se está revirtiendo, pero no
 *      tanto como para que el movimiento ya esté agotado.
 *   4. Se entra UNA vez por sesión, en la dirección CONTRARIA al impulso.
 */

interface Config {
  readonly openingRangeMinutes: number;
  readonly sessionOpenMinute: number;
  readonly atrPeriod: number;
  readonly minImpulseAtr: number;
  readonly confirmPullbackFraction: number;
  readonly maxPullbackFraction: number;
  readonly lastEntryMinute: number;
  readonly takeProfitPoints: number | null;
  readonly stopLossPoints: number | null;
  readonly maxHoldMinutes: number;
}

interface SessionState {
  sessionDate: string;
  entered: boolean;
}

let tracker = new OpeningSessionTracker(15, 570);
let state: SessionState | null = null;

export default defineEntryPlugin<Config>({
  init(ctx: PluginInitContext<Config>): void {
    tracker = new OpeningSessionTracker(
      ctx.config.openingRangeMinutes ?? 15,
      ctx.config.sessionOpenMinute ?? ctx.instrument.regularSessionOpenMinute,
    );
  },

  reset(): void {
    tracker.reset();
    state = null;
  },

  onBarClose(ctx: EntryContext<Config>): readonly EntrySignal[] {
    const config = ctx.config;
    const { calendar } = ctx.market;
    const bar = ctx.market.primary.at(0);
    if (bar === null) return [];

    if (state === null || state.sessionDate !== calendar.sessionDate) {
      state = { sessionDate: calendar.sessionDate, entered: false };
    }

    // El tracker se alimenta SIEMPRE, aunque hoy ya hayamos entrado: así sigue
    // disponible desde el primer minuto de la sesión siguiente.
    tracker.update(bar, calendar.sessionDate, calendar.minuteOfDay);

    if (state.entered) return [];
    if (!tracker.isRangeComplete) return [];
    if (calendar.minuteOfDay > (config.lastEntryMinute ?? 780)) return [];

    const impulseDirection = tracker.impulseDirection;
    if (impulseDirection === null || impulseDirection === 0) return [];

    const atr = approximateAtr(ctx, config.atrPeriod ?? 14);
    if (atr === null || atr <= 0) return [];

    const impulseSize = tracker.impulseSize;
    if (impulseSize === null || impulseSize / atr < (config.minImpulseAtr ?? 0.5)) return [];

    const pullbackFraction = tracker.pullbackFraction;
    if (pullbackFraction === null) return [];

    const confirm = config.confirmPullbackFraction ?? 0.5;
    const max = config.maxPullbackFraction ?? 1.5;
    if (pullbackFraction < confirm || pullbackFraction >= max) return [];

    state.entered = true;
    const direction = impulseDirection > 0 ? "short" : "long"; // fade del impulso

    return [
      {
        direction,
        takeProfitPoints: config.takeProfitPoints ?? null,
        stopLossPoints: config.stopLossPoints ?? null,
        maxHoldMinutes: config.maxHoldMinutes ?? 180,
        tag: "opening-reversal-confirmed",
      },
    ];
  },
});

/**
 * ATR aproximado: media simple del rango verdadero (sin el suavizado de
 * Wilder que usa `volatility.atr`) sobre las últimas `period` velas cerradas.
 * No pretende igualar esa variable con precisión, sólo sirve de puerta
 * ("¿el impulso fue lo bastante grande como para molestarse?"). Un
 * `EntryPlugin` no tiene acceso a las variables que calculan los
 * `FeaturePlugin`s; esa tubería (`feature()`) sólo existe entre ellos.
 */
function approximateAtr(ctx: EntryContext<Config>, period: number): number | null {
  const n = Math.max(2, period);
  const highs = ctx.market.primary.highs(n + 1);
  const lows = ctx.market.primary.lows(n + 1);
  const closes = ctx.market.primary.closes(n + 1);
  if (highs.length < 2) return null;

  let sum = 0;
  let count = 0;
  for (let i = 1; i < highs.length; i++) {
    const high = highs[i] as number;
    const low = lows[i] as number;
    const prevClose = closes[i - 1] as number;
    const trueRange = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    sum += trueRange;
    count++;
  }
  return count === 0 ? null : sum / count;
}
