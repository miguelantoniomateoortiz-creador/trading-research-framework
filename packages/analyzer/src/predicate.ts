import { UnknownVariableError, ValidationError } from "@trf/shared";

/**
 * PREDICADOS COMPONIBLES — el lenguaje de las hipótesis.
 *
 * Una hipótesis es un árbol de condiciones sobre variables:
 *
 *   Hora = 9:30 AND ATR > 18 AND Gap < 10
 *
 * se representa como datos, no como código:
 *
 *   and([
 *     eq("time.minuteOfDay", 570),
 *     gt("volatility.atr", 18),
 *     lt("market.gapPoints", 10),
 *   ])
 *
 * Que sea un AST serializable, y no una función, es lo que permite:
 *   - guardarlo en la base y volver a evaluarlo meses después;
 *   - contar y enumerar el espacio de búsqueda del motor de descubrimiento;
 *   - traducirlo a SQL cuando conviene filtrar en la base;
 *   - mostrarlo en la interfaz y dejar que el usuario lo edite;
 *   - inspeccionar qué variables usa y bloquear las de resultado.
 */

export type ComparisonOperator = ">" | ">=" | "<" | "<=" | "==" | "!=";

export type Predicate =
  /** Selecciona todas las operaciones. Elemento neutro. */
  | { readonly type: "always" }
  | { readonly type: "compare"; readonly variable: string; readonly op: ComparisonOperator; readonly value: number }
  /** min <= x < max (o <= max si `inclusiveMax`). */
  | {
      readonly type: "between";
      readonly variable: string;
      readonly min: number;
      readonly max: number;
      readonly inclusiveMax?: boolean;
    }
  | { readonly type: "in"; readonly variable: string; readonly values: readonly number[] }
  | { readonly type: "isNull"; readonly variable: string }
  | { readonly type: "and"; readonly operands: readonly Predicate[] }
  | { readonly type: "or"; readonly operands: readonly Predicate[] }
  | { readonly type: "not"; readonly operand: Predicate };

// --- Constructores -----------------------------------------------------------

export const always: Predicate = { type: "always" };

export function compare(variable: string, op: ComparisonOperator, value: number): Predicate {
  return { type: "compare", variable, op, value };
}

export const gt = (v: string, x: number): Predicate => compare(v, ">", x);
export const gte = (v: string, x: number): Predicate => compare(v, ">=", x);
export const lt = (v: string, x: number): Predicate => compare(v, "<", x);
export const lte = (v: string, x: number): Predicate => compare(v, "<=", x);
export const eq = (v: string, x: number): Predicate => compare(v, "==", x);
export const neq = (v: string, x: number): Predicate => compare(v, "!=", x);

export function between(variable: string, min: number, max: number, inclusiveMax = false): Predicate {
  return { type: "between", variable, min, max, inclusiveMax };
}

export function oneOf(variable: string, values: readonly number[]): Predicate {
  return { type: "in", variable, values };
}

export function isNull(variable: string): Predicate {
  return { type: "isNull", variable };
}

export function and(...operands: Predicate[]): Predicate {
  const flat = operands.flatMap((p) => (p.type === "and" ? p.operands : [p])).filter((p) => p.type !== "always");
  if (flat.length === 0) return always;
  if (flat.length === 1) return flat[0] as Predicate;
  return { type: "and", operands: flat };
}

export function or(...operands: Predicate[]): Predicate {
  const flat = operands.flatMap((p) => (p.type === "or" ? p.operands : [p]));
  if (flat.length === 0) return always;
  if (flat.length === 1) return flat[0] as Predicate;
  return { type: "or", operands: flat };
}

export function not(operand: Predicate): Predicate {
  return operand.type === "not" ? operand.operand : { type: "not", operand };
}

// --- Inspección --------------------------------------------------------------

