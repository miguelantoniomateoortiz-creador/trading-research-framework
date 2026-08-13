import { createHash } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { StorageError, type CohortMetrics, type Hypothesis, type HypothesisStatus, type ValidationRun } from "@trf/shared";

/**
 * HIPÓTESIS Y VALIDACIÓN — nivel 7.
 *
 * `hypotheses` guarda el predicado + lo que rindió en entrenamiento.
 * `validation_runs` guarda cada evaluación contra un split, de forma
 * INMUTABLE: nunca se actualiza una fila existente, sólo se insertan nuevas.
 */

// ---------------------------------------------------------------------------
// Hipótesis
// ---------------------------------------------------------------------------

interface HypothesisRow {
  id: string;
  name: string;
  description: string;
  predicateJson: string;
  variablesJson: string;
  criteriaJson: string;
  trainingMetricsJson: string;
  searchSpaceSize: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function rowToHypothesis(row: HypothesisRow): Hypothesis {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    predicateJson: row.predicateJson,
    variables: JSON.parse(row.variablesJson) as string[],
    criteria: JSON.parse(row.criteriaJson) as Record<string, unknown>,
    trainingMetrics:
      row.trainingMetricsJson === "{}" ? null : (JSON.parse(row.trainingMetricsJson) as CohortMetrics),
    searchSpaceSize: row.searchSpaceSize,
    status: row.status as HypothesisStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `hyp_<slug-del-nombre>_<hash8>`. Estable para el mismo nombre+predicado. */
export function hypothesisId(name: string, predicateJson: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // marcas diacríticas sueltas tras normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(`${name}|${predicateJson}|${Date.now()}`).digest("hex").slice(0, 8);
  return `hyp_${slug || "hipotesis"}_${hash}`;
}

export interface CreateHypothesisInput {
  readonly name: string;
  readonly description?: string;
  readonly predicateJson: string;
  readonly variables: readonly string[];
  readonly criteria: Record<string, unknown>;
  readonly trainingMetrics: CohortMetrics;
  /** Combinaciones probadas en la búsqueda que la produjo. 1 si fue escrita a mano. */
  readonly searchSpaceSize: number;
}

/**
 * Guarda una hipótesis nueva. Rechaza nombres repetidos: sin esa barrera,
 * "reversión de apertura" podría referirse a dos predicados distintos según
 * cuál se guardó primero, y `hypothesis:validate <nombre>` sería ambiguo.
 */
export function createHypothesis(db: SqliteDatabase, input: CreateHypothesisInput): Hypothesis {
  if (getHypothesisByName(db, input.name) !== null) {
    throw new StorageError(`Ya existe una hipótesis llamada "${input.name}". Usa otro nombre.`, {
      name: input.name,
    });
  }

  const id = hypothesisId(input.name, input.predicateJson);
  db.prepare(
    `INSERT INTO hypotheses
       (id, name, description, predicateJson, variablesJson, criteriaJson, trainingMetricsJson, searchSpaceSize, status, createdAt, updatedAt)
     VALUES (@id, @name, @description, @predicateJson, @variablesJson, @criteriaJson, @trainingMetricsJson, @searchSpaceSize, 'training_passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run({
    id,
    name: input.name,
    description: input.description ?? "",
    predicateJson: input.predicateJson,
    variablesJson: JSON.stringify(input.variables),
    criteriaJson: JSON.stringify(input.criteria),
    trainingMetricsJson: JSON.stringify(input.trainingMetrics),
    searchSpaceSize: input.searchSpaceSize,
  });

  return getHypothesis(db, id) as Hypothesis;
}

export function getHypothesis(db: SqliteDatabase, id: string): Hypothesis | null {
  const row = db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(id) as HypothesisRow | undefined;
  return row === undefined ? null : rowToHypothesis(row);
}

/** La más reciente si hubiera más de una (no debería, `createHypothesis` lo impide). */
export function getHypothesisByName(db: SqliteDatabase, name: string): Hypothesis | null {
  const row = db.prepare("SELECT * FROM hypotheses WHERE name = ? ORDER BY createdAt DESC LIMIT 1").get(name) as
    | HypothesisRow
    | undefined;
  return row === undefined ? null : rowToHypothesis(row);
}

/** Busca por id exacto y, si no hay coincidencia, por nombre. Comodidad de CLI. */
export function findHypothesis(db: SqliteDatabase, idOrName: string): Hypothesis | null {
  return getHypothesis(db, idOrName) ?? getHypothesisByName(db, idOrName);
}

export function listHypotheses(db: SqliteDatabase, filter: { status?: HypothesisStatus } = {}): Hypothesis[] {
  const rows =
    filter.status === undefined
      ? (db.prepare("SELECT * FROM hypotheses ORDER BY createdAt DESC").all() as HypothesisRow[])
      : (db
          .prepare("SELECT * FROM hypotheses WHERE status = ? ORDER BY createdAt DESC")
          .all(filter.status) as HypothesisRow[]);
  return rows.map(rowToHypothesis);
}

export function setHypothesisStatus(db: SqliteDatabase, id: string, status: HypothesisStatus): void {
  db.prepare("UPDATE hypotheses SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?").run(status, id);
}

// ---------------------------------------------------------------------------
// Evaluaciones (validation_runs)
// ---------------------------------------------------------------------------

interface ValidationRunRow {
  id: string;
  hypothesisId: string;
  splitId: string;
  metricsJson: string;
  pValue: number | null;
  qValue: number | null;
  passed: number;
  notes: string;
  ranAt: string;
}

function rowToRun(row: ValidationRunRow): ValidationRun {
  return {
    id: row.id,
    hypothesisId: row.hypothesisId,
    splitId: row.splitId,
    metrics: JSON.parse(row.metricsJson) as CohortMetrics,
    pValue: row.pValue,
    qValue: row.qValue,
    passed: row.passed === 1,
    notes: row.notes,
    ranAt: row.ranAt,
  };
}

export interface CreateValidationRunInput {
  readonly hypothesisId: string;
  readonly splitId: string;
  readonly metrics: CohortMetrics;
  readonly pValue: number | null;
  readonly qValue: number | null;
  readonly passed: boolean;
  readonly notes: string;
}

/** Inserta un `validation_run`. Nunca se actualiza uno existente: es el historial. */
export function createValidationRun(db: SqliteDatabase, input: CreateValidationRunInput): ValidationRun {
  const id = `run_${createHash("sha256").update(`${input.hypothesisId}|${input.splitId}|${Date.now()}|${Math.random()}`).digest("hex").slice(0, 12)}`;
  db.prepare(
    `INSERT INTO validation_runs (id, hypothesisId, splitId, metricsJson, pValue, qValue, passed, notes, ranAt)
     VALUES (@id, @hypothesisId, @splitId, @metricsJson, @pValue, @qValue, @passed, @notes, CURRENT_TIMESTAMP)`,
  ).run({
    id,
    hypothesisId: input.hypothesisId,
    splitId: input.splitId,
    metricsJson: JSON.stringify(input.metrics),
    pValue: input.pValue,
    qValue: input.qValue,
    passed: input.passed ? 1 : 0,
    notes: input.notes,
  });
  const row = db.prepare("SELECT * FROM validation_runs WHERE id = ?").get(id) as ValidationRunRow;
  return rowToRun(row);
}

export function listValidationRuns(db: SqliteDatabase, hypothesisId: string): ValidationRun[] {
  const rows = db
    .prepare("SELECT * FROM validation_runs WHERE hypothesisId = ? ORDER BY ranAt DESC")
    .all(hypothesisId) as ValidationRunRow[];
  return rows.map(rowToRun);
}
