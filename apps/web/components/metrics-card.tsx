import type { CohortMetrics } from "@trf/shared";
import { int, num, pct, pValue } from "@/lib/format";

/**
 * Ficha de métricas de una cohorte — el equivalente visual de
 * `metricsBlock()` en el CLI (apps/cli/src/format.ts). Se usa en cohortes,
 * hipótesis (entrenamiento y validación) y discovery.
 */
export function MetricsCard({ title, metrics }: { title?: string; metrics: CohortMetrics }): JSX.Element {
  const rows: [string, string][] = [
    ["Operaciones", `${int(metrics.count)} (${int(metrics.wins)}G / ${int(metrics.losses)}P)`],
    ["Win rate", `${pct(metrics.winRate)}  ·  IC95% [${pct(metrics.winRateCi.lower)}, ${pct(metrics.winRateCi.upper)}]`],
    ["Profit factor", num(metrics.profitFactor)],
    ["Expectancy", `${num(metrics.expectancy)} / operación`],
    ["Beneficio neto", num(metrics.netProfit)],
    ["Payoff", `${num(metrics.payoffRatio)} (G ${num(metrics.avgWin)} / P ${num(metrics.avgLoss)})`],
    ["Drawdown máx.", `${num(metrics.maxDrawdown)} (${pct(metrics.maxDrawdownPct)})`],
    ["Rachas", `${int(metrics.maxConsecutiveWins)}G / ${int(metrics.maxConsecutiveLosses)}P`],
    ["Sharpe / Sortino", `${num(metrics.sharpe, 3)} / ${num(metrics.sortino, 3)}`],
    ["Estabilidad (R²)", num(metrics.equityR2, 3)],
    ["t / p-valor", `${num(metrics.tStat, 2)} / ${pValue(metrics.pValue)}`],
  ];

  return (
    <div className="panel p-4">
      {title !== undefined && <div className="mb-3 text-sm font-medium text-base-100">{title}</div>}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 border-b border-base-800/60 py-1 text-sm">
            <dt className="text-base-400">{label}</dt>
            <dd className="font-mono text-base-100">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
