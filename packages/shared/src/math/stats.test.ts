import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  binomialTailProbability,
  bootstrapInterval,
  incompleteBeta,
  linearRegression,
  mean,
  normalCdf,
  normalQuantile,
  pearson,
  quantile,
  stdDev,
  studentTCdf,
  tTestAgainstZero,
  wilsonInterval,
} from "./stats.js";

describe("descriptiva", () => {
  it("calcula media y desviación típica muestral", () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(xs)).toBe(5);
    // sd poblacional = 2, muestral = 2 * sqrt(8/7)
    expect(stdDev(xs)).toBeCloseTo(2 * Math.sqrt(8 / 7), 10);
  });

  it("usa interpolación lineal para los cuantiles (método 7)", () => {
    const xs = [1, 2, 3, 4];
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(4);
    expect(quantile(xs, 0.5)).toBeCloseTo(2.5, 12);
    expect(quantile(xs, 0.25)).toBeCloseTo(1.75, 12);
  });

  it("acepta Float64Array igual que arrays", () => {
    expect(mean(Float64Array.from([1, 2, 3]))).toBe(2);
  });

  it("calcula correlación y regresión sobre una relación exacta", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 3 * x + 7);
    expect(pearson(xs, ys)).toBeCloseTo(1, 12);
    const fit = linearRegression(xs, ys);
    expect(fit.slope).toBeCloseTo(3, 12);
    expect(fit.intercept).toBeCloseTo(7, 12);
    expect(fit.r2).toBeCloseTo(1, 12);
  });
});

describe("distribuciones", () => {
  it("normalCdf coincide con valores tabulados", () => {
    // erf() usa la aproximación de Abramowitz & Stegun 7.1.26, con un error
    // máximo documentado de 1.5e-7: pedir más de 6 decimales exactos aquí
    // estaría probando la aproximación, no la función.
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 5);
  });

  it("normalQuantile es la inversa de normalCdf", () => {
    for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975, 0.99]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 5);
    }
  });

  it("incompleteBeta cumple la simetría I_x(a,b) = 1 - I_{1-x}(b,a)", () => {
    expect(incompleteBeta(0.3, 2, 5)).toBeCloseTo(1 - incompleteBeta(0.7, 5, 2), 10);
    expect(incompleteBeta(0.5, 1, 1)).toBeCloseTo(0.5, 10);
  });

  it("studentTCdf coincide con los valores de referencia", () => {
    // Valores de scipy.stats.t.cdf, redondeados a 6 decimales.
    expect(studentTCdf(2.228, 10)).toBeCloseTo(0.974994, 4);
    expect(studentTCdf(1.96, 30)).toBeCloseTo(0.970329, 4);
    expect(studentTCdf(1.96, 100)).toBeCloseTo(0.973611, 4);
    expect(studentTCdf(1.96, 1000)).toBeCloseTo(0.974863, 4);
  });

  it("studentTCdf converge a la normal al crecer df", () => {
    const diff30 = Math.abs(studentTCdf(1.96, 30) - normalCdf(1.96));
    const diff5000 = Math.abs(studentTCdf(1.96, 5000) - normalCdf(1.96));
    expect(diff5000).toBeLessThan(diff30);
  });

  it("studentTCdf es simétrica alrededor de cero", () => {
    for (const df of [3, 10, 60]) {
      expect(studentTCdf(-1.5, df)).toBeCloseTo(1 - studentTCdf(1.5, df), 10);
    }
    expect(studentTCdf(0, 7)).toBeCloseTo(0.5, 10);
  });
});

describe("inferencia", () => {
  it("el intervalo de Wilson nunca se sale de [0,1]", () => {
    const ci = wilsonInterval(10, 10);
    expect(ci.lower).toBeGreaterThan(0.65);
    expect(ci.upper).toBeLessThanOrEqual(1);
  });

  it("el intervalo de Wilson se estrecha al crecer la muestra", () => {
    const small = wilsonInterval(19, 20);
    const large = wilsonInterval(1900, 2000);
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
  });

  it("binomialTailProbability es exacta en casos conocidos", () => {
    // P(X >= 10 | n=10, p=0.5) = 1/1024
    expect(binomialTailProbability(10, 10, 0.5)).toBeCloseTo(1 / 1024, 12);
    // P(X >= 1 | n=1, p=0.3) = 0.3
    expect(binomialTailProbability(1, 1, 0.3)).toBeCloseTo(0.3, 12);
  });

  it("detecta una media distinta de cero con el t-test", () => {
    const noise = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 0.5);
    const shifted = noise.map((x) => x + 2);
    expect(tTestAgainstZero(noise).pOneSided).toBeGreaterThan(0.05);
    expect(tTestAgainstZero(shifted).pOneSided).toBeLessThan(0.001);
  });

  it("Benjamini-Hochberg es monótono y no reduce ningún p-valor", () => {
    const ps = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205];
    const qs = benjaminiHochberg(ps);
    expect(qs).toHaveLength(ps.length);
    for (let i = 0; i < ps.length; i++) {
      expect(qs[i]!).toBeGreaterThanOrEqual(ps[i]!);
      expect(qs[i]!).toBeLessThanOrEqual(1);
    }
    // El orden se conserva respecto a los p-valores ordenados.
    for (let i = 1; i < qs.length; i++) {
      expect(qs[i]!).toBeGreaterThanOrEqual(qs[i - 1]! - 1e-12);
    }
  });

  it("el bootstrap es reproducible con la misma semilla", () => {
    const xs = Array.from({ length: 300 }, (_, i) => ((i * 37) % 41) - 20);
    const a = bootstrapInterval(xs, (s) => mean(s), { seed: 7, iterations: 400 });
    const b = bootstrapInterval(xs, (s) => mean(s), { seed: 7, iterations: 400 });
    expect(a.lower).toBe(b.lower);
    expect(a.upper).toBe(b.upper);
    expect(a.lower).toBeLessThan(a.upper);
  });
});