/** Todas las variables que aparecen en el árbol, sin repetir y ordenadas. */
export function collectVariables(predicate: Predicate): string[] {
  const found = new Set<string>();
  walk(predicate, (node) => {
    if ("variable" in node) found.add(node.variable);
  });
  return [...found].sort();
}

export function walk(predicate: Predicate, visit: (node: Predicate) => void): void {
  visit(predicate);
  switch (predicate.type) {
    case "and":
    case "or":
      for (const operand of predicate.operands) walk(operand, visit);
      break;
    case "not":
      walk(predicate.operand, visit);
      break;
    default:
      break;
  }
}

/** Número de condiciones atómicas: la "complejidad" de la hipótesis. */
export function complexity(predicate: Predicate): number {
  let count = 0;
  walk(predicate, (node) => {
    if (node.type === "compare" || node.type === "between" || node.type === "in" || node.type === "isNull") count++;
  });
  return count;
}

// --- Evaluación --------------------------------------------------------------

/**
 * Acceso a los valores de una fila. `null` = variable ausente o sin calcular.
 * SEMÁNTICA DE NULOS: cualquier comparación con null es FALSA, igual que en SQL.
 * Sólo `isNull` puede seleccionarlos. Así una vela de calentamiento sin ATR
 * nunca entra por accidente en una cohorte "ATR bajo".
 */
export type RowAccessor = (variable: string) => number | null;

export function evaluate(predicate: Predicate, row: RowAccessor): boolean {
  switch (predicate.type) {
    case "always":
      return true;
    case "compare": {
      const value = row(predicate.variable);
      if (value === null) return false;
      switch (predicate.op) {
        case ">":
          return value > predicate.value;
        case ">=":
          return value >= predicate.value;
        case "<":
          return value < predicate.value;
        case "<=":
          return value <= predicate.value;
        case "==":
          return value === predicate.value;
        case "!=":
          return value !== predicate.value;
        default:
          return false;
      }
    }
    case "between": {
      const value = row(predicate.variable);
      if (value === null) return false;
      return value >= predicate.min && (predicate.inclusiveMax === true ? value <= predicate.max : value < predicate.max);
    }
    case "in": {
      const value = row(predicate.variable);
      return value === null ? false : predicate.values.includes(value);
    }
    case "isNull":
      return row(predicate.variable) === null;
    case "and":
      return predicate.operands.every((p) => evaluate(p, row));
    case "or":
      return predicate.operands.some((p) => evaluate(p, row));
    case "not":
      return !evaluate(predicate.operand, row);
    default:
      return false;
  }
}

// --- Presentación ------------------------------------------------------------

/** Descripción legible, con las etiquetas del registro si se aportan. */
export function describe(predicate: Predicate, labels: ReadonlyMap<string, string> = new Map()): string {
  const label = (key: string): string => labels.get(key) ?? key;
  switch (predicate.type) {
    case "always":
      return "todas las operaciones";
    case "compare":
      return `${label(predicate.variable)} ${predicate.op} ${format(predicate.value)}`;
    case "between":
      return `${format(predicate.min)} ≤ ${label(predicate.variable)} ${predicate.inclusiveMax === true ? "≤" : "<"} ${format(predicate.max)}`;
    case "in":
      return `${label(predicate.variable)} ∈ {${predicate.values.map(format).join(", ")}}`;
    case "isNull":
      return `${label(predicate.variable)} sin valor`;
    case "and":
      return predicate.operands.map((p) => wrap(p, labels)).join(" Y ");
    case "or":
      return predicate.operands.map((p) => wrap(p, labels)).join(" O ");
    case "not":
      return `NO (${describe(predicate.operand, labels)})`;
    default:
      return "?";
  }
}

