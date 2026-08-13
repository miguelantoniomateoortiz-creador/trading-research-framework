import type { Database as SqliteDatabase } from "better-sqlite3";
import type { VariableBinning, VariableCategory, VariableDefinition } from "@trf/shared";
import { transaction } from "../connection.js";

/**
 * REGISTRO DE VARIABLES.
 *
 * Es el catálogo que convierte el blob JSON en datos con semántica. Cada vez
 * que se carga un plugin, sus `provides` se sincronizan aquí.
 */

interface VariableRow {
  key: string;
  label: string;
  description: string;
  valueType: string;
  causality: string;
  unit: string;
  producedBy: string;
  producerVersion: string;
  categoriesJson: string | null;
  binningJson: string | null;
  rangeJson: string | null;
  materialized: number;
}

function rowToDefinition(row: VariableRow): VariableDefinition {
  const definition: {
    -readonly [K in keyof VariableDefinition]: VariableDefinition[K];
  } = {
    key: row.key,
    label: row.label,
    description: row.description,
    valueType: row.valueType as VariableDefinition["valueType"],
    causality: row.causality as VariableDefinition["causality"],
    unit: row.unit,
    producedBy: row.producedBy,
    producerVersion: row.producerVersion,
  };
  if (row.categoriesJson !== null) {
    definition.categories = JSON.parse(row.categoriesJson) as VariableCategory[];
  }
  if (row.binningJson !== null) {
    definition.binning = JSON.parse(row.binningJson) as VariableBinning;
  }
  if (row.rangeJson !== null) {
    definition.range = JSON.parse(row.rangeJson) as { min: number; max: number };
  }
  return definition;
}

export function upsertVariables(db: SqliteDatabase, definitions: readonly VariableDefinition[]): number {
  if (definitions.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO variable_definitions
       (key, label, description, valueType, causality, unit, producedBy, producerVersion,
        categoriesJson, binningJson, rangeJson, materialized, updatedAt)
     VALUES (@key, @label, @description, @valueType, @causality, @unit, @producedBy, @producerVersion,
             @categoriesJson, @binningJson, @rangeJson, 0, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       label = excluded.label,
       description = excluded.description,
       valueType = excluded.valueType,
       causality = excluded.causality,
       unit = excluded.unit,
       producedBy = excluded.producedBy,
       producerVersion = excluded.producerVersion,
       categoriesJson = excluded.categoriesJson,
       binningJson = excluded.binningJson,
       rangeJson = excluded.rangeJson,
       updatedAt = CURRENT_TIMESTAMP`,
  );

  return transaction(db, () => {
    let n = 0;
    for (const def of definitions) {
      stmt.run({
        key: def.key,
        label: def.label,
        description: def.description,
        valueType: def.valueType,
        causality: def.causality,
        unit: def.unit,
        producedBy: def.producedBy,
        producerVersion: def.producerVersion,
        categoriesJson: def.categories ? JSON.stringify(def.categories) : null,
        binningJson: def.binning ? JSON.stringify(def.binning) : null,
        rangeJson: def.range ? JSON.stringify(def.range) : null,
      });
      n++;
    }
    return n;
  });
}

export function listVariables(
  db: SqliteDatabase,
  filter: { causality?: VariableDefinition["causality"]; producedBy?: string } = {},
): VariableDefinition[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.causality !== undefined) {
    clauses.push("causality = ?");
    params.push(filter.causality);
  }
  if (filter.producedBy !== undefined) {
    clauses.push("producedBy = ?");
    params.push(filter.producedBy);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM variable_definitions${where} ORDER BY key`).all(...params) as VariableRow[];
  return rows.map(rowToDefinition);
}

export function getVariable(db: SqliteDatabase, key: string): VariableDefinition | null {
  const row = db.prepare("SELECT * FROM variable_definitions WHERE key = ?").get(key) as VariableRow | undefined;
  return row === undefined ? null : rowToDefinition(row);
}

/** Elimina del registro las variables de un plugin desinstalado. */
export function removeVariablesOfPlugin(db: SqliteDatabase, pluginId: string): number {
  return db.prepare("DELETE FROM variable_definitions WHERE producedBy = ?").run(pluginId).changes;
}
