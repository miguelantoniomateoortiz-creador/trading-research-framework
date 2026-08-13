import type { Database as SqliteDatabase } from "better-sqlite3";
import { StorageError } from "@trf/shared";

/**
 * MATERIALIZACIÓN DE VARIABLES CALIENTES.
 *
 * El blob JSON da flexibilidad, pero `json_extract` en un WHERE obliga a
 * escanear la tabla entera: con 5M operaciones eso es ~2-4 s por filtro.
 *
 * Cuando una variable se consulta constantemente (típicamente `volatility.atr14`
 * o `time.minuteOfDay`), se "materializa": se añade una COLUMNA GENERADA VIRTUAL
 * que expone el valor del JSON, y se indexa. SQLite entonces resuelve el filtro
 * por índice (microsegundos) sin duplicar el dato en disco.
 *
 * Es lo mejor de los dos mundos: esquema flexible por defecto, rendimiento de
 * columna nativa donde hace falta, y sin migrar ni reescribir datos.
 *
 * Nota técnica: SQLite sólo permite añadir columnas generadas VIRTUAL con
 * ALTER TABLE (las STORED requerirían reescribir la tabla). Virtual + índice
 * es exactamente lo que queremos: el índice sí se materializa.
 */

/** Convierte `volatility.atr14` en un identificador SQL válido. */
export function materializedColumnName(variableKey: string): string {
  return `mv_${variableKey.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

/**
 * Comprueba si una columna existe.
 *
 * OJO: se usa `table_xinfo`, NO `table_info`. Es una peculiaridad real de
 * SQLite, verificada contra el motor: `PRAGMA table_info` NO incluye las
 * columnas generadas (`GENERATED ALWAYS AS ... VIRTUAL`) cuando se añaden con
 * `ALTER TABLE ADD COLUMN`, aunque la columna funciona perfectamente (se puede
 * leer, indexar y consultar). `PRAGMA table_xinfo` sí las incluye, marcadas
 * con `hidden = 2`. Usar `table_info` aquí hacía que `columnExists` devolviera
 * `false` para una columna que sí existía, y por tanto `materializeFeature`
 * la recreaba en cada llamada en vez de ser idempotente.
 */
function columnExists(db: SqliteDatabase, table: string, column: string): boolean {
  const rows = db.pragma(`table_xinfo("${table}")`) as { name: string }[];
  return rows.some((r) => r.name === column);
}

/**
 * Materializa una variable del blob JSON.
 * Idempotente: si ya existe la columna, sólo se asegura el índice.
 */
export function materializeFeature(db: SqliteDatabase, variableKey: string): { column: string; created: boolean } {
  if (variableKey.includes('"')) {
    throw new StorageError("Clave de variable inválida (contiene comillas)", { variableKey });
  }
  const column = materializedColumnName(variableKey);
  let created = false;

  if (!columnExists(db, "trades", column)) {
    db.exec(
      `ALTER TABLE "trades" ADD COLUMN "${column}" REAL
       GENERATED ALWAYS AS (json_extract("features", '$."${variableKey}"')) VIRTUAL`,
    );
    created = true;
  }
  db.exec(`CREATE INDEX IF NOT EXISTS "idx_${column}" ON "trades"("${column}")`);
  db.prepare("UPDATE variable_definitions SET materialized = 1 WHERE key = ?").run(variableKey);

  return { column, created };
}

/**
 * Quita el índice de una variable materializada.
 * La columna generada se deja: SQLite no soporta DROP COLUMN sobre columnas
 * generadas en todas las versiones, y una columna virtual sin índice no ocupa
 * espacio ni cuesta nada mantener.
 */
export function dematerializeFeature(db: SqliteDatabase, variableKey: string): void {
  const column = materializedColumnName(variableKey);
  db.exec(`DROP INDEX IF EXISTS "idx_${column}"`);
  db.prepare("UPDATE variable_definitions SET materialized = 0 WHERE key = ?").run(variableKey);
}

export function listMaterializedFeatures(db: SqliteDatabase): string[] {
  const rows = db
    .prepare("SELECT key FROM variable_definitions WHERE materialized = 1 ORDER BY key")
    .all() as { key: string }[];
  return rows.map((r) => r.key);
}

/**
 * Sustituye `json_extract(...)` por la columna materializada si existe.
 * El motor de análisis llama a esto al compilar cada predicado, de modo que
 * el usuario nunca tiene que saber qué está materializado y qué no.
 */
export function resolveFeatureExpression(db: SqliteDatabase, variableKey: string): string {
  const column = materializedColumnName(variableKey);
  if (columnExists(db, "trades", column)) return `"${column}"`;
  return `json_extract("features", '$."${variableKey}"')`;
}
