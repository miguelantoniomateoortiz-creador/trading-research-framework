import { LookaheadError, type VariableDefinition } from "@trf/shared";
import { collectVariables, type Predicate } from "./predicate.js";

/**
 * GUARDA ANTI-LOOKAHEAD.
 *
 * El error más caro de la investigación cuantitativa es filtrar por una
 * variable que en el momento de entrar no se conoce.
 *
 * Ejemplo del propio enunciado del proyecto:
 *
 *     Hora = 9:30 AND ATR > 18 AND MAE < 25
 *
 * Las dos primeras condiciones son legítimas: a las 9:30 sabes qué hora es y
 * cuánto vale el ATR. La tercera NO: el MAE es la máxima excursión adversa de
 * la operación, y sólo se conoce cuando la operación ha cerrado. Filtrar por
 * él produce un win rate del 95% imposible de operar, porque equivale a
 * "quédate sólo con las operaciones que no se pusieron feas" — una decisión
 * que sólo se puede tomar en el pasado.
 *
 * Por eso cada variable declara su `causality` y este módulo BLOQUEA las de
 * resultado en cualquier predicado destinado a descubrir o validar.
 *
 * Sí se permiten en modo DIAGNÓSTICO, que es un uso legítimo y distinto:
 * "¿cómo se reparte el MAE de las operaciones que ya he seleccionado?" es una
 * pregunta útil para diseñar el stop loss. Lo que nunca se permite es que esa
 * respuesta se convierta en una condición de entrada.
 */

export type AnalysisPurpose =
  /** Buscar o validar hipótesis: sólo variables predictoras. */
  | "hypothesis"
  /** Describir una población ya seleccionada: se permiten resultados. */
  | "diagnostic";

export interface GuardOptions {
  readonly purpose?: AnalysisPurpose;
}

/**
 * Columnas nativas de la tabla `trades` que son variables de RESULTADO.
 * Están aquí porque no pasan por el registro de plugins.
 */
export const CORE_OUTCOME_COLUMNS = new Set([
  "pnlPoints",
  "pnlMoney",
  "exitPrice",
  "exitTs",
  "exitReason",
  "durationMinutes",
  "mae",
  "mfe",
  "minutesToMae",
  "minutesToMfe",
  "maxSpeedPointsPerMin",
  "slopePointsPerMin",
  "pullbackCount",
  "efficiency",
]);

/** Columnas nativas que sí se conocen antes de entrar. */
export const CORE_PREDICTOR_COLUMNS = new Set([
  "direction",
  "entryTs",
  "entryPrice",
  "takeProfitPrice",
  "stopLossPrice",
  "volumeLots",
  "sessionDate",
  "year",
  "month",
  "dayOfMonth",
  "dayOfWeek",
  "hour",
  "minute",
  "minuteOfDay",
]);

export function causalityOf(
  variable: string,
  registry: ReadonlyMap<string, VariableDefinition>,
): VariableDefinition["causality"] | "unknown" {
  const definition = registry.get(variable);
  if (definition !== undefined) return definition.causality;
  if (CORE_OUTCOME_COLUMNS.has(variable)) return "outcome";
  if (CORE_PREDICTOR_COLUMNS.has(variable)) return "predictor";
  return "unknown";
}

export interface GuardViolation {
  readonly variable: string;
  readonly causality: string;
  readonly reason: string;
}

/** Analiza el predicado sin lanzar. Útil para avisar en la interfaz. */
export function inspectPredicate(
  predicate: Predicate,
  registry: ReadonlyMap<string, VariableDefinition>,
): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const variable of collectVariables(predicate)) {
    const causality = causalityOf(variable, registry);
    if (causality === "outcome") {
      violations.push({
        variable,
        causality,
        reason:
          "es una variable de RESULTADO: su valor sólo se conoce al cerrar la operación, " +
          "así que no puede formar parte de una condición de entrada",
      });
    } else if (causality === "meta") {
      violations.push({
        variable,
        causality,
        reason:
          "es una variable META (identificadores, año, lote de importación): condicionar por ella " +
          "es memorizar el pasado, no descubrir una regularidad",
      });
    } else if (causality === "unknown") {
      violations.push({
        variable,
        causality,
        reason: "no está en el registro de variables; no se puede garantizar que sea conocida al entrar",
      });
    }
  }
  return violations;
}

/**
 * Lanza si el predicado usa variables no aptas para hipótesis.
 * Es una barrera dura: no hay bandera para "sólo esta vez".
 */
export function assertHypothesisSafe(
  predicate: Predicate,
  registry: ReadonlyMap<string, VariableDefinition>,
  options: GuardOptions = {},
): void {
  if (options.purpose === "diagnostic") return;

  const violations = inspectPredicate(predicate, registry);
  if (violations.length === 0) return;

  const detail = violations.map((v) => `  - ${v.variable} (${v.causality}): ${v.reason}`).join("\n");
  throw new LookaheadError(
    `El predicado usa variables que no pueden formar parte de una hipótesis:\n${detail}\n\n` +
      "Si sólo quieres describir una población ya seleccionada, ejecuta el análisis con purpose: \"diagnostic\".",
    { violations },
  );
}

/** Índice `clave -> definición` a partir de una lista. */
export function buildRegistry(definitions: readonly VariableDefinition[]): Map<string, VariableDefinition> {
  return new Map(definitions.map((d) => [d.key, d]));
}

/** Sólo las variables utilizables como predictores. */
export function predictorKeys(definitions: readonly VariableDefinition[]): string[] {
  return definitions
    .filter((d) => d.causality === "predictor")
    .map((d) => d.key)
    .sort();
}
