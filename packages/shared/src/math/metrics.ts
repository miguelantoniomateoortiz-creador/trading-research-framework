/**
 * Métricas de rendimiento de una cohorte de operaciones.
 *
 * Una "cohorte" es el subconjunto de operaciones que cumple un predicado. Todo
 * el motor de análisis se reduce a: filtrar → resumir → comparar.
 */

import { benjaminiHochberg, bootstrapInterval, mean, quantile, stdDev, tTestAgainstZero, wilsonInterval, type ConfidenceInterval } from "./stats.js";

export interface CohortMetrics {
  /** Número de operaciones. */
  readonly count: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakEven: number;

  readonly winRate: number;
  /** IC de Wilson al 95% sobre el win rate. La cota inferior es la que importa. */
  readonly winRateCi: ConfidenceInterval;

  readonly grossProfit: number;
  readonly grossLoss: number;
  readonly netProfit: number;
  /**
   * grossProfit / |grossLoss|. `Infinity` si no hay pérdidas — el motor de
   * descubrimiento trata Infinity como sospechoso, no como excelente.
   */
  readonly profitFactor: number;

  /** Resultado medio por operación. */
  readonly expectancy: number;
  readonly avgWin: number;
  readonly avgLoss: number;
  /** avgWin / |avgLoss|. */
  readonly payoffRatio: number;

  readonly stdDev: number;
  /** Sharpe por operación (no anualizado). */
  readonly sharpe: number;
  /** Como Sharpe pero sólo penaliza desviación a la baja. */
  readonly sortino: number;

  /** Máximo drawdown de la curva de equity, en unidades de P&L. */
  readonly maxDrawdown: number;
  /** Drawdown máximo como fracción del pico de equity alcanzado. */
  readonly maxDrawdownPct: number;
  /** Operaciones que duró el peor drawdown. */
  readonly maxDrawdownLength: number;

  readonly maxConsecutiveWins: number;
  readonly maxConsecutiveLosses: number;

  /** R² de la curva de equity contra una recta: mide estabilidad del edge. */
  readonly equityR2: number;

  readonly medianPnl: number;
  readonly p05Pnl: number;
  readonly p95Pnl: number;

  /** t-statistic del P&L medio contra cero. */
  readonly tStat: number;
  /** p-valor de una cola (H1: expectancy > 0), SIN corregir por multiplicidad. */
  readonly pValue: number;
}

const EMPTY_CI: ConfidenceInterval = { lower: Number.NaN, upper: Number.NaN, level: 0.95 };

export const EMPTY_METRICS: CohortMetrics = {
  count: 0,
  wins: 0,
  losses: 0,
  breakEven: 0,
  winRate: Number.NaN,
  winRateCi: EMPTY_CI,
  grossProfit: 0,
  grossLoss: 0,
  netProfit: 0,
  profitFactor: Number.NaN,
  expectancy: Number.NaN,
  avgWin: Number.NaN,
  avgLoss: Number.NaN,
  payoffRatio: Number.NaN,
  stdDev: Number.NaN,
  sharpe: Number.NaN,
  sortino: Number.NaN,
  maxDrawdown: 0,
  maxDrawdownPct: 0,
  maxDrawdownLength: 0,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
  equityR2: Number.NaN,
  medianPnl: Number.NaN,
  p05Pnl: Number.NaN,
  p95Pnl: Number.NaN,
  tStat: Number.NaN,
  pValue: 1,
};

/**
 * Resume una serie de P&L por operación.
 *
 * IMPORTANTE: `pnl` debe venir en orden cronológico. El drawdown y las rachas
 * dependen del orden; el resto de métricas no.
 */
