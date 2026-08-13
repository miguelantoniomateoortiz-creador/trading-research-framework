import { defineEntryPlugin, type EntryContext, type EntrySignal } from "@trf/plugin-sdk";

/**
 * PLUGIN DE ENTRADA: ruptura del rango de apertura (ORB).
 *
 * Construye el rango con los primeros N minutos de la sesión regular y entra
 * en la primera vela que CIERRA fuera de él. Una entrada por sesión.
 *
 * `tradeFade: true` invierte la dirección: en vez de seguir la ruptura, opera
 * en su contra. Está aquí a propósito, porque la hipótesis de investigación del
 * NAS100 (impulso inicial y reversión) predice que la versión "fade" podría
 * funcionar mejor que la de continuación. Cambiar un booleano en la
 * configuración crea una regla de entrada distinta, con su propia huella, y
 * ambas se pueden comparar sobre exactamente los mismos datos.
 */

interface Config {
  readonly openingRangeMinutes: number;
  readonly sessionOpenMinute: number;
  readonly lastEntryMinute: number;
  readonly takeProfitPoints: number | null;
  readonly stopLossPoints: number | null;
  readonly maxHoldMinutes: number;
  readonly tradeFade: boolean;
}

interface SessionState {
  sessionDate: string;
  high: number;
  low: number;
  rangeComplete: boolean;
  entered: boolean;
}

let state: SessionState | null = null;

export default defineEntryPlugin<Config>({
  reset(): void {
    state = null;
  },

  onBarClose(ctx: EntryContext<Config>): readonly EntrySignal[] {
    const config = ctx.config;
    const openMinute = config.sessionOpenMinute ?? ctx.market.instrument.regularSessionOpenMinute;
    const rangeMinutes = config.openingRangeMinutes ?? 15;
    const { calendar } = ctx.market;
    const bar = ctx.market.primary.at(0);
    if (bar === null) return [];

    if (state === null || state.sessionDate !== calendar.sessionDate) {
      state = {
        sessionDate: calendar.sessionDate,
        high: Number.NEGATIVE_INFINITY,
        low: Number.POSITIVE_INFINITY,
        rangeComplete: false,
        entered: false,
      };
    }

    if (calendar.minuteOfDay < openMinute) return [];

    // Construcción del rango.
    if (!state.rangeComplete) {
      state.high = Math.max(state.high, bar.high);
      state.low = Math.min(state.low, bar.low);
      if (calendar.minuteOfDay >= openMinute + rangeMinutes) state.rangeComplete = true;
      return [];
    }

    if (state.entered) return [];
    if (calendar.minuteOfDay > (config.lastEntryMinute ?? 780)) return [];

    let direction: "long" | "short" | null = null;
    if (bar.close > state.high) direction = "long";
    else if (bar.close < state.low) direction = "short";
    if (direction === null) return [];

    state.entered = true;
    const finalDirection = config.tradeFade === true ? (direction === "long" ? "short" : "long") : direction;

    return [
      {
        direction: finalDirection,
        takeProfitPoints: config.takeProfitPoints ?? null,
        stopLossPoints: config.stopLossPoints ?? null,
        maxHoldMinutes: config.maxHoldMinutes ?? 180,
        tag: config.tradeFade === true ? "orb-fade" : "orb-breakout",
      },
    ];
  },
});
