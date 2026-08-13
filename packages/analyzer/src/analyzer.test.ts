import { describe, expect, it } from "vitest";
import type { Bar, VariableDefinition } from "@trf/shared";
import {
  and,
  between,
  collectVariables,
  complexity,
  describe as describePredicate,
  eq,
  gt,
  isNull,
  lt,
  not,
  oneOf,
  or,
  parsePredicate,
  serializePredicate,
  validatePredicate,
} from "./predicate.js";
import { compileMask, countMask, evaluateCohort, splitStability } from "./cohort.js";
import { matrixFromRows } from "./feature-matrix.js";
import { analyzeVariable, computeEdges } from "./marginal.js";
import { assertHypothesisSafe, buildRegistry, inspectPredicate, predictorKeys } from "./guards.js";
import { TradeSimulator } from "./simulator.js";
import { TimeframeAggregator } from "./timeframe.js";

// ---------------------------------------------------------------------------
// Datos de prueba
// ---------------------------------------------------------------------------

/**
 * 400 operaciones con un patrón deliberado: cuando `atr > 20` Y la hora es 570,
 * el resultado es sistemáticamente positivo. El resto es ruido simétrico.
 */
function buildMatrix() {
  const rows = Array.from({ length: 400 }, (_, i) => {
    const atr = 10 + (i % 40);
    const minuteOfDay = i % 4 === 0 ? 570 : 600 + (i % 3);
    const enPatron = atr > 20 && minuteOfDay === 570;
    const pnl = enPatron ? 30 + (i % 5) : ((i % 7) - 3) * 10;
    return {
      id: `t${i}`,
      entryTs: Date.UTC(2024, 0, 2) + i * 60_000,
      pnl,
      features: {
        "volatility.atr": atr,
        "time.minuteOfDay": minuteOfDay,
        "time.dayOfWeek": (i % 5) + 1,
        "market.gapPoints": i % 3 === 0 ? null : i % 11,
      } as Record<string, number | null>,
    };
  });
  return matrixFromRows(rows, ["volatility.atr", "time.minuteOfDay", "time.dayOfWeek", "market.gapPoints"]);
}

const definitions: VariableDefinition[] = [
  {
    key: "volatility.atr",
    label: "ATR",
    description: "",
    valueType: "continuous",
    causality: "predictor",
    unit: "points",
    producedBy: "core-volatility",
    producerVersion: "1.0.0",
  },
  {
    key: "time.minuteOfDay",
    label: "Minuto del día",
    description: "",
    valueType: "ordinal",
    causality: "predictor",
    unit: "minutes",
    producedBy: "core-time",
    producerVersion: "1.0.0",
  },
  {
    key: "time.year",
    label: "Año",
    description: "",
    valueType: "ordinal",
    causality: "meta",
    unit: "",
    producedBy: "core-time",
    producerVersion: "1.0.0",
  },
  {
    key: "mae",
    label: "MAE",
    description: "",
    valueType: "continuous",
    causality: "outcome",
    unit: "points",
    producedBy: "core",
    producerVersion: "1.0.0",
  },
];

// ---------------------------------------------------------------------------

describe("predicados", () => {
  it("aplana y simplifica al construir", () => {
    const predicate = and(gt("a.x", 1), and(lt("a.y", 2), gt("a.z", 3)));
    expect(predicate.type).toBe("and");
    expect(complexity(predicate)).toBe(3);
    expect(collectVariables(predicate)).toEqual(["a.x", "a.y", "a.z"]);
  });

  it("and() con un solo operando devuelve el operando", () => {
    expect(and(gt("a.x", 1)).type).toBe("compare");
    expect(and().type).toBe("always");
  });

  it("sobrevive a la serialización", () => {
    const predicate = or(and(gt("a.x", 1), between("a.y", 0, 5)), not(oneOf("a.z", [1, 2, 3])));
    const restored = parsePredicate(serializePredicate(predicate));
    expect(restored).toEqual(predicate);
  });

  it("rechaza predicados malformados", () => {
    expect(() => validatePredicate({ type: "compare", variable: "a.x", op: "≈", value: 1 })).toThrow(/Operador/);
    expect(() => validatePredicate({ type: "compare", variable: "", op: ">", value: 1 })).toThrow(/cadena/);
    expect(() => validatePredicate({ type: "inventado" })).toThrow(/desconocido/);
  });

  it("se describe en lenguaje legible", () => {
    const labels = new Map([["volatility.atr", "ATR"]]);
    const text = describePredicate(and(gt("volatility.atr", 18), eq("time.minuteOfDay", 570)), labels);
    expect(text).toBe("ATR > 18 Y time.minuteOfDay == 570");
  });
});

