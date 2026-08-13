/**
 * Estadística sin dependencias externas.
 *
 * Todo trabaja sobre `ArrayLike<number>` para aceptar tanto `number[]` como
 * `Float64Array` (la matriz columnar del analizador usa lo segundo).
 */

import { createRng } from "./random.js";

// ---------------------------------------------------------------------------
// Descriptiva
// ---------------------------------------------------------------------------

export function mean(xs: ArrayLike<number>): number {
  if (xs.length === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += xs[i] as number;
  return sum / xs.length;
}

/** Varianza muestral (denominador n-1). */
export function variance(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 2) return Number.NaN;
  // Welford: numéricamente estable con series largas de P&L.
  let m = 0;
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] as number;
    const delta = x - m;
    m += delta / (i + 1);
    m2 += delta * (x - m);
  }
  return m2 / (n - 1);
}

export function stdDev(xs: ArrayLike<number>): number {
  return Math.sqrt(variance(xs));
}

export function sum(xs: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < xs.length; i++) total += xs[i] as number;
  return total;
}

/**
 * Cuantil por interpolación lineal (método 7 de R, el mismo que numpy).
 * `xs` NO necesita estar ordenado: se copia y ordena internamente.
 */
export function quantile(xs: ArrayLike<number>, p: number): number {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  const sorted = Float64Array.from(xs as ArrayLike<number>);
  sorted.sort();
  return quantileSorted(sorted, p);
}

/** Igual que `quantile` pero asume entrada ya ordenada ascendente. */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0] as number;
  const clamped = Math.min(1, Math.max(0, p));
  const pos = (n - 1) * clamped;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const weight = pos - lo;
  return (sorted[lo] as number) * (1 - weight) + (sorted[hi] as number) * weight;
}

export function median(xs: ArrayLike<number>): number {
  return quantile(xs, 0.5);
}

/** Correlación de Pearson. Devuelve NaN si alguna serie es constante. */
export function pearson(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return Number.NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom === 0 ? Number.NaN : sxy / denom;
}

export interface LinearFit {
  readonly slope: number;
  readonly intercept: number;
  /** Coeficiente de determinación. */
  readonly r2: number;
}

/** Regresión lineal por mínimos cuadrados de `ys` sobre `xs`. */
export function linearRegression(xs: ArrayLike<number>, ys: ArrayLike<number>): LinearFit {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: Number.NaN, intercept: Number.NaN, r2: Number.NaN };
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, intercept: my, r2: 0 };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

// ---------------------------------------------------------------------------
// Distribuciones
// ---------------------------------------------------------------------------

/** Función error, aproximación de Abramowitz & Stegun 7.1.26 (|err| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** CDF de la normal estándar. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Cuantil de la normal estándar (Acklam, refinado con una pasada de Halley). */
export function normalQuantile(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      ((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q + (c[5] as number)) /
      (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] as number) * r + (a[1] as number)) * r + (a[2] as number)) * r + (a[3] as number)) * r + (a[4] as number)) * r + (a[5] as number)) * q /
      ((((((b[0] as number) * r + (b[1] as number)) * r + (b[2] as number)) * r + (b[3] as number)) * r + (b[4] as number)) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q + (c[3] as number)) * q + (c[4] as number)) * q + (c[5] as number)) /
      (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) * q + 1);
  }
  return x;
}

