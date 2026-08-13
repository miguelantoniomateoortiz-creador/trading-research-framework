import type { Database as SqliteDatabase } from "better-sqlite3";

/** Estado de instalación de un plugin, persistido para sobrevivir reinicios. */
export interface PluginInstallRecord {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly author: string;
  readonly description: string;
  readonly directory: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
}

interface PluginRow {
  id: string;
  version: string;
  name: string;
  author: string;
  description: string;
  directory: string;
  enabled: number;
  configJson: string;
}

function rowToRecord(row: PluginRow): PluginInstallRecord {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    author: row.author,
    description: row.description,
    directory: row.directory,
    enabled: row.enabled === 1,
    config: JSON.parse(row.configJson) as Record<string, unknown>,
  };
}

/**
 * Registra o actualiza un plugin descubierto en disco.
 *
 * NO pisa `enabled` ni `configJson` si el plugin ya existía: son decisiones
 * del usuario y deben sobrevivir a una actualización del plugin.
 */
export function upsertPluginInstall(
  db: SqliteDatabase,
  record: Omit<PluginInstallRecord, "enabled" | "config"> & { enabled?: boolean; config?: Record<string, unknown> },
): void {
  db.prepare(
    `INSERT INTO plugin_installs
       (id, version, name, author, description, directory, enabled, configJson, installedAt, updatedAt)
     VALUES (@id, @version, @name, @author, @description, @directory, @enabled, @configJson,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       name = excluded.name,
       author = excluded.author,
       description = excluded.description,
       directory = excluded.directory,
       updatedAt = CURRENT_TIMESTAMP`,
  ).run({
    id: record.id,
    version: record.version,
    name: record.name,
    author: record.author,
    description: record.description,
    directory: record.directory,
    enabled: record.enabled === false ? 0 : 1,
    configJson: JSON.stringify(record.config ?? {}),
  });
}

export function listPluginInstalls(db: SqliteDatabase): PluginInstallRecord[] {
  const rows = db.prepare("SELECT * FROM plugin_installs ORDER BY id").all() as PluginRow[];
  return rows.map(rowToRecord);
}

export function getPluginInstall(db: SqliteDatabase, id: string): PluginInstallRecord | null {
  const row = db.prepare("SELECT * FROM plugin_installs WHERE id = ?").get(id) as PluginRow | undefined;
  return row === undefined ? null : rowToRecord(row);
}

export function setPluginEnabled(db: SqliteDatabase, id: string, enabled: boolean): boolean {
  return (
    db
      .prepare("UPDATE plugin_installs SET enabled = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?")
      .run(enabled ? 1 : 0, id).changes > 0
  );
}

export function setPluginConfig(db: SqliteDatabase, id: string, config: Record<string, unknown>): boolean {
  return (
    db
      .prepare("UPDATE plugin_installs SET configJson = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?")
      .run(JSON.stringify(config), id).changes > 0
  );
}

export function removePluginInstall(db: SqliteDatabase, id: string): boolean {
  return db.prepare("DELETE FROM plugin_installs WHERE id = ?").run(id).changes > 0;
}
