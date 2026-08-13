import { StreakCounter, defineFeaturePlugin, type FeatureContext } from "@trf/plugin-sdk";
import {
  barBody,
  barLowerWick,
  barRange,
  barUpperWick,
  isBullish,
  type Bar,
  type VariableDefinition,
} from "@trf/shared";

/**
 * PLUGIN: anatomía de la vela.
 *
 * Todas las variables se calculan sobre la ÚLTIMA VELA CERRADA antes de la
 * entrada (`market.primary.at(0)`). Nunca sobre la vela en curso: su cierre
 * todavía no existe en el momento de decidir.
 *
 * Las proporciones (cuerpo/rango, mecha/rango) son adimensionales a propósito.
 * Un cuerpo de 12 puntos significa cosas distintas con el NAS100 en 12.000 que
 * en 20.000; el ratio, no.
 */

interface Config {
  readonly averageRangeBars: number;
}

const provides: VariableDefinition[] = [
  v("candle.range", "Rango de la vela", "High - Low de la última vela cerrada.", "points"),
  v("candle.body", "Cuerpo", "|Close - Open| de la última vela cerrada.", "points"),
  v("candle.upperWick", "Mecha superior", "High - max(Open, Close).", "points"),
  v("candle.lowerWick", "Mecha inferior", "min(Open, Close) - Low.", "points"),
  v("candle.bodyRatio", "Cuerpo / rango", "Cuerpo dividido por el rango. 1 = marubozu, 0 = doji.", "ratio", {
    min: 0,
    max: 1,
  }),
  v("candle.upperWickRatio", "Mecha superior / rango", "Proporción del rango ocupada por la mecha superior.", "ratio", {
    min: 0,
    max: 1,
  }),
  v("candle.lowerWickRatio", "Mecha inferior / rango", "Proporción del rango ocupada por la mecha inferior.", "ratio", {
    min: 0,
    max: 1,
  }),
  {
    key: "candle.isBullish",
    label: "¿Vela alcista?",
    description: "1 si Close > Open en la última vela cerrada.",
    valueType: "boolean",
    causality: "predictor",
    unit: "",
    producedBy: "core-candle",
    producerVersion: "1.0.0",
  },
  v("candle.consecutiveBullish", "Velas alcistas seguidas", "Racha alcista que termina en la última vela cerrada.", "count"),
  v("candle.consecutiveBearish", "Velas bajistas seguidas", "Racha bajista que termina en la última vela cerrada.", "count"),
  v("candle.avgRange5", "Rango medio reciente", "Rango medio de las últimas N velas (config averageRangeBars).", "points"),
];

function v(
  key: string,
  label: string,
  description: string,
  unit: string,
  range?: { min: number; max: number },
): VariableDefinition {
  const definition: VariableDefinition = {
    key,
    label,
    description,
    valueType: "continuous",
    causality: "predictor",
    unit,
    producedBy: "core-candle",
    producerVersion: "1.0.0",
  };
  return range === undefined ? definition : { ...definition, range };
}

/**
 * El contador de rachas es estado INCREMENTAL: se actualiza en `onBar`, una
 * vez por vela, y `compute` sólo lo lee. Si se recalculara dentro de `compute`
 * habría que recorrer hacia atrás en cada operación.
 */
const streak = new StreakCounter();

export default defineFeaturePlugin<Config>({
  provides,

  reset(): void {
    streak.reset();
  },

  onBar(bar: Bar): void {
    streak.update(bar);
  },

  compute(ctx: FeatureContext<Config>) {
    const bar = ctx.market.primary.at(0);
    if (bar === null) return emptyResult();

    const range = barRange(bar);
    const body = barBody(bar);
    const upper = barUpperWick(bar);
    const lower = barLowerWick(bar);

    // Una vela de rango cero (mercado parado) haría 0/0. Se devuelve null:
    // "desconocido" es distinto de "cero" y el analizador lo trata aparte.
    const safe = (value: number): number | null => (range > 0 ? value / range : null);

    const window = Math.max(1, ctx.config.averageRangeBars ?? 5);
    const recent = ctx.market.primary.last(window);
    const avgRange =
      recent.length === 0 ? null : recent.reduce((acc, b) => acc + barRange(b), 0) / recent.length;

    return {
      "candle.range": range,
      "candle.body": body,
      "candle.upperWick": upper,
      "candle.lowerWick": lower,
      "candle.bodyRatio": safe(body),
      "candle.upperWickRatio": safe(upper),
      "candle.lowerWickRatio": safe(lower),
      "candle.isBullish": isBullish(bar) ? 1 : 0,
      "candle.consecutiveBullish": streak.consecutiveBullish,
      "candle.consecutiveBearish": streak.consecutiveBearish,
      "candle.avgRange5": avgRange,
    };
  },
});

function emptyResult(): Record<string, null> {
  return Object.fromEntries(provides.map((d) => [d.key, null]));
}