/** log Γ(x) — Lanczos g=7, n=9. */
export function logGamma(x: number): number {
  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = coef[0] as number;
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += (coef[i] as number) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Función beta incompleta regularizada I_x(a, b), por fracción continua. */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  if (x < (a + 1) / (a + b + 2)) {
    return (Math.exp(lbeta) * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (Math.exp(lbeta) * betaContinuedFraction(1 - x, b, a)) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  const maxIter = 300;
  const eps = 3e-14;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

/** CDF de la t de Student con `df` grados de libertad. */
export function studentTCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const p = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - p : p;
}

// ---------------------------------------------------------------------------
// Inferencia
// ---------------------------------------------------------------------------

export interface ConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
  readonly level: number;
}

/**
 * Intervalo de Wilson para una proporción.
 *
 * Se usa en vez del intervalo normal (Wald) porque con win rates extremos
 * (>90%, que es justo lo que busca el motor de descubrimiento) Wald da límites
 * absurdos, incluso por encima de 1. Wilson se comporta bien en las colas.
 */
export function wilsonInterval(successes: number, trials: number, level = 0.95): ConfidenceInterval {
  if (trials === 0) return { lower: 0, upper: 1, level };
  const z = normalQuantile(1 - (1 - level) / 2);
  const phat = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (phat + z2 / (2 * trials)) / denom;
  const halfWidth = (z * Math.sqrt((phat * (1 - phat)) / trials + z2 / (4 * trials * trials))) / denom;
  return { lower: Math.max(0, center - halfWidth), upper: Math.min(1, center + halfWidth), level };
}

/**
 * p-valor de una cola: P(X >= successes) bajo Binomial(trials, p0).
 * Exacto hasta 20.000 ensayos; por encima, aproximación normal con corrección
 * de continuidad (el error es despreciable a esa escala).
 */
export function binomialTailProbability(successes: number, trials: number, p0: number): number {
  if (trials === 0) return 1;
  if (successes <= 0) return 1;
  if (trials <= 20_000) {
    let total = 0;
    const logP = Math.log(p0);
    const logQ = Math.log(1 - p0);
    const logNFact = logGamma(trials + 1);
    for (let k = successes; k <= trials; k++) {
      const logPmf = logNFact - logGamma(k + 1) - logGamma(trials - k + 1) + k * logP + (trials - k) * logQ;
      total += Math.exp(logPmf);
    }
    return Math.min(1, total);
  }
  const mu = trials * p0;
  const sigma = Math.sqrt(trials * p0 * (1 - p0));
  return 1 - normalCdf((successes - 0.5 - mu) / sigma);
}

export interface TTestResult {
  readonly t: number;
  readonly df: number;
  /** p-valor de una cola (H1: media > 0). */
  readonly pOneSided: number;
  readonly pTwoSided: number;
}

/** t-test de una muestra contra media 0. Se usa sobre el P&L por operación. */
export function tTestAgainstZero(xs: ArrayLike<number>): TTestResult {
  const n = xs.length;
  if (n < 2) return { t: Number.NaN, df: 0, pOneSided: 1, pTwoSided: 1 };
  const m = mean(xs);
  const s = stdDev(xs);
  if (s === 0 || !Number.isFinite(s)) {
    return { t: m > 0 ? Infinity : 0, df: n - 1, pOneSided: m > 0 ? 0 : 1, pTwoSided: m > 0 ? 0 : 1 };
  }
  const t = m / (s / Math.sqrt(n));
  const df = n - 1;
  const pOneSided = 1 - studentTCdf(t, df);
  return { t, df, pOneSided, pTwoSided: Math.min(1, 2 * Math.min(pOneSided, 1 - pOneSided)) };
}

/**
 * Corrección de Benjamini-Hochberg (control del FDR).
 *
 * Imprescindible: el motor de descubrimiento evalúa decenas de miles de
 * combinaciones. Con 10.000 pruebas y α=0.05, ~500 "patrones significativos"
 * son puro ruido. BH devuelve q-valores que sí se pueden interpretar.
 *
 * @returns q-valores en el mismo orden que la entrada.
 */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const n = pValues.length;
  if (n === 0) return [];
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);

  const q = new Array<number>(n);
  let previous = 1;
  for (let rank = n; rank >= 1; rank--) {
    const entry = indexed[rank - 1] as { p: number; i: number };
    const value = Math.min(previous, (entry.p * n) / rank);
    previous = value;
    q[entry.i] = Math.min(1, value);
  }
  return q;
}

/**
 * Intervalo de confianza por bootstrap percentil.
 *
 * Necesario para métricas como el Profit Factor, cuya distribución muestral no
 * es normal ni tiene forma cerrada.
 */
export function bootstrapInterval(
  xs: ArrayLike<number>,
  statistic: (sample: Float64Array) => number,
  options: { iterations?: number; level?: number; seed?: number } = {},
): ConfidenceInterval {
  const iterations = options.iterations ?? 2000;
  const level = options.level ?? 0.95;
  const rng = createRng(options.seed ?? 42);
  const n = xs.length;
  if (n === 0) return { lower: Number.NaN, upper: Number.NaN, level };

  const estimates = new Float64Array(iterations);
  const sample = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) sample[i] = xs[rng.nextInt(n)] as number;
    estimates[it] = statistic(sample);
  }
  estimates.sort();
  const alpha = (1 - level) / 2;
  return {
    lower: quantileSorted(estimates, alpha),
    upper: quantileSorted(estimates, 1 - alpha),
    level,
  };
}
