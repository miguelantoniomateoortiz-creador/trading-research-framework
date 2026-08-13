import { Atr, RollingExtremes, defineFeaturePlugin, type FeatureContext, type PluginInitContext } from "@trf/plugin-sdk";
import type { Bar, VariableDefinition } from "@trf/shared";

/**
 * PLUGIN: volatilidad.
 *
 * Aporta la variable que más aparece en las hipótesis reales: el ATR.
 *
 * Dos matices importantes:
 *
 *  1. `volatility.atrRegime` (ATR rápido / ATR lento) suele ser mejor
 *     predictor que el ATR crudo. El ATR absoluto del NAS100 en 2022 y en 2025
 *     no son comparables porque el índice ha subido; el cociente sí lo es.
 *     Un patrón entrenado con ATR crudo deja de funcionar cuando el precio
 *     cambia de escala, y eso parece "el edge se ha muerto" cuando en realidad
 *     nunca existió.
 *
 *  2. `volatility.atrPercent` (ATR / precio) es la otra normalización útil.
 *     Se proporcionan las tres para poder comparar cuál generaliza mejor.
 */

interface Config {
  readonly atrPeriod: number;
  readonly atrSlowPeriod: number;
}

const provides: VariableDefinition[] = [
  {
    key: "volatility.atr",
    label: "ATR",
    description: "Average True Range con suavizado de Wilder, en puntos.",
    valueType: "continuous",
    causality: "predictor",
    unit: "points",
    producedBy: "core-volatility",
    producerVersion: "1.0.0",
    binning: { kind: "quantile", count: 5 },
  },
  {
    key: "volatility.atrSlow",
    label: "ATR lento",
    description: "ATR de periodo largo, referencia del régimen de fondo.",
    valueType: "continuous",
    causality: "predictor",
    unit: "points",
    producedBy: "core-volatility",
    producerVersion: "1.0.0",
  },
  {
    key: "volatility.atrRegime",
    label: "Régimen de volatilidad",
    description:
      "ATR rápido / ATR lento. >1 = volatilidad expandiéndose, <1 = contrayéndose. Adimensional: comparable entre años.",
    valueType: "continuous",
    causality: "predictor",
    unit: "ratio",
    producedBy: "core-volatility",
    producerVersion: "1.0.0",
    binning: { kind: "edges", edges: [0.7, 0.9, 1.1, 1.4] },
  },
  {
    key: "volatility.atrPercent",
    label: "ATR relativo al precio",
    description: "ATR dividido por el precio, en puntos básicos. Normaliza la escala del índice.",
    valueType: "continuous",
    causality: "predictor",
    unit: "bps",
    producedBy: "core-volatility",
    producerVersion: "1.0.0",
  },
  range("volatility.range5", "Rango 5 minutos", 5),
  range("volatility.range15", "Rango 15 minutos", 15),
  range("volatility.range60", "Rango 60 minutos", 60),
];

function range(key: string, label: string, minutes: number): VariableDefinition {
  return {
    key,
    label,
    description: `Máximo menos mínimo de las últimas ${minutes} velas cerradas.`,
    valueType: "continuous",
    causality: "predictor",
    unit: "points",
    producedBy: "core-volatility",
    producerVersion: "1.0.0",
    binning: { kind: "quantile", count: 5 },
  };
}

// Estado incremental. Se recrea en init() con la configuración efectiva.
let atrFast = new Atr(14);
let atrSlow = new Atr(100);
const range5 = new RollingExtremes(5);
const range15 = new RollingExtremes(15);
const range60 = new RollingExtremes(60);

export default defineFeaturePlugin<Config>({
  provides,

  init(ctx: PluginInitContext<Config>): void {
    atrFast = new Atr(ctx.config.atrPeriod ?? 14);
    atrSlow = new Atr(ctx.config.atrSlowPeriod ?? 100);
    range5.reset();
    range15.reset();
    range60.reset();
  },

  reset(): void {
    atrFast.reset();
    atrSlow.reset();
    range5.reset();
    range15.reset();
    range60.reset();
  },

  onBar(bar: Bar): void {
    atrFast.update(bar);
    atrSlow.update(bar);
    range5.update(bar.high, bar.low);
    range15.update(bar.high, bar.low);
    range60.update(bar.high, bar.low);
  },

  compute(ctx: FeatureContext<Config>) {
    const price = ctx.market.price();
    const fast = atrFast.value;
    const slow = atrSlow.value;

    return {
      "volatility.atr": finite(fast),
      "volatility.atrSlow": finite(slow),
      "volatility.atrRegime": Number.isFinite(fast) && Number.isFinite(slow) && slow > 0 ? fast / slow : null,
      "volatility.atrPercent": Number.isFinite(fast) && price > 0 ? (fast / price) * 10_000 : null,
      "volatility.range5": finite(range5.range),
      "volatility.range15": finite(range15.range),
      "volatility.range60": finite(range60.range),
    };
  },
});

/** NaN significa "aún calentando": se guarda como null, no como 0. */
function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}
