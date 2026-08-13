import { Sma, defineFeaturePlugin, type FeatureContext, type PluginInitContext } from "@trf/plugin-sdk";
import type { Bar, VariableDefinition } from "@trf/shared";

/**
 * PLUGIN: estructura de mercado diaria.
 *
 * Apertura del día, gap contra el cierre anterior, niveles del día previo y
 * volumen relativo. Son los niveles de referencia que casi todo operador de
 * índices mira, y por eso tienen sentido como candidatos a predictores.
 *
 * `market.dayRangeUsed` merece una nota: mide qué fracción del rango medio
 * diario lleva recorrida el día en el momento de entrar. Es una forma barata
 * de preguntar "¿queda gasolina en la sesión?" y suele discriminar bien entre
 * continuaciones y agotamientos.
 */

interface Config {
  readonly volumeAverageBars: number;
}

function point(key: string, label: string, description: string): VariableDefinition {
  return {
    key,
    label,
    description,
    valueType: "continuous",
    causality: "predictor",
    unit: "points",
    producedBy: "core-market",
    producerVersion: "1.0.0",
  };
}

function perAtr(key: string, label: string, description: string): VariableDefinition {
  return {
    key,
    label,
    description,
    valueType: "continuous",
    causality: "predictor",
    unit: "atr",
    producedBy: "core-market",
    producerVersion: "1.0.0",
    binning: { kind: "edges", edges: [-2, -1, -0.25, 0.25, 1, 2] },
  };
}

const provides: VariableDefinition[] = [
  point("market.dailyOpen", "Apertura del día", "Apertura de la primera vela del día de mercado."),
  point("market.gapPoints", "Gap", "Apertura de hoy menos cierre de ayer, en puntos."),
  perAtr("market.gapAtr", "Gap (ATR)", "Gap normalizado por ATR."),
  perAtr("market.distanceToOpenAtr", "Distancia a la apertura (ATR)", "(precio - apertura del día) / ATR."),
  point("market.prevDayHigh", "Máximo del día previo", "Máximo del día de mercado anterior."),
  point("market.prevDayLow", "Mínimo del día previo", "Mínimo del día de mercado anterior."),
  point("market.prevDayClose", "Cierre del día previo", "Último cierre del día de mercado anterior."),
  point("market.prevDayRange", "Rango del día previo", "Máximo menos mínimo del día anterior."),
  perAtr("market.distanceToPrevHighAtr", "Distancia al máximo previo (ATR)", "(precio - máximo de ayer) / ATR."),
  perAtr("market.distanceToPrevLowAtr", "Distancia al mínimo previo (ATR)", "(precio - mínimo de ayer) / ATR."),
  {
    key: "market.dayRangeUsed",
    label: "Rango del día consumido",
    description:
      "Rango recorrido hoy hasta la entrada dividido por el rango del día anterior. >1 = el día ya es más amplio que el previo.",
    valueType: "continuous",
    causality: "predictor",
    unit: "ratio",
    producedBy: "core-market",
    producerVersion: "1.0.0",
    binning: { kind: "edges", edges: [0.25, 0.5, 0.75, 1] },
  },
  {
    key: "market.volume",
    label: "Volumen de la vela",
    description: "Volumen de ticks de la última vela cerrada.",
    valueType: "continuous",
    causality: "predictor",
    unit: "count",
    producedBy: "core-market",
    producerVersion: "1.0.0",
  },
  {
    key: "market.relativeVolume",
    label: "Volumen relativo",
    description: "Volumen de la última vela dividido por la media móvil de volumen. >1 = actividad por encima de lo normal.",
    valueType: "continuous",
    causality: "predictor",
    unit: "ratio",
    producedBy: "core-market",
    producerVersion: "1.0.0",
    binning: { kind: "edges", edges: [0.5, 0.8, 1.2, 2, 3] },
  },
];

let volumeAverage = new Sma(60);

export default defineFeaturePlugin<Config>({
  provides,

  init(ctx: PluginInitContext<Config>): void {
    volumeAverage = new Sma(ctx.config.volumeAverageBars ?? 60);
  },

  reset(): void {
    volumeAverage.reset();
  },

  onBar(bar: Bar): void {
    volumeAverage.update(bar.tickVolume);
  },

  compute(ctx: FeatureContext<Config>) {
    const price = ctx.market.price();
    const today = ctx.market.today();
    const previous = ctx.market.previousDay();
    const lastBar = ctx.market.primary.at(0);
    const atr = ctx.feature("volatility.atr");
    const usableAtr = atr !== null && atr > 0 ? atr : null;

    const norm = (value: number | null): number | null =>
      value === null || usableAtr === null ? null : value / usableAtr;

    const gap = today !== null && previous !== null ? today.open - previous.close : null;
    const prevRange = previous !== null ? previous.high - previous.low : null;
    const todayRange = today !== null ? today.high - today.low : null;
    const avgVolume = volumeAverage.value;

    return {
      "market.dailyOpen": today?.open ?? null,
      "market.gapPoints": gap,
      "market.gapAtr": norm(gap),
      "market.distanceToOpenAtr": today === null ? null : norm(price - today.open),
      "market.prevDayHigh": previous?.high ?? null,
      "market.prevDayLow": previous?.low ?? null,
      "market.prevDayClose": previous?.close ?? null,
      "market.prevDayRange": prevRange,
      "market.distanceToPrevHighAtr": previous === null ? null : norm(price - previous.high),
      "market.distanceToPrevLowAtr": previous === null ? null : norm(price - previous.low),
      "market.dayRangeUsed": todayRange !== null && prevRange !== null && prevRange > 0 ? todayRange / prevRange : null,
      "market.volume": lastBar?.tickVolume ?? null,
      "market.relativeVolume":
        lastBar !== null && Number.isFinite(avgVolume) && avgVolume > 0 ? lastBar.tickVolume / avgVolume : null,
    };
  },
});
