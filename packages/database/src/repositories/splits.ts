import type { Database as SqliteDatabase } from "better-sqlite3";
import { ConfigError, splitsOverlap, type DatasetRole, type DatasetSplit } from "@trf/shared";

/**
 * Splits de entrenamiento y validación.
 *
 * `createSplit` REHÚSA crear un split de validación que solape con el de
 * entrenamiento (embargo incluido). Es una barrera dura, no un aviso: la fuga
 * de datos es el error que más resultados falsos produce en este dominio y no
 * se detecta mirando los números, porque los números salen preciosos.
 */

interface SplitRow {
  id: string;
  name: string;
  instrumentId: string;
  role: string;
  startTs: number;
  endTs: number;
  embargoDays: number;
  description: string;
  evaluationCount: number;
}

function rowToSplit(row: SplitRow): DatasetSplit {
  return { ...row, role: row.role as DatasetRole };
}

export function createSplit(db: SqliteDatabase, split: Omit<DatasetSplit, "evaluationCount">): DatasetSplit {
  if (split.endTs <= split.startTs) {
    throw new ConfigError("El split tiene un rango temporal vacío o invertido", { split });
  }

  if (split.role === "validation" || split.role === "holdout") {
    const trainingSplits = listSplits(db, { instrumentId: split.instrumentId, role: "training" });
    for (const training of trainingSplits) {
      if (splitsOverlap(training, split)) {
        throw new ConfigError(
          `El split "${split.name}" solapa con el de entrenamiento "${training.name}" ` +
            `(embargo de ${training.embargoDays} días incluido). Los datos fuera de muestra deben ser realmente fuera de muestra.`,
          { validation: split.name, training: training.name, embargoDays: training.embargoDays },
        );
      }
    }
  }

  db.prepare(
    `INSERT INTO dataset_splits
       (id, name, instrumentId, role, startTs, endTs, embargoDays, description, evaluationCount, createdAt)
     VALUES (@id, @name, @instrumentId, @role, @startTs, @endTs, @embargoDays, @description, 0, CURRENT_TIMESTAMP)`,
  ).run(split);

  return { ...split, evaluationCount: 0 };
}

export function listSplits(
  db: SqliteDatabase,
  filter: { instrumentId?: string; role?: DatasetRole } = {},
): DatasetSplit[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.instrumentId !== undefined) {
    clauses.push("instrumentId = ?");
    params.push(filter.instrumentId);
  }
  if (filter.role !== undefined) {
    clauses.push("role = ?");
    params.push(filter.role);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM dataset_splits${where} ORDER BY startTs`).all(...params) as SplitRow[];
  return rows.map(rowToSplit);
}

export function getSplit(db: SqliteDatabase, id: string): DatasetSplit | null {
  const row = db.prepare("SELECT * FROM dataset_splits WHERE id = ?").get(id) as SplitRow | undefined;
  return row === undefined ? null : rowToSplit(row);
}

export function getSplitByName(db: SqliteDatabase, instrumentId: string, name: string): DatasetSplit | null {
  const row = db
    .prepare("SELECT * FROM dataset_splits WHERE instrumentId = ? AND name = ?")
    .get(instrumentId, name) as SplitRow | undefined;
  return row === undefined ? null : rowToSplit(row);
}

/**
 * Registra que se ha evaluado algo contra este split.
 *
 * El contador no es decorativo: cada vez que miras el set de validación,
 * gastas un poco de su valor estadístico. A partir de ~10 usos deberías
 * plantearte que ya no es fuera de muestra.
 */
export function recordEvaluation(db: SqliteDatabase, splitId: string): number {
  db.prepare("UPDATE dataset_splits SET evaluationCount = evaluationCount + 1 WHERE id = ?").run(splitId);
  const row = db.prepare("SELECT evaluationCount AS n FROM dataset_splits WHERE id = ?").get(splitId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

export function deleteSplit(db: SqliteDatabase, id: string): boolean {
  return db.prepare("DELETE FROM dataset_splits WHERE id = ?").run(id).changes > 0;
}
