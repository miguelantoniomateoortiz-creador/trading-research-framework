import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema,
  NAS100,
  barCoverage,
  loadBars,
  openDatabase,
  upsertInstrument,
  type SqliteDatabase,
} from "@trf/database";
import { calendarParts } from "@trf/shared";
import { detectDelimiter, splitLine } from "./csv.js";
import { createTimezoneResolver, parseNaiveDateTime } from "./timezone.js";
import { parseMt5Bars, type ParseError } from "./mt5-bars.js";
import { importBarsFromFile } from "./pipeline.js";
import { formatAsMt5Csv, generateNas100Bars } from "./synthetic.js";

let dir: string;
let db: SqliteDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trf-imp-"));
  db = openDatabase({ config: { databaseFile: join(dir, "test.db") } }).db;
  applySchema(db);
  upsertInstrument(db, NAS100);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const HEADER = "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>";

function writeCsv(name: string, lines: readonly string[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

describe("CSV", () => {
  it("detecta el separador", () => {
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter("a,b,c")).toBe(",");
    expect(detectDelimiter("a;b;c")).toBe(";");
  });

  it("respeta las comillas dobles", () => {
    expect(splitLine('a,"b,c",d', ",")).toEqual(["a", "b,c", "d"]);
    expect(splitLine('"con ""comillas""",x', ",")).toEqual(['con "comillas"', "x"]);
  });
});

describe("zonas horarias", () => {
  it("acepta desplazamiento fijo", () => {
    const resolver = createTimezoneResolver("UTC+3");
    const naive = parseNaiveDateTime("2024.07.15", "16:30:00");
    expect(resolver.toUtc(naive)).toBe(Date.UTC(2024, 6, 15, 13, 30));
  });

  it("acepta zona IANA y aplica horario de verano", () => {
    const resolver = createTimezoneResolver("America/New_York");
    // 09:30 ET en julio (EDT, UTC-4) -> 13:30 UTC
    expect(resolver.toUtc(parseNaiveDateTime("2024.07.15", "09:30"))).toBe(Date.UTC(2024, 6, 15, 13, 30));
    // 09:30 ET en enero (EST, UTC-5) -> 14:30 UTC
    expect(resolver.toUtc(parseNaiveDateTime("2024.01.16", "09:30"))).toBe(Date.UTC(2024, 0, 16, 14, 30));
  });

  it("un desplazamiento fijo NO aplica horario de verano (por eso es peligroso)", () => {
    const fixed = createTimezoneResolver("UTC-5");
    const iana = createTimezoneResolver("America/New_York");
    const enero = parseNaiveDateTime("2024.01.16", "09:30");
    const julio = parseNaiveDateTime("2024.07.15", "09:30");
    expect(fixed.toUtc(enero)).toBe(iana.toUtc(enero));
    // En julio difieren en una hora: es exactamente el fallo que documenta timezone.ts.
    expect(fixed.toUtc(julio) - iana.toUtc(julio)).toBe(3_600_000);
  });

  it("rechaza zonas inventadas", () => {
    expect(() => createTimezoneResolver("Marte/Olympus")).toThrow(/desconocida/);
  });

  it("parsea los formatos de fecha habituales", () => {
    const expected = Date.UTC(2024, 0, 2, 9, 30);
    expect(parseNaiveDateTime("2024.01.02", "09:30:00")).toBe(expected);
    expect(parseNaiveDateTime("2024-01-02", "09:30")).toBe(expected);
    expect(parseNaiveDateTime("02/01/2024", "09:30")).toBe(expected);
  });
});

describe("parser de velas MT5", () => {
  const options = { sourceTimezone: "America/New_York" } as const;

  it("lee el formato estándar con cabecera", async () => {
    const path = writeCsv("bars.csv", [
      HEADER,
      "2024.07.15\t09:30:00\t16800.5\t16810.0\t16795.0\t16805.5\t1234\t0\t2",
      "2024.07.15\t09:31:00\t16805.5\t16812.0\t16803.0\t16809.0\t980\t0\t2",
    ]);

    const rows = [];
    for await (const row of parseMt5Bars(path, options)) rows.push(row);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.bar.ts).toBe(Date.UTC(2024, 6, 15, 13, 30));
    expect(rows[0]!.bar.open).toBe(16800.5);
    expect(rows[0]!.bar.tickVolume).toBe(1234);
    expect(rows[1]!.bar.ts - rows[0]!.bar.ts).toBe(60_000);
  });

  it("lee ficheros sin cabecera (mapeo posicional)", async () => {
    const path = writeCsv("nohdr.csv", ["2024.07.15,09:30:00,100,110,90,105,10,0,1"]);
    const rows = [];
    for await (const row of parseMt5Bars(path, options)) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bar.close).toBe(105);
  });

  it("acumula errores sin abortar el fichero", async () => {
    const path = writeCsv("mixto.csv", [
      HEADER,
      "2024.07.15\t09:30:00\t100\t110\t90\t105\t10\t0\t1",
      "fecha-mala\t09:31:00\t100\t110\t90\t105\t10\t0\t1",
      "2024.07.15\t09:32:00\t100\t80\t90\t105\t10\t0\t1",
      "2024.07.15\t09:33:00\t100\t110\t90\t105\t10\t0\t1",
    ]);

    const errors: ParseError[] = [];
    const rows = [];
    for await (const row of parseMt5Bars(path, options, (e) => errors.push(e))) rows.push(row);

    expect(rows).toHaveLength(2);
    expect(errors).toHaveLength(2);
    expect(errors[1]!.message).toMatch(/incoherente/);
  });

  it("respeta el filtro de rango temporal", async () => {
    const path = writeCsv("rango.csv", [
      HEADER,
      "2024.07.15\t09:30:00\t100\t110\t90\t105\t10\t0\t1",
      "2024.07.16\t09:30:00\t100\t110\t90\t105\t10\t0\t1",
    ]);
    const rows = [];
    for await (const row of parseMt5Bars(path, { ...options, fromTs: Date.UTC(2024, 6, 16) })) rows.push(row);
    expect(rows).toHaveLength(1);
  });
});

