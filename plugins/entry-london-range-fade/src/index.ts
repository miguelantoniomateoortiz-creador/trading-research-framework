import { defineEntryPlugin, type EntryContext, type EntrySignal } from "@trf/plugin-sdk";

interface Config {
  readonly rangeStartMinute: number;
  readonly rangeEndMinute: number;
  readonly lastEntryMinute: number;
  readonly takeProfitPoints: number | null;
  readonly stopLossPoints: number | null;
  readonly maxHoldMinutes: number;
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

    if (calendar.minuteOfDay < config.rangeStartMinute) return [];

    if (!state.rangeComplete) {
      state.high = Math.max(state.high, bar.high);
      state.low = Math.min(state.low, bar.low);
      if (calendar.minuteOfDay >= config.rangeEndMinute) state.rangeComplete = true;
      return [];
    }

    if (state.entered) return [];
    if (calendar.minuteOfDay > (config.lastEntryMinute ?? 1439)) return [];

    const touchedUpper = bar.high >= state.high;
    const touchedLower = bar.low <= state.low;
    let direction: "long" | "short" | null = null;
    if (touchedUpper) direction = "short";
    else if (touchedLower) direction = "long";
    if (direction === null) return [];

    state.entered = true;

    return [
      {
        direction,
        takeProfitPoints: config.takeProfitPoints ?? null,
        stopLossPoints: config.stopLossPoints ?? null,
        maxHoldMinutes: config.maxHoldMinutes ?? 240,
        tag: direction === "short" ? "london-range-fade-short" : "london-range-fade-long",
      },
    ];
  },
});