import { defineEntryPlugin, type EntryContext, type EntrySignal } from "@trf/plugin-sdk";

/**
 * PLUGIN DE ENTRADA: hora fija.
 *
 * Genera una observación cada día al minuto configurado. Es deliberadamente
 * TONTO: no filtra nada.
 *
 * Y esa es la idea. En este framework la regla de entrada define la POBLACIÓN
 * a estudiar; los filtros se descubren después, con el motor de análisis, y se
 * validan fuera de muestra. Si la regla de entrada ya lleva los filtros dentro,
 * no se puede medir cuánto aporta cada uno ni cuántas combinaciones se
 * probaron, y el p-valor deja de significar nada.
 *
 * Con `direction: "both"` emite una long y una short en el mismo instante. Sirve
 * para estudiar la asimetría del mercado sin sesgar la muestra de antemano.
 */

interface Config {
  readonly entryMinute: number;
  readonly direction: "long" | "short" | "both";
  readonly takeProfitPoints: number | null;
  readonly stopLossPoints: number | null;
  readonly maxHoldMinutes: number;
  readonly daysOfWeek: readonly number[];
}

export default defineEntryPlugin<Config>({
  onBarClose(ctx: EntryContext<Config>): readonly EntrySignal[] {
    const { calendar } = ctx.market;
    const config = ctx.config;

    // `now` es el cierre de la vela; la entrada se ejecuta en la apertura de la
    // siguiente, que ocurre exactamente en este instante.
    if (calendar.minuteOfDay !== (config.entryMinute ?? 570)) return [];

    const allowedDays = config.daysOfWeek ?? [1, 2, 3, 4, 5];
    if (!allowedDays.includes(calendar.dayOfWeek)) return [];

    const template = {
      takeProfitPoints: config.takeProfitPoints ?? null,
      stopLossPoints: config.stopLossPoints ?? null,
      maxHoldMinutes: config.maxHoldMinutes ?? 120,
      tag: `open-${config.entryMinute ?? 570}`,
    };

    const direction = config.direction ?? "both";
    if (direction === "both") {
      return [
        { direction: "long", ...template },
        { direction: "short", ...template },
      ];
    }
    return [{ direction, ...template }];
  },
});
