import { Ema, defineFeaturePlugin, type FeatureContext, type PluginInitContext } from "@trf/plugin-sdk";
import type { Bar, VariableDefinition } from "@trf/shared";

/**
 * PLUGIN: tendencia.
 *
 * DEPENDE de `volatility.atr` (declarado en requires.features). El registro
 * garantiza que core-volatility se ejecute antes; si estuviera desactivado, la
 * carga falla con un mensaje claro en vez de producir nulls silenciosos.
 *
 * Decisión importante: las distancias a las medias se expresan EN ATRs, no en
 * puntos. "El precio está 30 puntos sobre la EMA20" no significa nada por sí
 * solo; "está a 1,5 ATR de la EMA20" es comparable entre días tranquilos y
 * días de pánico, y entre el NAS100 de 2022 y el de 2026.
 *
 * Las pendientes se expresan en ATR por vela por el mismo motivo.
 */

interface Config {
  readonly fastPeriod: number;
  readonly mediumPeriod: number;
  readonly slowPeriod: number;
  readonly slopeLookbackBars: number;
}

const provides: VariableDefinition[] = [
  ema("trend.ema20", "EMA rápida", "Media exponencial rápida sobre cierres."),
  ema("trend.ema50", "EMA media", "Media exponencial intermedia sobre cierres."),
  ema("trend.ema200", "EMA lenta", "Media exponencial lenta sobre cierres."),
  normalized("trend.distanceEma20Atr", "Distancia a la EMA rápida (ATR)", "(precio - EMA rápida) / ATR."),
  normalized("trend.distanceEma200Atr", "Distancia a la EMA lenta (ATR)", "(precio - EMA lenta) / ATR."),
  normalized("trend.slopeEma20", "Pendiente EMA rápida", "Variación de la EMA rápida por vela, en ATRs."),
  normalized("trend.slopeEma50", "Pendiente EMA media", "Variación de la EMA media por vela, en ATRs."),
  normalized("trend.slopeEma200", "Pendiente EMA lenta", "Variación de la EMA lenta por vela, en ATRs."),
  {
    key: "trend.alignment",
    label: "Alineación de medias",
    description: "+1 si EMA20 > EMA50 > EMA200, -1 si el orden es inverso, 0 si están entrelazadas.",
    valueType: "categorical",
    causality: "predictor",
    unit: "",
    producedBy: "core-trend",
    producerVersion: "1.0.0",
    categories: [
      { value: 1, label: "Alcista alineada" },
      { value: 0, label: "Sin alineación" },
      { value: -1, label: "Bajista alineada" },
    ],
  },
];

function ema(key: string, label: string, description: string): VariableDefinition {
  return {
    key,
    label,
    description,
    valueType: "continuous",
    causality: "predictor",
    unit: "points",
    producedBy: "core-trend",
    producerVersion: "1.0.0",
  };
}

function normalized(key: string, label: string, description: string): VariableDefinition {
  return {
    key,
    label,
    description,
    valueType: "continuous",
    causality: "predictor",
    unit: "atr",
    producedBy: "core-trend",
    producerVersion: "1.0.0",
    binning: { kind: "edges", edges: [-2, -1, -0.25, 0.25, 1, 2] },
  };
}

let fast = new Ema(20);
let medium = new Ema(50);
let slow = new Ema(200);
let lookback = 10;

/** Historial corto de cada EMA para calcular pendientes sin recorrer velas. */
let fastHistory: number[] = [];
let mediumHistory: number[] = [];
let slowHistory: number[] = [];

export default defineFeaturePlugin<Config>({
  provides,

  init(ctx: PluginInitContext<Config>): void {
    fast = new Ema(ctx.config.fastPeriod ?? 20);
    medium = new Ema(ctx.config.mediumPeriod ?? 50);
    slow = new Ema(ctx.config.slowPeriod ?? 200);
    lookback = Math.max(1, ctx.config.slopeLookbackBars ?? 10);
    fastHistory = [];
    mediumHistory = [];
    slowHistory = [];
  },

  reset(): void {
    fast.reset();
    medium.reset();
    slow.reset();
    fastHistory = [];
    mediumHistory = [];
    slowHistory = [];
  },

  onBar(bar: Bar): void {
    fast.update(bar.close);
    medium.update(bar.close);
    slow.update(bar.close);
    pushHistory(fastHistory, fast.value);
    pushHistory(mediumHistory, medium.value);
    pushHistory(slowHistory, slow.value);
  },

  compute(ctx: FeatureContext<Config>) {
    const price = ctx.market.price();
    // El ATR viene del plugin del que dependemos, no se recalcula.
    const atr = ctx.feature("volatility.atr");
    const usableAtr = atr !== null && atr > 0 ? atr : null;

    const perAtr = (value: number): number | null =>
      usableAtr === null || !Number.isFinite(value) ? null : value / usableAtr;

    const alignment =
      fast.ready && medium.ready && slow.ready
        ? fast.value > medium.value && medium.value > slow.value
          ? 1
          : fast.value < medium.value && medium.value < slow.value
            ? -1
            : 0
        : null;

    return {
      "trend.ema20": finite(fast.value),
      "trend.ema50": finite(medium.value),
      "trend.ema200": finite(slow.value),
      "trend.distanceEma20Atr": fast.ready ? perAtr(price - fast.value) : null,
      "trend.distanceEma200Atr": slow.ready ? perAtr(price - slow.value) : null,
      "trend.slopeEma20": slope(fastHistory, perAtr),
      "trend.slopeEma50": slope(mediumHistory, perAtr),
      "trend.slopeEma200": slope(slowHistory, perAtr),
      "trend.alignment": alignment,
    };
  },
});

function pushHistory(history: number[], value: number): void {
  if (!Number.isFinite(value)) return;
  history.push(value);
  // Se guarda una vela más de las necesarias para poder mirar `lookback` atrás.
  if (history.length > lookback + 1) history.shift();
}

/** Pendiente media por vela durante las últimas `lookback` velas. */
function slope(history: number[], perAtr: (value: number) => number | null): number | null {
  if (history.length < lookback + 1) return null;
  const latest = history[history.length - 1] as number;
  const previous = history[history.length - 1 - lookback] as number;
  return perAtr((latest - previous) / lookback);
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}
