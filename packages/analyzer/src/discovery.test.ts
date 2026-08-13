import { describe, expect, it } from "vitest";
import { createRng, type VariableDefinition } from "@trf/shared";
import { buildRegistry } from "./guards.js";
import { matrixFromRows } from "./feature-matrix.js";
import { discoverPatterns } from "./discovery.js";
import { collectVariables } from "./predicate.js";

/**
 * CRITERIO DE ACEPTACIÓN DEL NIVEL 6 (docs/06-roadmap.md):
 *
 *   "en datos sintéticos CON patrón inyectado lo encuentra; en datos
 *    sintéticos SIN patrón no devuelve nada con q < 0,05."
 *
 * Estas dos pruebas son, literalmente, ese criterio.
 */

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
    key: "time.dayOfWeek",
    label: "Día de la semana",
    description: "",
    valueType: "categorical",
    causality: "predictor",
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
const registry = buildRegistry(definitions);

describe("discoverPatterns", () => {
  it("encuentra el patrón inyectado combinando dos variables", async () => {
    const n = 1000;
    // `dayOfWeek` se genera con un RNG con semilla propia, deliberadamente
    // INDEPENDIENTE de los índices que definen ATR y minuteOfDay. Usar
    // aritmética modular para las tres columnas (p.ej. i % 5 y i % 40) las
    // enlaza matemáticamente sin querer -- 40 es múltiplo de 5, así que
    // dayOfWeek acababa siendo un sustituto perfecto del ATR por coincidencia
    // aritmética, no por señal real. Con un flujo aleatorio aparte, dayOfWeek
    // es puro ruido de verdad: el motor no debe usarlo para nada.
    const noiseRng = createRng(99);
    const rows = Array.from({ length: n }, (_, i) => {
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
          "time.dayOfWeek": 1 + noiseRng.nextInt(5),
        } as Record<string, number | null>,
      };
    });
    const matrix = matrixFromRows(rows, ["volatility.atr", "time.minuteOfDay", "time.dayOfWeek"]);

    const report = await discoverPatterns(matrix, ["volatility.atr", "time.minuteOfDay", "time.dayOfWeek"], registry, {
      minTrades: 50,
      minWinRate: 0.9,
      minProfitFactor: 2,
      maxConditions: 2,
      top: 10,
    });

    expect(report.searchSpaceSize).toBeGreaterThan(0);
    expect(report.level1Survivors).toBeGreaterThan(0);
    expect(report.results.length).toBeGreaterThan(0);

    const best = report.results[0]!;
    expect(best.qValue).toBeLessThan(0.05);
    expect(best.metrics.winRate).toBeGreaterThanOrEqual(0.9);
    expect(best.metrics.expectancy).toBeGreaterThan(25);
    // El mejor resultado debe usar las dos variables del patrón inyectado, no una sola.
    const usedVariables = collectVariables(best.predicate);
    expect(usedVariables).toContain("volatility.atr");
    expect(usedVariables).toContain("time.minuteOfDay");
  });

  it("no encuentra nada significativo (q < 0,05) cuando los datos son puro ruido", async () => {
    const rng = createRng(7);
    const n = 600;
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      entryTs: Date.UTC(2024, 0, 2) + i * 60_000,
      // Ruido gaussiano, sin relación alguna con las variables.
      pnl: rng.nextGaussian() * 20,
      features: {
        "volatility.atr": 10 + rng.nextInt(40),
        "time.minuteOfDay": 570 + rng.nextInt(8) * 15,
        "time.dayOfWeek": 1 + rng.nextInt(5),
      } as Record<string, number | null>,
    }));
    const matrix = matrixFromRows(rows, ["volatility.atr", "time.minuteOfDay", "time.dayOfWeek"]);

    const report = await discoverPatterns(matrix, ["volatility.atr", "time.minuteOfDay", "time.dayOfWeek"], registry, {
      minTrades: 30,
      minWinRate: 0.6,
      minProfitFactor: 1.5,
      maxConditions: 3,
      top: 20,
    });

    expect(report.searchSpaceSize).toBeGreaterThan(0);
    // Puede que algún cruce cumpla los umbrales crudos por puro azar, pero
    // NINGUNO debe sobrevivir a la corrección por multiplicidad.
    for (const result of report.results) {
      expect(result.qValue).toBeGreaterThanOrEqual(0.05);
    }
  });

  it("rechaza variables que no son predictoras", async () => {
    const matrix = matrixFromRows(
      [{ id: "t0", entryTs: 0, pnl: 1, features: { mae: 5 } }],
      ["mae"],
    );
    await expect(discoverPatterns(matrix, ["mae"], registry, { minTrades: 1 })).rejects.toThrow(/predictora/);
  });
});
