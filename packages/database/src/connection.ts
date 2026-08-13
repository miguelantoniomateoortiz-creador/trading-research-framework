import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { StorageError } from "@trf/shared";
import { ensureDirectories, loadDatabaseConfig, type DatabaseConfig } from "./config.js";

/**
 * CONEXIÓN DE RUNTIME.
 *
 * Prisma define el esquema y ejecuta las migraciones; el trabajo pesado
 * (ingerir millones de velas, proyectar columnas para el analizador) va por
 * better-sqlite3. Motivos concretos:
 *
 *  - better-sqlite3 es síncrono sobre el hilo actual: sin overhead de promesas
 *    en bucles de millones de iteraciones.
 *  - Soporta `transaction()` nativo, imprescindible para inserciones por lotes
 *    (10-50x más rápido que insertar fila a fila con autocommit).
 *  - Permite `iterate()`, que devuelve filas de una en una sin materializar el
 *    resultado completo. Es lo que cumple "no cargar toda la base en memoria".
 *  - Da acceso a PRAGMAs y a funciones JSON1 que Prisma no expone.
 *
 * Ver docs/adr/0003-prisma-mas-better-sqlite3.md
 */

export interface ConnectionOptions {
  readonly config?: Partial<DatabaseConfig>;
  readonly readonly?: boolean;
  /** Si es true no aplica PRAGMAs de escritura (útil en réplicas de sólo lectura). */
  readonly skipPragmas?: boolean;
}

let sharedConnection: SqliteDatabase | null = null;
let sharedConfig: DatabaseConfig | null = null;

/** Abre una conexión nueva. El llamante es responsable de cerrarla. */
export function openDatabase(options: ConnectionOptions = {}): { db: SqliteDatabase; config: DatabaseConfig } {
  const config = loadDatabaseConfig(options.config ?? {});
  ensureDirectories(config);

  let db: SqliteDatabase;
  try {
    db = new Database(config.databaseFile, { readonly: options.readonly ?? false });
  } catch (cause) {
    throw new StorageError("No se pudo abrir la base de datos SQLite", { file: config.databaseFile }, { cause });
  }

  if (options.skipPragmas !== true) applyPragmas(db, options.readonly ?? false);
  return { db, config };
}

/**
 * PRAGMAs de rendimiento.
 *
 * - `journal_mode = WAL`: lectores y escritor concurrentes. Sin esto, el
 *   dashboard se bloquea mientras corre una importación.
 * - `synchronous = NORMAL`: en WAL sigue siendo seguro frente a caídas del
 *   proceso; sólo un corte de corriente puede perder la última transacción.
 *   A cambio, la ingesta va varias veces más rápida.
 * - `cache_size = -262144`: 256 MB de caché de páginas. Los índices de una
 *   base de varios GB caben, y las consultas dejan de tocar disco.
 * - `mmap_size`: lecturas por mapeo de memoria, evita copias.
 * - `temp_store = MEMORY`: los ORDER BY / GROUP BY grandes no escriben a disco.
 */
function applyPragmas(db: SqliteDatabase, readonly: boolean): void {
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -262144");
  db.pragma("mmap_size = 268435456");
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("wal_autocheckpoint = 2000");
  }
}

/** Conexión compartida por proceso (CLI, API). Los tests usan `openDatabase`. */
export function getDatabase(options: ConnectionOptions = {}): SqliteDatabase {
  if (sharedConnection === null) {
    const opened = openDatabase(options);
    sharedConnection = opened.db;
    sharedConfig = opened.config;
  }
  return sharedConnection;
}

export function getConfig(): DatabaseConfig {
  if (sharedConfig === null) {
    getDatabase();
  }
  return sharedConfig as DatabaseConfig;
}

export function closeDatabase(): void {
  if (sharedConnection !== null) {
    sharedConnection.close();
    sharedConnection = null;
    sharedConfig = null;
  }
}

/**
 * Ejecuta `fn` dentro de una transacción. better-sqlite3 usa transacciones
 * síncronas, así que `fn` NO puede ser async (a propósito: mantener una
 * transacción abierta esperando E/S es la receta para bloquear la base).
 */
export function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped();
}

/**
 * Ejecuta ANALYZE y optimiza. Conviene llamarlo tras una importación grande
 * para que el planificador de consultas tenga estadísticas frescas.
 */
export function optimize(db: SqliteDatabase): void {
  db.exec("ANALYZE;");
  db.pragma("optimize");
}
