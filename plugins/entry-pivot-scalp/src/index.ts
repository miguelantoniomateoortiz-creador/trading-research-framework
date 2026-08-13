import { defineEntryPlugin, type EntryContext, type EntrySignal } from "@trf/plugin-sdk";

type Level = "r3" | "r2" | "r1" | "pp" | "s1" | "s2" | "s3";

interface Config {
  readonly levels: readonly Level[];
  readonly touchTolerancePoints: number;
  readonly cooldownMinutes: number;
  readonly takeProfitPoints: number | null;
  readonly stopLossPoints: number | null;
  readonly maxHoldMinutes: number;
  readonly sessionStartMinute: number;
  readonly sessionEndMinute: number;
}

interface DayState {
  sessionDate: string;
  pivots: Record<Level, number> | null;
  lastSignalTs: Partial<Record<Level, number>>;
}

const DEFAULT_LEVELS: readonly Level[] = ["r3", "r2", "r1", "pp", "s1", "s2", "s3"];

let state: DayState | null = null;

function computePivots(high: number, low: number, close: number): Record<Level, number> {
  const pp = (high + low + close) / 3;
  return {
    pp,
    r1: 2 * pp - low,
    s1: 2 * pp - high,
    r2: pp + (high - low),
    s2: pp - (high - low),
    r3: high + 2 * (pp - low),
    s3: low - 2 * (high - pp),
  };
}

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
      const previous = ctx.market.previousDay();
      state = {
        sessionDate: calendar.sessionDate,
        pivots: previous === null ? null : computePivots(previous.high, previous.low, previous.close),
        lastSignalTs: {},
      };
    }
    if (state.pivots === null) return [];

    const start = config.sessionStartMinute ?? 0;
    const end = config.sessionEndMinute ?? 1439;
    if (calendar.minuteOfDay < start || calendar.minuteOfDay > end) return [];

    const tolerance = Math.max(0.1, config.touchTolerancePoints ?? 8);
    const cooldownMs = Math.max(0, config.cooldownMinutes ?? 20) * 60_000;
    const levels = config.levels ?? DEFAULT_LEVELS;
    const pivots = state.pivots;
    const lastSignalTs = state.lastSignalTs;

    const signals: EntrySignal[] = [];
    for (const level of levels) {
      const value = pivots[level];
      const distance = bar.close - value;
      if (Math.abs(distance) > tolerance) continue;

      const last = lastSignalTs[level] ?? Number.NEGATIVE_INFINITY;
      if (ctx.market.now - last < cooldownMs) continue;

      // El OPEN de esta misma vela es la mejor aproximación barata de "de
      // qué lado venía" el precio antes de tocar el nivel dentro de esta vela.
      const cameFromAbove = bar.open > value;
      const direction: "long" | "short" = cameFromAbove ? "long" : "short";

      lastSignalTs[level] = ctx.market.now;
      signals.push({
        direction,
        takeProfitPoints: config.takeProfitPoints ?? null,
        stopLossPoints: config.stopLossPoints ?? null,
        maxHoldMinutes: config.maxHoldMinutes ?? 45,
        tag: `pivot-${level}-${direction}`,
      });
    }
    return signals;
  },
});