describe("máscaras y cohortes", () => {
  const matrix = buildMatrix();

  it("filtra por una condición simple", () => {
    const mask = compileMask(matrix, gt("volatility.atr", 20));
    expect(countMask(mask)).toBeGreaterThan(0);
    expect(countMask(mask)).toBeLessThan(matrix.size);
  });

  it("encuentra el patrón inyectado con una conjunción", () => {
    const patron = and(gt("volatility.atr", 20), eq("time.minuteOfDay", 570));
    const resultado = evaluateCohort(matrix, patron);
    expect(resultado.metrics.count).toBeGreaterThan(20);
    expect(resultado.metrics.winRate).toBe(1);
    expect(resultado.metrics.expectancy).toBeGreaterThan(25);
    expect(resultado.coverage).toBeLessThan(0.5);

    // La población completa NO tiene ese comportamiento.
    const total = evaluateCohort(matrix, { type: "always" });
    expect(total.metrics.expectancy).toBeLessThan(resultado.metrics.expectancy);
  });

  it("trata los nulos como condición falsa, igual que SQL", () => {
    const conValor = compileMask(matrix, gt("market.gapPoints", -1000));
    const nulos = compileMask(matrix, isNull("market.gapPoints"));
    expect(countMask(conValor) + countMask(nulos)).toBe(matrix.size);
    // Un nulo no entra ni en "> x" ni en "<= x".
    const complemento = compileMask(matrix, lt("market.gapPoints", -1000));
    expect(countMask(complemento)).toBe(0);
  });

  it("la negación excluye también los nulos que no cumplen", () => {
    const directa = compileMask(matrix, gt("volatility.atr", 20));
    const negada = compileMask(matrix, not(gt("volatility.atr", 20)));
    expect(countMask(directa) + countMask(negada)).toBe(matrix.size);
  });

  it("or() une y and() intersecta", () => {
    const a = eq("time.dayOfWeek", 1);
    const b = eq("time.dayOfWeek", 2);
    expect(countMask(compileMask(matrix, or(a, b)))).toBe(
      countMask(compileMask(matrix, a)) + countMask(compileMask(matrix, b)),
    );
    expect(countMask(compileMask(matrix, and(a, b)))).toBe(0);
  });

  it("mide la estabilidad entre mitades temporales", () => {
    const mask = compileMask(matrix, { type: "always" });
    const estabilidad = splitStability(matrix, mask);
    expect(estabilidad.first.count + estabilidad.second.count).toBe(matrix.size);
  });
});

describe("guardas anti-lookahead", () => {
  const registry = buildRegistry(definitions);

  it("bloquea las variables de resultado", () => {
    expect(() => assertHypothesisSafe(and(eq("time.minuteOfDay", 570), lt("mae", 25)), registry)).toThrow(
      /variables de RESULTADO|no pueden formar parte/,
    );
  });

  it("bloquea también las columnas nativas de resultado no registradas", () => {
    expect(() => assertHypothesisSafe(gt("mfe", 10), registry)).toThrow();
    expect(() => assertHypothesisSafe(lt("durationMinutes", 30), registry)).toThrow();
  });

  it("bloquea las variables meta como el año", () => {
    const violaciones = inspectPredicate(eq("time.year", 2023), registry);
    expect(violaciones[0]!.causality).toBe("meta");
  });

  it("bloquea variables desconocidas", () => {
    expect(inspectPredicate(gt("inventada.x", 1), registry)[0]!.causality).toBe("unknown");
  });

  it("permite predictores legítimos", () => {
    expect(() =>
      assertHypothesisSafe(and(eq("time.minuteOfDay", 570), gt("volatility.atr", 18)), registry),
    ).not.toThrow();
  });

  it("permite variables de resultado en modo diagnóstico", () => {
    expect(() => assertHypothesisSafe(lt("mae", 25), registry, { purpose: "diagnostic" })).not.toThrow();
  });

  it("predictorKeys deja fuera meta y outcome", () => {
    expect(predictorKeys(definitions)).toEqual(["time.minuteOfDay", "volatility.atr"]);
  });
});