export function summarize(pnl: ArrayLike<number>): CohortMetrics {
  const n = pnl.length;
  if (n === 0) return EMPTY_METRICS;

  let wins = 0;
  let losses = 0;
  let breakEven = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  let equity = 0;
  let peak = 0;
  let peakIndex = 0;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let maxDrawdownLength = 0;

  let currentWinStreak = 0;
  let currentLossStreak = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;

  let downsideSumSq = 0;
  let downsideCount = 0;

  const equityCurve = new Float64Array(n);
  const xs = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const value = pnl[i] as number;

    if (value > 0) {
      wins++;
      grossProfit += value;
      currentWinStreak++;
      currentLossStreak = 0;
      if (currentWinStreak > maxConsecutiveWins) maxConsecutiveWins = currentWinStreak;
    } else if (value < 0) {
      losses++;
      grossLoss += -value;
      currentLossStreak++;
      currentWinStreak = 0;
      if (currentLossStreak > maxConsecutiveLosses) maxConsecutiveLosses = currentLossStreak;
      downsideSumSq += value * value;
      downsideCount++;
    } else {
      breakEven++;
      currentWinStreak = 0;
      currentLossStreak = 0;
    }

    equity += value;
    equityCurve[i] = equity;
    xs[i] = i;

    if (equity > peak) {
      peak = equity;
      peakIndex = i;
    }
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownLength = i - peakIndex;
      // Porcentaje relativo al pico. Si el pico es <= 0 no hay base sobre la
      // que expresar un porcentaje, así que se deja en 0 y se reporta el
      // drawdown absoluto.
      maxDrawdownPct = peak > 0 ? drawdown / peak : 0;
    }
  }

  const netProfit = grossProfit - grossLoss;
  const expectancy = netProfit / n;
  const sd = stdDev(pnl);
  const avgWin = wins > 0 ? grossProfit / wins : Number.NaN;
  const avgLoss = losses > 0 ? grossLoss / losses : Number.NaN;
  const downsideDeviation = downsideCount > 0 ? Math.sqrt(downsideSumSq / n) : 0;
  const decided = wins + losses;
  const test = tTestAgainstZero(pnl);

  return {
    count: n,
    wins,
    losses,
    breakEven,
    winRate: decided > 0 ? wins / decided : Number.NaN,
    winRateCi: wilsonInterval(wins, decided > 0 ? decided : 0),
    grossProfit,
    grossLoss,
    netProfit,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : Number.NaN,
    expectancy,
    avgWin,
    avgLoss,
    payoffRatio: losses > 0 && wins > 0 ? avgWin / avgLoss : Number.NaN,
    stdDev: sd,
    sharpe: sd > 0 ? expectancy / sd : Number.NaN,
    sortino: downsideDeviation > 0 ? expectancy / downsideDeviation : Number.NaN,
    maxDrawdown,
    maxDrawdownPct,
    maxDrawdownLength,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    equityR2: equityStability(equityCurve, xs),
    medianPnl: quantile(pnl, 0.5),
    p05Pnl: quantile(pnl, 0.05),
    p95Pnl: quantile(pnl, 0.95),
    tStat: test.t,
    pValue: test.pOneSided,
  };
}

/**
 * R² de la curva de equity contra una recta creciente.
 *
 * Un edge real produce una equity que sube de forma constante (R² alto). Un
 * "edge" que viene de tres operaciones enormes da R² bajo aunque el Profit
 * Factor sea espectacular. Es uno de los mejores detectores de sobreajuste.
 */
function equityStability(equityCurve: Float64Array, xs: Float64Array): number {
  const n = equityCurve.length;
  if (n < 3) return Number.NaN;
  const mx = mean(xs);
  const my = mean(equityCurve);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (equityCurve[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return Number.NaN;
  return (sxy * sxy) / (sxx * syy);
}

/** Curva de equity acumulada. */
export function equityCurve(pnl: ArrayLike<number>): Float64Array {
  const out = new Float64Array(pnl.length);
  let acc = 0;
  for (let i = 0; i < pnl.length; i++) {
    acc += pnl[i] as number;
    out[i] = acc;
  }
  return out;
}

/** Profit factor como función suelta, para bootstrap. */
export function profitFactorOf(pnl: ArrayLike<number>): number {
  let gp = 0;
  let gl = 0;
  for (let i = 0; i < pnl.length; i++) {
    const v = pnl[i] as number;
    if (v > 0) gp += v;
    else gl -= v;
  }
  return gl > 0 ? gp / gl : gp > 0 ? Number.POSITIVE_INFINITY : Number.NaN;
}

/** IC bootstrap del profit factor. Reexporta para no duplicar la semilla. */
export function profitFactorInterval(pnl: ArrayLike<number>, seed = 42): ConfidenceInterval {
  return bootstrapInterval(pnl, (sample) => profitFactorOf(sample), { iterations: 1500, seed });
}

/** Aplica Benjamini-Hochberg a un conjunto de cohortes evaluadas. */
export function adjustPValues<T extends { readonly metrics: CohortMetrics }>(
  results: readonly T[],
): (T & { qValue: number })[] {
  const q = benjaminiHochberg(results.map((r) => r.metrics.pValue));
  return results.map((r, i) => ({ ...r, qValue: q[i] ?? 1 }));
}
