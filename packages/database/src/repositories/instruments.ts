import type { Database as SqliteDatabase } from "better-sqlite3";
import type { Instrument } from "@trf/shared";

interface InstrumentRow {
  id: string;
  symbol: string;
  description: string;
  sessionTimezone: string;
  tickSize: number;
  pointValue: number;
  regularSessionOpenMinute: number;
  regularSessionCloseMinute: number;
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    symbol: row.symbol,
    description: row.description,
    sessionTimezone: row.sessionTimezone,
    tickSize: row.tickSize,
    pointValue: row.pointValue,
    regularSessionOpenMinute: row.regularSessionOpenMinute,
    regularSessionCloseMinute: row.regularSessionCloseMinute,
  };
}

export function upsertInstrument(db: SqliteDatabase, instrument: Instrument): void {
  db.prepare(
    `INSERT INTO instruments
       (id, symbol, description, sessionTimezone, tickSize, pointValue,
        regularSessionOpenMinute, regularSessionCloseMinute, createdAt)
     VALUES (@id, @symbol, @description, @sessionTimezone, @tickSize, @pointValue,
             @regularSessionOpenMinute, @regularSessionCloseMinute, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       symbol = excluded.symbol,
       description = excluded.description,
       sessionTimezone = excluded.sessionTimezone,
       tickSize = excluded.tickSize,
       pointValue = excluded.pointValue,
       regularSessionOpenMinute = excluded.regularSessionOpenMinute,
       regularSessionCloseMinute = excluded.regularSessionCloseMinute`,
  ).run(instrument);
}

export function getInstrument(db: SqliteDatabase, id: string): Instrument | null {
  const row = db.prepare("SELECT * FROM instruments WHERE id = ?").get(id) as InstrumentRow | undefined;
  return row === undefined ? null : toInstrument(row);
}

export function getInstrumentBySymbol(db: SqliteDatabase, symbol: string): Instrument | null {
  const row = db.prepare("SELECT * FROM instruments WHERE symbol = ?").get(symbol) as InstrumentRow | undefined;
  return row === undefined ? null : toInstrument(row);
}

export function listInstruments(db: SqliteDatabase): Instrument[] {
  const rows = db.prepare("SELECT * FROM instruments ORDER BY symbol").all() as InstrumentRow[];
  return rows.map(toInstrument);
}

/** Definición por defecto del NAS100, el instrumento de la primera investigación. */
export const NAS100: Instrument = {
  id: "nas100",
  symbol: "NAS100",
  description: "Nasdaq 100 index CFD",
  sessionTimezone: "America/New_York",
  tickSize: 0.1,
  pointValue: 1,
  regularSessionOpenMinute: 570,
  regularSessionCloseMinute: 960,
};