function wrap(predicate: Predicate, labels: ReadonlyMap<string, string>): string {
  const text = describe(predicate, labels);
  return predicate.type === "and" || predicate.type === "or" ? `(${text})` : text;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

// --- Serialización -----------------------------------------------------------

// Discovery genera rangos sin límite (ej. "minuto >= 42") usando +/-Infinity como
// min/max. JSON no tiene forma de representar Infinity (JSON.stringify lo convierte
// en null), así que se codifica como texto y se decodifica de vuelta al parsear —
// si no, cualquier predicado con un extremo abierto se rompe al guardarlo como
// hipótesis (bug real: "El campo 'max' debe ser un número finito").
const INFINITY_TOKEN = "__Infinity__";
const NEG_INFINITY_TOKEN = "__-Infinity__";

export function serializePredicate(predicate: Predicate): string {
  return JSON.stringify(predicate, (_key, value) => {
    if (value === Number.POSITIVE_INFINITY) return INFINITY_TOKEN;
    if (value === Number.NEGATIVE_INFINITY) return NEG_INFINITY_TOKEN;
    return value;
  });
}

export function parsePredicate(json: string): Predicate {
  const parsed = JSON.parse(json, (_key, value) => {
    if (value === INFINITY_TOKEN) return Number.POSITIVE_INFINITY;
    if (value === NEG_INFINITY_TOKEN) return Number.NEGATIVE_INFINITY;
    return value;
  }) as unknown;
  return validatePredicate(parsed);
}

/** Valida un predicado que viene de fuera (base de datos, API, UI). */
export function validatePredicate(value: unknown): Predicate {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new ValidationError("Predicado inválido: falta el campo 'type'", { value });
  }
  const node = value as { type: string; [key: string]: unknown };

  switch (node.type) {
    case "always":
      return always;
    case "compare":
      requireString(node["variable"], "variable");
      requireNumber(node["value"], "value");
      if (![">", ">=", "<", "<=", "==", "!="].includes(node["op"] as string)) {
        throw new ValidationError(`Operador desconocido: ${String(node["op"])}`, { node });
      }
      return compare(node["variable"] as string, node["op"] as ComparisonOperator, node["value"] as number);
    case "between":
      requireString(node["variable"], "variable");
      requireBoundNumber(node["min"], "min");
      requireBoundNumber(node["max"], "max");
      return between(
        node["variable"] as string,
        node["min"] as number,
        node["max"] as number,
        node["inclusiveMax"] === true,
      );
    case "in":
      requireString(node["variable"], "variable");
      if (!Array.isArray(node["values"])) throw new ValidationError("'values' debe ser un array", { node });
      return oneOf(node["variable"] as string, (node["values"] as unknown[]).map(Number));
    case "isNull":
      requireString(node["variable"], "variable");
      return isNull(node["variable"] as string);
    case "and":
    case "or": {
      if (!Array.isArray(node["operands"])) throw new ValidationError("'operands' debe ser un array", { node });
      const operands = (node["operands"] as unknown[]).map(validatePredicate);
      return node.type === "and" ? and(...operands) : or(...operands);
    }
    case "not":
      return not(validatePredicate(node["operand"]));
    default:
      throw new ValidationError(`Tipo de predicado desconocido: ${node.type}`, { node });
  }
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`El campo '${field}' debe ser una cadena no vacía`, { field, value });
  }
}

function requireNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`El campo '${field}' debe ser un número finito`, { field, value });
  }
}

/** Como requireNumber, pero permite +/-Infinity: los extremos de un rango ("between")
 * pueden quedar abiertos a propósito (ej. "minuto >= 42", sin límite superior). */
function requireBoundNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ValidationError(`El campo '${field}' debe ser un número`, { field, value });
  }
}

/** Comprueba que todas las variables del predicado existen en el registro. */
export function assertVariablesExist(predicate: Predicate, known: ReadonlySet<string>): void {
  const missing = collectVariables(predicate).filter((v) => !known.has(v));
  if (missing.length > 0) {
    throw new UnknownVariableError(`Variables desconocidas en el predicado: ${missing.join(", ")}`, { missing });
  }
}