describe("análisis marginal", () => {
  const matrix = buildMatrix();

  it("calcula cortes por cuantiles sin duplicados", () => {
    const edges = computeEdges(matrix, "volatility.atr", { kind: "quantile", count: 4 }, 5);
    expect(edges.length).toBeGreaterThan(0);
    for (let i = 1; i < edges.length; i++) expect(edges[i]!).toBeGreaterThan(edges[i - 1]!);
  });

  it("respeta los cortes explícitos de la definición", () => {
    expect(computeEdges(matrix, "volatility.atr", { kind: "edges", edges: [15, 25, 35] }, 5)).toEqual([15, 25, 35]);
  });

  it("detecta el tramo con más señal", () => {
    const analisis = analyzeVariable(matrix, "time.minuteOfDay", definitions[1] as VariableDefinition, {
      minCount: 10,
    });
    expect(analisis.bestBucket).not.toBeNull();
    expect(analisis.bestBucket!.metrics.expectancy).toBeGreaterThan(analisis.baseline.expectancy);
    const suma = analisis.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(suma).toBe(matrix.size);
  });

  it("crea un tramo separado para los nulos", () => {
    const analisis = analyzeVariable(matrix, "market.gapPoints", null, { minCount: 5 });
    const nulos = analisis.buckets.find((b) => b.label === "sin valor");
    expect(nulos).toBeDefined();
    expect(nulos!.count).toBe(analisis.nullCount);
    // El tramo de nulos nunca se propone como mejor.
    expect(analisis.bestBucket?.label).not.toBe("sin valor");
  });
});

// ---------------------------------------------------------------------------

const instrument = {
  id: "nas100",
  symbol: "NAS100",
  description: "",
  sessionTimezone: "America/New_York",
  tickSize: 0.1,
  pointValue: 1,
  regularSessionOpenMinute: 570,
  regularSessionCloseMinute: 960,
};

function bar(ts: number, o: number, h: number, l: number, c: number): Bar {
  return { ts, open: o, high: h, low: l, close: c, tickVolume: 100, volume: 0, spread: 1 };
}

const SIN_COSTES = { spreadPoints: 0, slippagePoints: 0, commissionMoney: 0 };

