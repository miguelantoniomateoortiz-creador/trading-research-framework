import type { Database as SqliteDatabase } from "better-sqlite3";
import type { Bar, Timeframe } from "@trf/shared";
import { transaction } from "../connection.js";

/**
 * Acceso a velas.
 *
 * Todo lo que devuelve muchas filas es un GENERADOR, no un array. El
 * importador y el motor de features procesan años de M1 (≈ 375k velas/año)
 * sin que la memoria crezca con el tamaño del histórico.
 */

export interface BarQuery {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  /** Epoch ms inclusivo. */
  readonly fromTs?: number;
  /** Epoch ms exclusivo. */
  readonly toTs?: number;
  readonly limit?: number;
}

interface BarRow {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  volume: number;
  spread: number;
}

/**
 * Inserta velas de forma idempotente y por lotes.
 *
 * `INSERT OR IGNORE` + la clave natural (instrumento, timeframe, ts) hace que
 * reimportar un CSV solapado no duplique nada: el caso normal cuando exportas
 * de MT5 mes a mes y los rangos se pisan.
 *
 * @returns cuántas filas se insertaron realmente.
 */
export function insertBars(
  db: SqliteDatabase,
  instrumentId: string,
  timeframe: Timeframe,
  bars: readonly Bar[],
): number {
  if (bars.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO bars
       (instrumentId, timeframe, ts, open, high, low, close, tickVolume, volume, spread)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return transaction(db, () => {
    let inserted = 0;
    for (const bar of bars) {
      const info = stmt.run(
        instrumentId,
        timeframe,
        bar.ts,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.tickVolume,
        bar.volume,
        bar.spread,
      );
      inserted += info.changes;
    }
    return inserted;
  });
}

function buildBarSql(query: BarQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [query.instrumentId, query.timeframe];
  let sql = `SELECT ts, open, high, low, close, tickVolume, volume, spread
             FROM bars WHERE instrumentId = ? AND timeframe = ?`;
  if (query.fromTs !== undefined) {
    sql += " AND ts >= ?";
    params.push(query.fromTs);
  }
  if (query.toTs !== undefined) {
    sql += " AND ts < ?";
    params.push(query.toTs);
  }
  sql += " ORDER BY ts ASC";
  if (query.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(query.limit);
  }
  return { sql, params };
}

/** Itera velas en orden cronológico sin materializar el resultado. */
export function* iterateBars(db: SqliteDatabase, query: BarQuery): Generator<Bar> {
  const { sql, params } = buildBarSql(query);
  const stmt = db.prepare(sql);
  for (const row of stmt.iterate(...params) as Iterable<BarRow>) {
    yield row;
  }
}

/**
 * Carga un rango completo en memoria. Úsalo sólo cuando sabes que el rango es
 * acotado (p.ej. las velas de una sesión). Para rangos abiertos usa
 * `iterateBars`.
 */
export function loadBars(db: SqliteDatabase, query: BarQuery): Bar[] {
  const { sql, params } = buildBarSql(query);
  return db.prepare(sql).all(...params) as BarRow[];
}

export function countBars(db: SqliteDatabase, instrumentId: string, timeframe: Timeframe): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM bars WHERE instrumentId = ? AND timeframe = ?")
    .get(instrumentId, timeframe) as { n: number };
  return row.n;
}

export interface BarCoverage {
  readonly count: number;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
}

/** Rango cubierto por los datos. Lo usa el CLI para reportar qué hay cargado. */
export function barCoverage(db: SqliteDatabase, instrumentId: string, timeframe: Timeframe): BarCoverage {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(ts) AS firstTs, MAX(ts) AS lastTs
       FROM bars WHERE instrumentId = ? AND timeframe = ?`,
    )
    .get(instrumentId, timeframe) as { count: number; firstTs: number | null; lastTs: number | null };
  return row;
}

/**
 * Detecta huecos mayores que `maxGapMinutes`.
 *
 * Un histórico de MT5 SIEMPRE tiene huecos (fines de semana, festivos, cortes
 * del broker). Distinguir un hueco legítimo de datos que faltan es el paso
 * previo a cualquier conclusión estadística: si te faltan los tres días más
 * volátiles del año, tu edge es ficticio.
 */
export function findGaps(
  db: SqliteDatabase,
  query: BarQuery,
  maxGapMinutes: number,
): { fromTs: number; toTs: number; minutes: number }[] {
  const gaps: { fromTs: number; toTs: number; minutes: number }[] = [];
  let previousTs: number | null = null;
  for (const bar of iterateBars(db, query)) {
    if (previousTs !== null) {
      const minutes = (bar.ts - previousTs) / 60_000;
      if (minutes > maxGapMinutes) gaps.push({ fromTs: previousTs, toTs: bar.ts, minutes });
    }
    previousTs = bar.ts;
  }
  return gaps;
}
