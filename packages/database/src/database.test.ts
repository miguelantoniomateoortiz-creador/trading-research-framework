import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { summarize } from "@trf/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "./index.js";
import { openDatabase } from "./connection.js";
import { NAS100, upsertInstrument } from "./repositories/instruments.js";
import { barCoverage, findGaps, insertBars, loadBars } from "./repositories/bars.js";
import { countTrades, insertTrades, iterateTradeColumns, type TradeRow } from "./repositories/trades.js";
import { createSplit, listSplits, recordEvaluation } from "./repositories/splits.js";
import { computeRuleFingerprint, upsertEntryRule } from "./repositories/imports.js";
import { materializeFeature, materializedColumnName, resolveFeatureExpression } from "./materialize.js";
import {
  createHypothesis,
  createValidationRun,
  findHypothesis,
  getHypothesis,
  getHypothesisByName,
  listHypotheses,
  listValidationRuns,
  setHypothesisStatus,
} from "./repositories/hypotheses.js";

let dir: string;
let db: SqliteDatabase;

const MINUTE = 60_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trf-db-"));
  db = openDatabase({ config: { databaseFile: join(dir, "test.db") } }).db;
  applySchema(db);
  upsertInstrument(db, NAS100);
  upsertEntryRule(db, {
    id: "rule-1",
    pluginId: "test",
    name: "regla de test",
    description: "",
    config: {},
    fingerprint: computeRuleFingerprint("test", "1.0.0", {}),
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeTrade(index: number, overrides: Partial<TradeRow> = {}): TradeRow {
  const entryTs = Date.UTC(2024, 0, 2, 14, 30) + index * 24 * 60 * MINUTE;
  return {
    id: `t-${index}`,
    instrumentId: NAS100.id,
    entryRuleId: "rule-1",
    importBatchId: null,
    source: "simulated",
    direction: index % 2 === 0 ? "long" : "short",
    entryTs,
    exitTs: entryTs + 30 * MINUTE,
    entryPrice: 18000,
    exitPrice: 18010,
    takeProfitPrice: null,
    stopLossPrice: null,
    pnlPoints: 10,
    pnlMoney: 10,
    volumeLots: 1,
    exitReason: "time_limit",
    durationMinutes: 30,
    mae: 5,
    mfe: 15,
    minutesToMae: 3,
    minutesToMfe: 20,
    maxSpeedPointsPerMin: 1.2,
    slopePointsPerMin: 0.3,
    pullbackCount: 2,
    efficiency: 0.66,
    sessionDate: "2024-01-02",
    year: 2024,
    month: 1,
    dayOfMonth: 2,
    dayOfWeek: 2,
    hour: 9,
    minute: 30,
    minuteOfDay: 570,
    features: JSON.stringify({ "volatility.atr14": 18 + index, "time.isMonday": index % 5 === 0 ? 1 : 0 }),
    featureSetVersion: "v1",
    ...overrides,
  };
}

describe("esquema", () => {
  it("es idempotente", () => {
    expect(() => applySchema(db)).not.toThrow();
  });

  it("activa las claves foráneas", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => insertTrades(db, [makeTrade(0, { instrumentId: "no-existe" })])).toThrow();
  });
});

describe("velas", () => {
  it("inserta de forma idempotente gracias a la clave natural", () => {
    const base = Date.UTC(2024, 0, 2, 14, 30);
    const bars = Array.from({ length: 10 }, (_, i) => ({
      ts: base + i * MINUTE,
      open: 18000 + i,
      high: 18005 + i,
      low: 17995 + i,
      close: 18002 + i,
      tickVolume: 100,
      volume: 0,
      spread: 1,
    }));

    expect(insertBars(db, NAS100.id, "M1", bars)).toBe(10);
    // Reimportar el mismo rango no duplica nada.
    expect(insertBars(db, NAS100.id, "M1", bars)).toBe(0);
    expect(barCoverage(db, NAS100.id, "M1").count).toBe(10);
  });

  it("devuelve las velas en orden cronológico aunque se inserten desordenadas", () => {
    const base = Date.UTC(2024, 0, 2, 14, 30);
    const bar = (i: number) => ({
      ts: base + i * MINUTE,
      open: 1,
      high: 2,
      low: 0,
      close: 1,
      tickVolume: 1,
      volume: 0,
      spread: 0,
    });
    insertBars(db, NAS100.id, "M1", [bar(5), bar(1), bar(3)]);
    const loaded = loadBars(db, { instrumentId: NAS100.id, timeframe: "M1" });
    expect(loaded.map((b) => b.ts)).toEqual([base + MINUTE, base + 3 * MINUTE, base + 5 * MINUTE]);
  });

  it("detecta huecos en el histórico", () => {
    const base = Date.UTC(2024, 0, 2, 14, 30);
    const bar = (i: number) => ({ ts: base + i * MINUTE, open: 1, high: 1, low: 1, close: 1, tickVolume: 0, volume: 0, spread: 0 });
    insertBars(db, NAS100.id, "M1", [bar(0), bar(1), bar(2), bar(60), bar(61)]);
    const gaps = findGaps(db, { instrumentId: NAS100.id, timeframe: "M1" }, 5);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.minutes).toBe(58);
  });
});