describe("pipeline", () => {
  it("importa, es idempotente y deja traza", async () => {
    const path = writeCsv("import.csv", [
      HEADER,
      ...Array.from({ length: 100 }, (_, i) => {
        const minute = 30 + (i % 30);
        const hour = 9 + Math.floor(i / 30);
        return `2024.07.15\t${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00\t100\t110\t90\t105\t10\t0\t1`;
      }),
    ]);

    const first = await importBarsFromFile({
      db,
      instrumentId: NAS100.id,
      timeframe: "M1",
      filePath: path,
      sourceTimezone: "America/New_York",
      batchSize: 25,
    });

    expect(first.rowsAccepted).toBe(100);
    expect(first.rowsInserted).toBeGreaterThan(0);
    expect(barCoverage(db, NAS100.id, "M1").count).toBe(first.rowsInserted);

    const second = await importBarsFromFile({
      db,
      instrumentId: NAS100.id,
      timeframe: "M1",
      filePath: path,
      sourceTimezone: "America/New_York",
    });

    expect(second.previousBatchId).toBe(first.batchId);
    expect(second.rowsInserted).toBe(0);
    expect(second.duplicatesSkipped).toBe(100);
    expect(barCoverage(db, NAS100.id, "M1").count).toBe(first.rowsInserted);
  });

  it("no importa nada si se prohíbe la reimportación", async () => {
    const path = writeCsv("dup.csv", [HEADER, "2024.07.15\t09:30:00\t100\t110\t90\t105\t10\t0\t1"]);
    const options = {
      db,
      instrumentId: NAS100.id,
      timeframe: "M1" as const,
      filePath: path,
      sourceTimezone: "America/New_York",
    };
    await importBarsFromFile(options);
    const second = await importBarsFromFile({ ...options, allowReimport: false });
    expect(second.rowsRead).toBe(0);
  });
});

describe("datos sintéticos", () => {
  it("es determinista con la misma semilla", () => {
    const options = { startDate: "2024-07-15", endDate: "2024-07-16", seed: 7 };
    const a = [...generateNas100Bars(options)];
    const b = [...generateNas100Bars(options)];
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(500);
  });

  it("no genera velas en fin de semana", () => {
    const bars = [...generateNas100Bars({ startDate: "2024-07-13", endDate: "2024-07-14", seed: 1 })];
    expect(bars).toHaveLength(0);
  });

  it("produce velas OHLC coherentes", () => {
    for (const bar of generateNas100Bars({ startDate: "2024-07-15", endDate: "2024-07-15", seed: 3 })) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.tickVolume).toBeGreaterThan(0);
    }
  });

  it("la volatilidad de la apertura supera a la de mediodía", () => {
    const bars = [...generateNas100Bars({ startDate: "2024-07-01", endDate: "2024-07-31", seed: 11 })];
    const rangeAt = (from: number, to: number): number => {
      const selected = bars.filter((b) => {
        const m = calendarParts(b.ts, "America/New_York").minuteOfDay;
        return m >= from && m < to;
      });
      return selected.reduce((acc, b) => acc + (b.high - b.low), 0) / Math.max(1, selected.length);
    };
    expect(rangeAt(570, 585)).toBeGreaterThan(rangeAt(720, 780) * 2);
  });

  it("el CSV generado se puede reimportar sin pérdida", async () => {
    const bars = [...generateNas100Bars({ startDate: "2024-07-15", endDate: "2024-07-15", seed: 5 })];
    const path = join(dir, "roundtrip.csv");
    writeFileSync(path, formatAsMt5Csv(bars), "utf8");

    await importBarsFromFile({
      db,
      instrumentId: NAS100.id,
      timeframe: "M1",
      filePath: path,
      sourceTimezone: "America/New_York",
    });

    const stored = loadBars(db, { instrumentId: NAS100.id, timeframe: "M1" });
    expect(stored).toHaveLength(bars.length);
    expect(stored[0]!.ts).toBe(bars[0]!.ts);
    expect(stored[0]!.close).toBeCloseTo(bars[0]!.close, 6);
  });
});
