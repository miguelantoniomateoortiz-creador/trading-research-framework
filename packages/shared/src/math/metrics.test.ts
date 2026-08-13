import { describe, expect, it } from "vitest";
import { EMPTY_METRICS, equityCurve, profitFactorOf, summarize } from "./metrics.js";

describe("summarize", () => {
  it("devuelve métricas vacías para una cohorte sin operaciones", () => {
    expect(summarize([])).toEqual(EMPTY_METRICS);
  });

  it("calcula conteos, win rate y profit factor", () => {
    const pnl = [100, -50, 100, -50, 100];
    const m = summarize(pnl);
    expect(m.count).toBe(5);
    expect(m.wins).toBe(3);
    expect(m.losses).toBe(2);
    expect(m.winRate).toBeCloseTo(0.6, 12);
    expect(m.grossProfit).toBe(300);
    expect(m.grossLoss).toBe(100);
    expect(m.netProfit).toBe(200);
    expect(m.profitFactor).toBeCloseTo(3, 12);
    expect(m.expectancy).toBeCloseTo(40, 12);
    expect(m.payoffRatio).toBeCloseTo(2, 12);
  });

  it("no cuenta los break-even en el win rate", () => {
    const m = summarize([100, 0, -100, 0]);
    expect(m.breakEven).toBe(2);
    expect(m.winRate).toBeCloseTo(0.5, 12);
  });

  it("marca profit factor infinito cuando no hay pérdidas", () => {
    expect(summarize([1, 2, 3]).profitFactor).toBe(Number.POSITIVE_INFINITY);
  });

  it("calcula el drawdown máximo y su duración", () => {
    // equity: 100, 60, 20, 120 -> pico 100 en índice 0, valle 20 en índice 2
    const m = summarize([100, -40, -40, 100]);
    expect(m.maxDrawdown).toBeCloseTo(80, 12);
    expect(m.maxDrawdownPct).toBeCloseTo(0.8, 12);
    expect(m.maxDrawdownLength).toBe(2);
  });

  it("no reporta drawdown en una serie monótona creciente", () => {
    const m = summarize([10, 10, 10, 10]);
    expect(m.maxDrawdown).toBe(0);
    expect(m.maxDrawdownPct).toBe(0);
  });

  it("mide rachas consecutivas", () => {
    const m = summarize([1, 1, 1, -1, -1, 1, -1, -1, -1, -1]);
    expect(m.maxConsecutiveWins).toBe(3);
    expect(m.maxConsecutiveLosses).toBe(4);
  });

  it("da equityR2 alto a un edge estable y bajo a uno concentrado", () => {
    const estable = Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? -8 : 4));
    const concentrado = Array.from({ length: 200 }, (_, i) => (i === 100 ? 400 : -1));
    expect(summarize(estable).equityR2).toBeGreaterThan(0.95);
    expect(summarize(concentrado).equityR2).toBeLessThan(summarize(estable).equityR2);
  });

  it("el drawdown depende del orden pero el net profit no", () => {
    const a = summarize([-100, 50, 50, 50]);
    const b = summarize([50, 50, 50, -100]);
    expect(a.netProfit).toBeCloseTo(b.netProfit, 12);
    // Para esta serie concreta el drawdown ABSOLUTO coincide por casualidad
    // en ambos órdenes (100 en los dos casos), aunque el mecanismo es
    // distinto: en "a" se cae desde un pico de 0 nada más empezar; en "b" se
    // cae desde un pico de 150 acumulado. El porcentaje respecto al pico sí
    // distingue ambos casos, y es la métrica que de verdad importa para el
    // riesgo: perder 100 desde una base de 0 no es lo mismo que perderlos
    // desde una racha de 150.
    expect(a.maxDrawdownPct).not.toBeCloseTo(b.maxDrawdownPct, 6);
    expect(a.maxDrawdownLength).not.toBe(b.maxDrawdownLength);
  });
});

describe("utilidades", () => {
  it("equityCurve acumula", () => {
    expect(Array.from(equityCurve([1, 2, 3]))).toEqual([1, 3, 6]);
  });

  it("profitFactorOf coincide con summarize", () => {
    const pnl = [5, -2, 7, -3, -1];
    expect(profitFactorOf(pnl)).toBeCloseTo(summarize(pnl).profitFactor, 12);
  });
});