describe("simulador", () => {
  const signal = { direction: "long" as const, takeProfitPoints: 10, stopLossPoints: 5, maxHoldMinutes: 60 };
  const t0 = Date.UTC(2024, 6, 15, 13, 30);

  it("cierra en take profit", () => {
    const sim = new TradeSimulator({ instrument, costs: SIN_COSTES });
    sim.openPosition(signal, bar(t0, 100, 100, 100, 100), "regla");
    const closed = sim.onBar(bar(t0 + 60_000, 100, 111, 99, 110));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe("take_profit");
    expect(closed[0]!.pnlPoints).toBeCloseTo(10, 10);
  });

  it("cierra en stop loss", () => {
    const sim = new TradeSimulator({ instrument, costs: SIN_COSTES });
    sim.openPosition(signal, bar(t0, 100, 100, 100, 100), "regla");
    const closed = sim.onBar(bar(t0 + 60_000, 100, 102, 94, 95));
    expect(closed[0]!.exitReason).toBe("stop_loss");
    expect(closed[0]!.pnlPoints).toBeCloseTo(-5, 10);
  });

  it("ante ambigüedad intrabar asume el stop (hipótesis pesimista)", () => {
    const sim = new TradeSimulator({ instrument, costs: SIN_COSTES });
    sim.openPosition(signal, bar(t0, 100, 100, 100, 100), "regla");
    // La vela toca 111 (TP) y 94 (SL): no se sabe el orden.
    const closed = sim.onBar(bar(t0 + 60_000, 100, 111, 94, 105));
    expect(closed[0]!.exitReason).toBe("stop_loss");
  });

  it("cierra por límite de tiempo", () => {
    const sim = new TradeSimulator({ instrument, costs: SIN_COSTES });
    sim.openPosition({ ...signal, maxHoldMinutes: 2 }, bar(t0, 100, 100, 100, 100), "regla");
    expect(sim.onBar(bar(t0 + 60_000, 100, 101, 99, 100))).toHaveLength(0);
    const closed = sim.onBar(bar(t0 + 120_000, 100, 101, 99, 100.5));
    expect(closed[0]!.exitReason).toBe("time_limit");
    expect(closed[0]!.durationMinutes).toBe(2);
  });

  it("los costes empeoran la entrada, nunca la mejoran", () => {
    const sim = new TradeSimulator({
      instrument,
      costs: { spreadPoints: 2, slippagePoints: 0.5, commissionMoney: 1 },
    });
    const largo = sim.openPosition(signal, bar(t0, 100, 100, 100, 100), "regla");
    expect(largo.entryPrice).toBeCloseTo(101.5, 10);

    const corto = sim.openPosition({ ...signal, direction: "short" }, bar(t0, 100, 100, 100, 100), "regla");
    expect(corto.entryPrice).toBeCloseTo(98.5, 10);
  });

  it("mide MAE, MFE y el momento en que ocurren", () => {
    const sim = new TradeSimulator({ instrument, costs: SIN_COSTES });
    sim.openPosition({ ...signal, takeProfitPoints: null, stopLossPoints: null, maxHoldMinutes: 3 }, bar(t0, 100, 100, 100, 100), "regla");
    sim.onBar(bar(t0 + 60_000, 100, 103, 97, 101)); // MFE 3, MAE 3
    sim.onBar(bar(t0 + 120_000, 101, 108, 100, 107)); // MFE 8 a los 2 min
    const closed = sim.onBar(bar(t0 + 180_000, 107, 107, 92, 95)); // MAE 8 a los 3 min

    expect(closed[0]!.excursion.mfe).toBeCloseTo(8, 10);
    expect(closed[0]!.excursion.minutesToMfe).toBe(2);
    expect(closed[0]!.excursion.mae).toBeCloseTo(8, 10);
    expect(closed[0]!.excursion.minutesToMae).toBe(3);
    expect(closed[0]!.excursion.efficiency).toBeCloseTo(-5 / 8, 10);
  });

  it("una posición sin salida se cierra al final del histórico", () => {
    const sim = new TradeSimulator({ instrument, costs: SIN_COSTES });
    sim.openPosition({ ...signal, takeProfitPoints: null, stopLossPoints: null, maxHoldMinutes: 10_000 }, bar(t0, 100, 100, 100, 100), "regla");
    const closed = sim.flush(bar(t0 + 600_000, 100, 100, 100, 123));
    expect(closed[0]!.exitReason).toBe("session_end");
    expect(closed[0]!.pnlPoints).toBeCloseTo(23, 10);
  });
});

describe("agregación de timeframes", () => {
  it("construye velas M5 a partir de M1", () => {
    const aggregator = new TimeframeAggregator("M5", "America/New_York");
    const base = Date.UTC(2024, 6, 15, 13, 30);
    const emitidas: Bar[] = [];
    for (let i = 0; i < 12; i++) {
      const closed = aggregator.push(bar(base + i * 60_000, 100 + i, 105 + i, 95 + i, 102 + i));
      if (closed !== null) emitidas.push(closed);
    }

    expect(emitidas).toHaveLength(2);
    expect(emitidas[0]!.open).toBe(100);
    expect(emitidas[0]!.close).toBe(106);
    expect(emitidas[0]!.high).toBe(109);
    expect(emitidas[0]!.low).toBe(95);
    expect(emitidas[0]!.tickVolume).toBe(500);
    expect(emitidas[1]!.ts - emitidas[0]!.ts).toBe(5 * 60_000);
  });

  it("flush cierra la vela en curso", () => {
    const aggregator = new TimeframeAggregator("M15", "America/New_York");
    aggregator.push(bar(Date.UTC(2024, 6, 15, 13, 30), 100, 101, 99, 100));
    expect(aggregator.flush()?.open).toBe(100);
    expect(aggregator.flush()).toBeNull();
  });
});
