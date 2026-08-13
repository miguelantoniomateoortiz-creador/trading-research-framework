/**
 * @trf/database — persistencia.
 *
 * Dos capas complementarias:
 *   - `prisma/schema.prisma`: fuente de verdad del esquema y las migraciones.
 *   - este paquete: acceso de runtime vía better-sqlite3, orientado a streaming
 *     y a inserción por lotes.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { SCHEMA_DDL } from "./ddl.js";

/**
 * Se reexporta el tipo de la conexión para que los demás paquetes no tengan
 * que depender de `better-sqlite3` sólo para escribir una firma. El día que la
 * capa de persistencia cambie (DuckDB, por ejemplo), este alias es lo único
 * que hay que tocar.
 */
export type { Database as SqliteDatabase } from "better-sqlite3";

export { SCHEMA_DDL, SCHEMA_VERSION } from "./ddl.js";
export * from "./config.js";
export * from "./connection.js";
export * from "./materialize.js";
export * from "./repositories/instruments.js";
export * from "./repositories/bars.js";
export * from "./repositories/trades.js";
export * from "./repositories/variables.js";
export * from "./repositories/splits.js";
export * from "./repositories/plugins.js";
export * from "./repositories/imports.js";
export * from "./repositories/hypotheses.js";

/**
 * Crea el esquema si no existe. Idempotente.
 *
 * En desarrollo se usa `prisma migrate dev`; esta función existe para que los
 * tests y `trf db:init` puedan levantar una base desde cero sin depender del
 * cliente generado de Prisma.
 */
export function applySchema(db: SqliteDatabase): void {
  db.exec(SCHEMA_DDL);
}
