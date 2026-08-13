import { defineEntryPlugin, type EntryContext, type EntrySignal } from "@trf/plugin-sdk";

interface Config {
  readonly intervalMinutes: number;
  readonly sessionStartMinute: number;
  readonly sessionEndMinute: number;
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

    const interval = Math.max(1, config.intervalMinutes ?? 15);
    const start = config.sessionStartMinute ?? 570;
    const end = config.sessionEndMinute ?? 960;

    if (calendar.minuteOfDay < start || calendar.minuteOfDay > end) return [];
    if ((calendar.minuteOfDay - start) % interval !== 0) return [];

    const allowedDays = config.daysOfWeek ?? [1, 2, 3, 4, 5];
    if (!allowedDays.includes(calendar.dayOfWeek)) return [];

    const template = {
      takeProfitPoints: config.takeProfitPoints ?? null,
      stopLossPoints: config.stopLossPoints ?? null,
      maxHoldMinutes: config.maxHoldMinutes ?? 30,
      tag: `scalp-${interval}m`,
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