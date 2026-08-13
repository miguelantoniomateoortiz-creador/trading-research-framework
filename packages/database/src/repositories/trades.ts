import type { Database as SqliteDatabase } from "better-sqlite3";
import type { Direction, ExitReason, Trade, TradeSource } from "@trf/shared";
import { transaction } from "../connection.js";

/**
 * Acceso a operaciones.
 *
 * Regla de oro de este módulo: NUNCA devolver `SELECT *` de millones de filas
 * como array. Para el analizador existe `iterateTradeColumns`, que proyecta
 * sólo las columnas pedidas y las va emitiendo.
 */

/** Fila tal como se persiste (plano, sin objetos anidados). */
export interface TradeRow {
  id: string;
  instrumentId: string;
  entryRuleId: string;
  importBatchId: string | null;
  source: string;
  direction: string;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  pnlPoints: number;
  pnlMoney: number;
  volumeLots: number;
  exitReason: string;
  durationMinutes: number;
  mae: number;
  mfe: number;
  minutesToMae: number;
  minutesToMfe: number;
  maxSpeedPointsPerMin: number;
  slopePointsPerMin: number;
  pullbackCount: number;
  efficiency: number;
  sessionDate: string;
  year: number;
  month: number;
  dayOfMonth: number;
  dayOfWeek: number;
  hour: number;
  minute: number;
  minuteOfDay: number;
  features: string;
  featureSetVersion: string;
}

export function rowToTrade(row: TradeRow): Trade {
  return {
    id: row.id,
    instrumentId: row.instrumentId,
    source: row.source as TradeSource,
    entryRuleId: row.entryRuleId,
    direction: row.direction as Direction,
    entryTs: row.entryTs,
    exitTs: row.exitTs,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    takeProfitPrice: row.takeProfitPrice,
    stopLossPrice: row.stopLossPrice,
    pnlPoints: row.pnlPoints,
    pnlMoney: row.pnlMoney,
    volumeLots: row.volumeLots,
    exitReason: row.exitReason as ExitReason,
    durationMinutes: row.durationMinutes,
    excursion: {
      mae: row.mae,
      mfe: row.mfe,
      minutesToMae: row.minutesToMae,
      minutesToMfe: row.minutesToMfe,
      maxSpeedPointsPerMin: row.maxSpeedPointsPerMin,
      slopePointsPerMin: row.slopePointsPerMin,
      pullbackCount: row.pullbackCount,
      efficiency: row.efficiency,
    },
    features: JSON.parse(row.features) as Record<string, number | null>,
  };
}

const INSERT_COLUMNS = [
  "id", "instrumentId", "entryRuleId", "importBatchId", "source", "direction",
  "entryTs", "exitTs", "entryPrice", "exitPrice", "takeProfitPrice", "stopLossPrice",
  "pnlPoints", "pnlMoney", "volumeLots", "exitReason", "durationMinutes",
  "mae", "mfe", "minutesToMae", "minutesToMfe", "maxSpeedPointsPerMin",
  "slopePointsPerMin", "pullbackCount", "efficiency",
  "sessionDate", "year", "month", "dayOfMonth", "dayOfWeek", "hour", "minute", "minuteOfDay",
  "features", "featureSetVersion",
] as const;

/**
 * Inserta operaciones por lotes dentro de una única transacción.
 *
 * Con `synchronous = NORMAL` y transacción única, better-sqlite3 sostiene del
 * orden de 10^5 filas/segundo en un SSD normal. Sin transacción, cada INSERT
 * haría fsync y bajaría a ~10^2.
 */
