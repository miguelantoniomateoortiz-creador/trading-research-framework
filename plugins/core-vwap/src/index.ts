import { SessionVwap, defineFeaturePlugin, type FeatureContext } from "@trf/plugin-sdk";
import { calendarParts, type Bar, type VariableDefinition } from "@trf/shared";
import type { MarketView } from "@trf/plugin-sdk";

/**
 * PLUGIN: VWAP de sesión.
 *
 * El VWAP se ancla al día de mercado (se reinicia en cada sesión nueva), que es
 * como lo usan los operadores de índices. La variable interesante casi nunca es
 * el VWAP en sí, sino la DISTANCIA del precio al VWAP normalizada por ATR:
 * responde a "¿está el precio estirado respecto al valor medio ponderado de hoy?".
 */

const provides: VariableDefinition[] = [
  {
    key: "vwap.value",
    label: "VWAP",
    description: "VWAP acumulado de la sesión, ponderado por volumen de ticks.",
    valueType: "continuous",
    causality: "predictor",
    unit: "points",
    producedBy: "core-vwap",
    producerVersion: "1.0.0",
  },
  {
    key: "vwap.distance",
    label: "Distancia al VWAP",
    description: "Precio menos VWAP, en puntos. Positivo = precio por encima.",
    valueType: "continuous",
    causality: "predictor",
    unit: "points",
    producedBy: "core-vwap",
    producerVersion: "1.0.0",
  },
  {
    key: "vwap.distanceAtr",
    label: "Distancia al VWAP (ATR)",
    description: "(Precio - VWAP) / ATR. Comparable entre días y entre regímenes de volatilidad.",
    valueType: "continuous",
    causality: "predictor",
    unit: "atr",
    producedBy: "core-vwap",
    producerVersion: "1.0.0",
    binning: { kind: "edges", edges: [-2, -1, -0.25, 0.25, 1, 2] },
  },
  {
    key: "vwap.side",
    label: "Lado del VWAP",
    description: "1 si el precio está por encima del VWAP, -1 si está por debajo, 0 si coincide.",
    valueType: "categorical",
    causality: "predictor",
    unit: "",
    producedBy: "core-vwap",
    producerVersion: "1.0.0",
    categories: [
      { value: 1, label: "Por encima" },
      { value: 0, label: "En el VWAP" },
      { value: -1, label: "Por debajo" },
    ],
  },
];

const vwap = new SessionVwap();

export default defineFeaturePlugin<Record<string, never>>({
  provides,

  reset(): void {
    vwap.reset();
  },

  onBar(bar: Bar, market: MarketView): void {
    const sessionDate = calendarParts(bar.ts, market.instrument.sessionTimezone).sessionDate;
    vwap.update(bar, sessionDate);
  },

  compute(ctx: FeatureContext<Record<string, never>>) {
    if (!vwap.ready) {
      return { "vwap.value": null, "vwap.distance": null, "vwap.distanceAtr": null, "vwap.side": null };
    }

    const price = ctx.market.price();
    const distance = price - vwap.value;
    const atr = ctx.feature("volatility.atr");

    return {
      "vwap.value": vwap.value,
      "vwap.distance": distance,
      "vwap.distanceAtr": atr !== null && atr > 0 ? distance / atr : null,
      "vwap.side": distance > 0 ? 1 : distance < 0 ? -1 : 0,
    };
  },
});
