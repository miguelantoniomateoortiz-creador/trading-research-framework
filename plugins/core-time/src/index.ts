import { defineFeaturePlugin, type FeatureContext } from "@trf/plugin-sdk";
import { US_SESSIONS, sessionOf, type VariableDefinition } from "@trf/shared";

/**
 * PLUGIN: calendario y sesión.
 *
 * Todas las variables se derivan de `market.calendar`, que ya viene calculado
 * en la zona horaria del INSTRUMENTO. El plugin no toca fechas a mano.
 *
 * Nota sobre `time.year`: se marca como `meta`, NO como predictor. Un año es
 * un identificador, no una condición de mercado; usarlo en una hipótesis
 * equivale a memorizar el pasado. El motor de descubrimiento lo ignora.
 */

/** Codificación numérica de las sesiones, para poder guardarlas como número. */
const SESSION_CODES = {
  premarket: 1,
  openingHour: 2,
  regular: 3,
  lunch: 4,
  powerHour: 5,
  afterHours: 6,
} as const;

const provides: VariableDefinition[] = [
  {
    key: "time.minuteOfDay",
    label: "Minuto del día",
    description: "Minutos desde medianoche en la zona del mercado. 570 = 09:30 ET.",
    valueType: "ordinal",
    causality: "predictor",
    unit: "minutes",
    producedBy: "core-time",
    producerVersion: "1.0.0",
    range: { min: 0, max: 1439 },
    binning: { kind: "width", width: 5, origin: 0 },
  },
  {
    key: "time.hour",
    label: "Hora",
    description: "Hora del mercado (0-23).",
    valueType: "ordinal",
    causality: "predictor",
    unit: "",
    producedBy: "core-time",
    producerVersion: "1.0.0",
    range: { min: 0, max: 23 },
    binning: { kind: "width", width: 1, origin: 0 },
  },
  {
    key: "time.minute",
    label: "Minuto",
    description: "Minuto dentro de la hora (0-59).",
    valueType: "ordinal",
    causality: "predictor",
    unit: "",
    producedBy: "core-time",
    producerVersion: "1.0.0",
    range: { min: 0, max: 59 },
  },
  {
    key: "time.dayOfWeek",
    label: "Día de la semana",
    description: "1 = lunes … 7 = domingo (ISO-8601).",
    valueType: "categorical",
    causality: "predictor",
    unit: "",
    producedBy: "core-time",
    producerVersion: "1.0.0",
    categories: [
      { value: 1, label: "Lunes" },
      { value: 2, label: "Martes" },
      { value: 3, label: "Miércoles" },
      { value: 4, label: "Jueves" },
      { value: 5, label: "Viernes" },
      { value: 6, label: "Sábado" },
      { value: 7, label: "Domingo" },
    ],
  },
  {
    key: "time.dayOfMonth",
    label: "Día del mes",
    description: "Día del mes (1-31).",
    valueType: "ordinal",
    causality: "predictor",
    unit: "",
    producedBy: "core-time",
    producerVersion: "1.0.0",
    range: { min: 1, max: 31 },
  },
  {
    key: "time.month",
    label: "Mes",
    description: "Mes (1-12).",
    valueType: "categorical",
    causality: "predictor",
    unit: "",
    producedBy: "core-time",
    producerVersion: "1.0.0",
    range: { min: 1, max: 12 },
  },
  {
    key: "time.year",
    label: "Año",
    description:
      "Año. Marcado como 'meta': sirve para filtrar datasets, NUNCA como predictor. Condicionar por año es memorizar, no descubrir.",
    valueType: "ordinal",
    causality: "meta",
    unit: "",
    producedBy: "core-time",
    producerVersion: "1.0.0",
  },
  {
    key: "time.minutesFromOpen",
    label: "Minutos desde la apertura",
    description: "Minutos transcurridos desde la apertura de la sesión regular. Negativo en premercado.",
    valueType: "continuous",
    causality: "predictor",
    unit: "minutes",
    producedBy: "core-time",
    producerVersion: "1.0.0",
    binning: { kind: "edges", edges: [0, 5, 15, 30, 60, 120, 240] },
  },
  {
    key: "time.minutesToClose",
    label: "Minutos hasta el cierre",
    description: "Minutos que faltan para el cierre de la sesión regular.",
    valueType: "continuous",
    causality: "predictor",
    unit: "minutes",
    producedBy: "core-time",
    producerVersion: "1.0.0",
  },
  {
    key: "time.session",
    label: "Sesión",
    description: "Tramo de sesión US más específico que contiene la entrada.",
    valueType: "categorical",
    causality: "predictor",
    unit: "",
    producedBy: "core-time",
    producerVersion: "1.0.0",
    categories: [
      { value: SESSION_CODES.premarket, label: "Premercado (04:00-09:30)" },
      { value: SESSION_CODES.openingHour, label: "Primera hora (09:30-10:30)" },
      { value: SESSION_CODES.regular, label: "Sesión regular (resto)" },
      { value: SESSION_CODES.lunch, label: "Almuerzo (11:30-14:00)" },
      { value: SESSION_CODES.powerHour, label: "Power hour (15:00-16:00)" },
      { value: SESSION_CODES.afterHours, label: "Fuera de horas (16:00-20:00)" },
      { value: 0, label: "Fuera de sesión" },
    ],
  },
  {
    key: "time.isRegularSession",
    label: "¿En sesión regular?",
    description: "1 si la entrada ocurre entre la apertura y el cierre regulares del instrumento.",
    valueType: "boolean",
    causality: "predictor",
    unit: "",
    producedBy: "core-time",
    producerVersion: "1.0.0",
  },
];

export default defineFeaturePlugin<Record<string, never>>({
  provides,

  compute(ctx: FeatureContext<Record<string, never>>) {
    const { calendar, instrument } = ctx.market;
    const session = sessionOf(calendar.minuteOfDay);
    const inRegular =
      calendar.minuteOfDay >= instrument.regularSessionOpenMinute &&
      calendar.minuteOfDay < instrument.regularSessionCloseMinute;

    return {
      "time.minuteOfDay": calendar.minuteOfDay,
      "time.hour": calendar.hour,
      "time.minute": calendar.minute,
      "time.dayOfWeek": calendar.dayOfWeek,
      "time.dayOfMonth": calendar.dayOfMonth,
      "time.month": calendar.month,
      "time.year": calendar.year,
      "time.minutesFromOpen": calendar.minuteOfDay - instrument.regularSessionOpenMinute,
      "time.minutesToClose": instrument.regularSessionCloseMinute - calendar.minuteOfDay,
      "time.session": session === null ? 0 : SESSION_CODES[session],
      "time.isRegularSession": inRegular ? 1 : 0,
    };
  },
});

export { SESSION_CODES, US_SESSIONS };
