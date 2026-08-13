import type { VariableDefinition } from "@trf/shared";

/**
 * Definiciones de las variables de la investigación de apertura del NAS100.
 *
 * Separadas del cálculo a propósito: es el patrón recomendado para plugins que
 * crezcan (plugin.json / variables.ts / calculator.ts / index.ts). Así se puede
 * revisar QUÉ mide el plugin sin leer CÓMO lo mide.
 */

const PLUGIN_ID = "nas100-open";
const VERSION = "1.0.0";

function base(
  key: string,
  label: string,
  description: string,
  unit: string,
  valueType: VariableDefinition["valueType"] = "continuous",
): VariableDefinition {
  return {
    key,
    label,
    description,
    valueType,
    causality: "predictor",
    unit,
    producedBy: PLUGIN_ID,
    producerVersion: VERSION,
  };
}

export const variables: VariableDefinition[] = [
  {
    ...base(
      "nas100.minutesSinceOpen",
      "Minutos desde la apertura",
      "Minutos transcurridos desde la primera vela de la sesión regular.",
      "minutes",
      "ordinal",
    ),
    binning: { kind: "edges", edges: [5, 15, 30, 60, 120] },
  },
  base("nas100.openingRangeHigh", "Máximo del rango de apertura", "Máximo de los primeros N minutos.", "points"),
  base("nas100.openingRangeLow", "Mínimo del rango de apertura", "Mínimo de los primeros N minutos.", "points"),
  {
    ...base(
      "nas100.openingRangeSizeAtr",
      "Tamaño del rango de apertura (ATR)",
      "Amplitud del rango de apertura dividida por el ATR. Mide si la apertura ha sido violenta o tranquila.",
      "atr",
    ),
    binning: { kind: "quantile", count: 5 },
  },
  base(
    "nas100.openingRangeComplete",
    "¿Rango de apertura cerrado?",
    "1 cuando han transcurrido los N minutos del rango de apertura.",
    "",
    "boolean",
  ),
  {
    ...base(
      "nas100.impulseDirection",
      "Dirección del impulso inicial",
      "+1 si al cerrar el rango de apertura el precio está por encima de la apertura del día, -1 si por debajo.",
      "",
      "categorical",
    ),
    categories: [
      { value: 1, label: "Impulso alcista" },
      { value: 0, label: "Sin impulso" },
      { value: -1, label: "Impulso bajista" },
    ],
  },
  {
    ...base(
      "nas100.impulseSizeAtr",
      "Tamaño del impulso inicial (ATR)",
      "Distancia recorrida desde la apertura hasta el cierre del rango de apertura, en ATRs.",
      "atr",
    ),
    binning: { kind: "quantile", count: 5 },
  },
  {
    ...base(
      "nas100.breakoutSide",
      "Lado de la ruptura",
      "+1 si el precio ha cerrado por encima del rango de apertura, -1 por debajo, 0 si aún no ha roto.",
      "",
      "categorical",
    ),
    categories: [
      { value: 1, label: "Ruptura alcista" },
      { value: 0, label: "Sin ruptura" },
      { value: -1, label: "Ruptura bajista" },
    ],
  },
  base(
    "nas100.minutesSinceBreakout",
    "Minutos desde la ruptura",
    "Minutos transcurridos desde la primera ruptura del rango de apertura.",
    "minutes",
  ),
  {
    ...base(
      "nas100.excursionWithImpulseAtr",
      "Recorrido a favor del impulso (ATR)",
      "Máximo recorrido desde la apertura en la dirección del impulso inicial, en ATRs.",
      "atr",
    ),
    binning: { kind: "quantile", count: 5 },
  },
  {
    ...base(
      "nas100.excursionAgainstImpulseAtr",
      "Recorrido en contra del impulso (ATR)",
      "Máxima distancia recorrida en contra del impulso inicial desde la apertura, en ATRs. Es la variable central de la hipótesis de reversión.",
      "atr",
    ),
    binning: { kind: "quantile", count: 5 },
  },
  base(
    "nas100.pullbackFromExtremeAtr",
    "Retroceso desde el extremo (ATR)",
    "Distancia entre el extremo de la sesión (en la dirección del impulso) y el precio actual, en ATRs.",
    "atr",
  ),
  {
    ...base(
      "nas100.pullbackFraction",
      "Fracción retrocedida",
      "Retroceso dividido por el recorrido a favor. 0 = en máximos, 1 = ha devuelto todo el movimiento.",
      "ratio",
    ),
    binning: { kind: "edges", edges: [0.236, 0.382, 0.5, 0.618, 0.786, 1] },
  },
  base(
    "nas100.crossedBackOpen",
    "¿Ha vuelto a la apertura?",
    "1 si tras el impulso inicial el precio ha vuelto a cruzar la apertura del día.",
    "",
    "boolean",
  ),
  base(
    "nas100.minutesToOpenCross",
    "Minutos hasta cruzar la apertura",
    "Minutos desde la apertura hasta que el precio volvió a cruzarla. Mide el TIEMPO de reversión.",
    "minutes",
  ),
  base(
    "nas100.distanceToRangeMidAtr",
    "Distancia al centro del rango (ATR)",
    "(precio - punto medio del rango de apertura) / ATR.",
    "atr",
  ),
];