describe("operaciones", () => {
  it("inserta lotes y cuenta con filtros", () => {
    const trades = Array.from({ length: 50 }, (_, i) => makeTrade(i));
    expect(insertTrades(db, trades)).toBe(50);
    expect(countTrades(db)).toBe(50);
    expect(countTrades(db, { direction: "long" })).toBe(25);
    expect(countTrades(db, { fromTs: trades[10]!.entryTs })).toBe(40);
  });

  it("proyecta columnas nativas y del blob JSON en la misma consulta", () => {
    insertTrades(db, [makeTrade(0), makeTrade(1)]);
    const rows = [...iterateTradeColumns(db, ["pnlMoney", "minuteOfDay", "volatility.atr14"])];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ pnlMoney: 10, minuteOfDay: 570, "volatility.atr14": 18 });
    expect(rows[1]!["volatility.atr14"]).toBe(19);
  });

  it("devuelve null para una feature ausente en vez de romper", () => {
    insertTrades(db, [makeTrade(0)]);
    const rows = [...iterateTradeColumns(db, ["no.existe"])];
    expect(rows[0]!["no.existe"]).toBeNull();
  });
});

describe("materialización", () => {
  it("crea columna generada e índice, y el resolver la usa", () => {
    insertTrades(db, Array.from({ length: 20 }, (_, i) => makeTrade(i)));
    const key = "volatility.atr14";

    expect(resolveFeatureExpression(db, key)).toContain("json_extract");
    const result = materializeFeature(db, key);
    expect(result.created).toBe(true);
    expect(result.column).toBe(materializedColumnName(key));
    expect(resolveFeatureExpression(db, key)).toBe(`"${result.column}"`);

    // La columna generada devuelve el mismo valor que el blob.
    const row = db.prepare(`SELECT "${result.column}" AS v FROM trades WHERE id = 't-5'`).get() as { v: number };
    expect(row.v).toBe(23);

    // Segunda llamada: idempotente.
    expect(materializeFeature(db, key).created).toBe(false);
  });

  it("el plan de consulta usa el índice tras materializar", () => {
    insertTrades(db, Array.from({ length: 20 }, (_, i) => makeTrade(i)));
    const { column } = materializeFeature(db, "volatility.atr14");
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM trades WHERE "${column}" > 25`).all() as {
      detail: string;
    }[];
    expect(plan.some((p) => p.detail.includes(`idx_${column}`))).toBe(true);
  });
});

describe("splits", () => {
  const training = {
    id: "train",
    name: "train-2022-2024",
    instrumentId: NAS100.id,
    role: "training" as const,
    startTs: Date.UTC(2022, 0, 1),
    endTs: Date.UTC(2025, 0, 1),
    embargoDays: 5,
    description: "",
  };

  it("rechaza una validación que solapa con el entrenamiento", () => {
    createSplit(db, training);
    expect(() =>
      createSplit(db, {
        id: "val",
        name: "val-2024",
        instrumentId: NAS100.id,
        role: "validation",
        startTs: Date.UTC(2024, 6, 1),
        endTs: Date.UTC(2025, 6, 1),
        embargoDays: 0,
        description: "",
      }),
    ).toThrow(/solapa/);
  });

  it("rechaza una validación dentro del periodo de embargo", () => {
    createSplit(db, training);
    expect(() =>
      createSplit(db, {
        id: "val",
        name: "val-2025",
        instrumentId: NAS100.id,
        // Empieza el 2 de enero: dentro de los 5 días de embargo.
        role: "validation",
        startTs: Date.UTC(2025, 0, 2),
        endTs: Date.UTC(2026, 0, 1),
        embargoDays: 0,
        description: "",
      }),
    ).toThrow(/solapa/);
  });

  it("acepta una validación posterior al embargo", () => {
    createSplit(db, training);
    const validation = createSplit(db, {
      id: "val",
      name: "val-2025",
      instrumentId: NAS100.id,
      role: "validation",
      startTs: Date.UTC(2025, 0, 10),
      endTs: Date.UTC(2026, 0, 1),
      embargoDays: 0,
      description: "",
    });
    expect(validation.evaluationCount).toBe(0);
    expect(listSplits(db, { instrumentId: NAS100.id })).toHaveLength(2);
  });

  it("cuenta cuántas veces se ha usado el split de validación", () => {
    createSplit(db, { ...training, id: "v", name: "v", role: "validation" });
    expect(recordEvaluation(db, "v")).toBe(1);
    expect(recordEvaluation(db, "v")).toBe(2);
  });
});

describe("hipótesis", () => {
  const trainingMetrics = summarize([10, -5, 8, -3, 12, -6, 9]);

  it("guarda, busca por id y por nombre, y rechaza nombres repetidos", () => {
    const h = createHypothesis(db, {
      name: "reversión de apertura",
      description: "prueba",
      predicateJson: '{"type":"compare","variable":"volatility.atr14","op":">","value":18}',
      variables: ["volatility.atr14"],
      criteria: { minTrades: 100 },
      trainingMetrics,
      searchSpaceSize: 500,
    });

    expect(h.status).toBe("training_passed");
    expect(getHypothesis(db, h.id)?.name).toBe("reversión de apertura");
    expect(getHypothesisByName(db, "reversión de apertura")?.id).toBe(h.id);
    expect(findHypothesis(db, h.id)?.id).toBe(h.id);
    expect(findHypothesis(db, "reversión de apertura")?.id).toBe(h.id);
    expect(findHypothesis(db, "no existe")).toBeNull();

    expect(() =>
      createHypothesis(db, {
        name: "reversión de apertura",
        predicateJson: "{}",
        variables: [],
        criteria: {},
        trainingMetrics,
        searchSpaceSize: 1,
      }),
    ).toThrow(/Ya existe/);
  });

  it("lista por estado y el cambio de estado se refleja de inmediato", () => {
    const h = createHypothesis(db, {
      name: "hipótesis B",
      predicateJson: "{}",
      variables: [],
      criteria: {},
      trainingMetrics,
      searchSpaceSize: 1,
    });

    expect(listHypotheses(db, { status: "training_passed" }).map((x) => x.id)).toContain(h.id);
    setHypothesisStatus(db, h.id, "validated");
    expect(getHypothesis(db, h.id)?.status).toBe("validated");
    expect(listHypotheses(db, { status: "training_passed" }).map((x) => x.id)).not.toContain(h.id);
    expect(listHypotheses(db, { status: "validated" }).map((x) => x.id)).toContain(h.id);
  });

  it("registra evaluaciones INMUTABLES contra un split, sin pisarlas", () => {
    const h = createHypothesis(db, {
      name: "hipótesis C",
      predicateJson: "{}",
      variables: [],
      criteria: {},
      trainingMetrics,
      searchSpaceSize: 1,
    });
    const split = createSplit(db, {
      id: "val-hip",
      name: "val-hip",
      instrumentId: NAS100.id,
      role: "validation",
      startTs: Date.UTC(2025, 0, 1),
      endTs: Date.UTC(2025, 6, 1),
      embargoDays: 0,
      description: "",
    });

    const validationMetrics = summarize([4, -2, 5]);
    const run = createValidationRun(db, {
      hypothesisId: h.id,
      splitId: split.id,
      metrics: validationMetrics,
      pValue: validationMetrics.pValue,
      qValue: validationMetrics.pValue,
      passed: true,
      notes: "cae dentro del IC de entrenamiento",
    });

    expect(run.passed).toBe(true);
    const runs = listValidationRuns(db, h.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.notes).toBe("cae dentro del IC de entrenamiento");
    expect(runs[0]!.metrics.count).toBe(3);

    // Una segunda evaluación se ACUMULA, no sustituye a la primera.
    createValidationRun(db, {
      hypothesisId: h.id,
      splitId: split.id,
      metrics: validationMetrics,
      pValue: 1,
      qValue: 1,
      passed: false,
      notes: "segunda mirada",
    });
    expect(listValidationRuns(db, h.id)).toHaveLength(2);
  });
});
