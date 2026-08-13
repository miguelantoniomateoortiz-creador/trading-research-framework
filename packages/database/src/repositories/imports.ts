import { createHash } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";

/** Lotes de importación y reglas de entrada: la trazabilidad de los datos. */

export interface ImportBatchRecord {
  readonly id: string;
  readonly instrumentId: string;
  readonly format: string;
  readonly sourceFile: string;
  readonly sourceHash: string;
  readonly rowsRead: number;
  readonly rowsAccepted: number;
  readonly rowsRejected: number;
  readonly errors: readonly string[];
}

export function createImportBatch(
  db: SqliteDatabase,
  batch: Pick<ImportBatchRecord, "id" | "instrumentId" | "format" | "sourceFile" | "sourceHash">,
): void {
  db.prepare(
    `INSERT INTO import_batches (id, instrumentId, format, sourceFile, sourceHash, startedAt)
     VALUES (@id, @instrumentId, @format, @sourceFile, @sourceHash, CURRENT_TIMESTAMP)`,
  ).run(batch);
}

export function finishImportBatch(
  db: SqliteDatabase,
  id: string,
  stats: { rowsRead: number; rowsAccepted: number; rowsRejected: number; errors: readonly string[] },
): void {
  db.prepare(
    `UPDATE import_batches
     SET rowsRead = ?, rowsAccepted = ?, rowsRejected = ?, errorsJson = ?, finishedAt = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(stats.rowsRead, stats.rowsAccepted, stats.rowsRejected, JSON.stringify(stats.errors.slice(0, 100)), id);
}

/** Busca un lote previo con el mismo hash: permite avisar de reimportaciones. */
export function findBatchByHash(db: SqliteDatabase, instrumentId: string, sourceHash: string): string | null {
  const row = db
    .prepare("SELECT id FROM import_batches WHERE instrumentId = ? AND sourceHash = ? AND finishedAt IS NOT NULL")
    .get(instrumentId, sourceHash) as { id: string } | undefined;
  return row?.id ?? null;
}

export function listImportBatches(db: SqliteDatabase, instrumentId?: string): ImportBatchRecord[] {
  const sql =
    instrumentId === undefined
      ? "SELECT * FROM import_batches ORDER BY startedAt DESC"
      : "SELECT * FROM import_batches WHERE instrumentId = ? ORDER BY startedAt DESC";
  const rows = (instrumentId === undefined
    ? db.prepare(sql).all()
    : db.prepare(sql).all(instrumentId)) as (Omit<ImportBatchRecord, "errors"> & { errorsJson: string })[];
  return rows.map((row) => ({ ...row, errors: JSON.parse(row.errorsJson) as string[] }));
}

// ---------------------------------------------------------------------------
// Reglas de entrada
// ---------------------------------------------------------------------------

export interface EntryRuleRecord {
  readonly id: string;
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly config: Record<string, unknown>;
  readonly fingerprint: string;
}

/**
 * Huella de una regla = hash de (plugin, versión, configuración canónica).
 *
 * Es lo que permite responder "¿ya generé estas operaciones?" sin comparar
 * millones de filas, y garantiza que dos configuraciones distintas del mismo
 * plugin nunca se mezclen en el mismo análisis.
 */
export function computeRuleFingerprint(pluginId: string, version: string, config: Record<string, unknown>): string {
  const canonical = JSON.stringify(config, Object.keys(config).sort());
  return createHash("sha256").update(`${pluginId}@${version}|${canonical}`).digest("hex").slice(0, 32);
}

export function upsertEntryRule(db: SqliteDatabase, rule: EntryRuleRecord): void {
  db.prepare(
    `INSERT INTO entry_rules (id, pluginId, name, description, configJson, fingerprint, createdAt)
     VALUES (@id, @pluginId, @name, @description, @configJson, @fingerprint, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       configJson = excluded.configJson,
       fingerprint = excluded.fingerprint`,
  ).run({
    id: rule.id,
    pluginId: rule.pluginId,
    name: rule.name,
    description: rule.description,
    configJson: JSON.stringify(rule.config),
    fingerprint: rule.fingerprint,
  });
}

export function listEntryRules(db: SqliteDatabase): EntryRuleRecord[] {
  const rows = db.prepare("SELECT * FROM entry_rules ORDER BY name").all() as (Omit<EntryRuleRecord, "config"> & {
    configJson: string;
  })[];
  return rows.map((row) => ({ ...row, config: JSON.parse(row.configJson) as Record<string, unknown> }));
}

export function getEntryRule(db: SqliteDatabase, id: string): EntryRuleRecord | null {
  const row = db.prepare("SELECT * FROM entry_rules WHERE id = ?").get(id) as
    | (Omit<EntryRuleRecord, "config"> & { configJson: string })
    | undefined;
  return row === undefined ? null : { ...row, config: JSON.parse(row.configJson) as Record<string, unknown> };
}