export function insertTrades(db: SqliteDatabase, rows: readonly TradeRow[]): number {
  if (rows.length === 0) return 0;
  const placeholders = INSERT_COLUMNS.map((c) => `@${c}`).join(", ");
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO trades (${INSERT_COLUMNS.join(", ")}, createdAt)
     VALUES (${placeholders}, CURRENT_TIMESTAMP)`,
  );
  return transaction(db, () => {
    let count = 0;
    for (const row of rows) {
      stmt.run(row);
      count++;
    }
    return count;
  });
}

export interface TradeQuery {
  readonly instrumentId?: string;
  readonly entryRuleId?: string;
  /** Epoch ms inclusivo. */
  readonly fromTs?: number;
  /** Epoch ms exclusivo. */
  readonly toTs?: number;
  readonly source?: TradeSource;
  readonly direction?: Direction;
  readonly limit?: number;
  readonly offset?: number;
}

function whereClause(query: TradeQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.instrumentId !== undefined) {
    clauses.push("instrumentId = ?");
    params.push(query.instrumentId);
  }
  if (query.entryRuleId !== undefined) {
    clauses.push("entryRuleId = ?");
    params.push(query.entryRuleId);
  }
  if (query.fromTs !== undefined) {
    clauses.push("entryTs >= ?");
    params.push(query.fromTs);
  }
  if (query.toTs !== undefined) {
    clauses.push("entryTs < ?");
    params.push(query.toTs);
  }
  if (query.source !== undefined) {
    clauses.push("source = ?");
    params.push(query.source);
  }
  if (query.direction !== undefined) {
    clauses.push("direction = ?");
    params.push(query.direction);
  }
  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Itera operaciones completas. Orden cronológico por entrada. */
export function* iterateTrades(db: SqliteDatabase, query: TradeQuery = {}): Generator<Trade> {
  const { sql: where, params } = whereClause(query);
  let sql = `SELECT * FROM trades${where} ORDER BY entryTs ASC`;
  if (query.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(query.limit);
    if (query.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(query.offset);
    }
  }
  for (const row of db.prepare(sql).iterate(...params) as Iterable<TradeRow>) {
    yield rowToTrade(row);
  }
}

export function countTrades(db: SqliteDatabase, query: TradeQuery = {}): number {
  const { sql: where, params } = whereClause(query);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM trades${where}`).get(...params) as { n: number };
  return row.n;
}

/**
 * PROYECCIÓN COLUMNAR — la consulta que alimenta al motor de análisis.
 *
 * Devuelve sólo las columnas pedidas. Las claves con punto se resuelven contra
 * el blob JSON vía `json_extract`; las demás se leen como columna nativa.
 *
 * Ejemplo: `["pnlMoney", "minuteOfDay", "volatility.atr14"]` genera
 *   SELECT pnlMoney, minuteOfDay, json_extract(features,'$."volatility.atr14"')
 *
 * Esto es lo que evita cargar la fila entera (≈ 400 bytes) cuando el análisis
 * sólo necesita 3 números (24 bytes).
 */
export function* iterateTradeColumns(
  db: SqliteDatabase,
  columns: readonly string[],
  query: TradeQuery = {},
): Generator<Record<string, number | string | null>> {
  const projections = columns.map((col, i) => `${columnExpression(col)} AS c${i}`);
  const { sql: where, params } = whereClause(query);
  const sql = `SELECT ${projections.join(", ")} FROM trades${where} ORDER BY entryTs ASC`;

  for (const row of db.prepare(sql).iterate(...params) as Iterable<Record<string, number | string | null>>) {
    const out: Record<string, number | string | null> = {};
    for (let i = 0; i < columns.length; i++) out[columns[i] as string] = row[`c${i}`] ?? null;
    yield out;
  }
}

/** Columnas nativas de la tabla; cualquier otra clave se busca en el JSON. */
const NATIVE_COLUMNS = new Set<string>([
  ...INSERT_COLUMNS,
  "createdAt",
]);

export function columnExpression(key: string): string {
  if (NATIVE_COLUMNS.has(key)) return `"${key}"`;
  // json_extract con la clave entrecomillada: soporta puntos en el nombre.
  return `json_extract(features, '$."${key.replace(/"/g, '')}"')`;
}

export function isNativeColumn(key: string): boolean {
  return NATIVE_COLUMNS.has(key);
}

/** Actualiza el blob de features de una operación. Lo usa `trf features:build`. */
export function updateFeatures(
  db: SqliteDatabase,
  updates: readonly { id: string; features: Record<string, number | null>; featureSetVersion: string }[],
): number {
  if (updates.length === 0) return 0;
  const stmt = db.prepare("UPDATE trades SET features = ?, featureSetVersion = ? WHERE id = ?");
  return transaction(db, () => {
    let n = 0;
    for (const update of updates) {
      n += stmt.run(JSON.stringify(update.features), update.featureSetVersion, update.id).changes;
    }
    return n;
  });
}

export function deleteTradesByBatch(db: SqliteDatabase, importBatchId: string): number {
  return db.prepare("DELETE FROM trades WHERE importBatchId = ?").run(importBatchId).changes;
}

export function deleteTradesByRule(db: SqliteDatabase, entryRuleId: string): number {
  return db.prepare("DELETE FROM trades WHERE entryRuleId = ?").run(entryRuleId).changes;
}
