import type { CohortMetrics } from "@trf/shared";

/** Utilidades de presentación en terminal, sin dependencias de color. */

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );

  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] as number)).join("  ").trimEnd();

  const separator = widths.map((w) => "─".repeat(w)).join("  ");
  return [line(headers), separator, ...rows.map(line)].join("\n");
}

export function num(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "—";
  return value.toFixed(decimals);
}

export function pct(value: number, decimals = 1): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(decimals)}%` : "—";
}

export function int(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("es-ES") : "—";
}

/** Ficha completa de una cohorte. */
export function metricsBlock(metrics: CohortMetrics): string {
  return [
    `Operaciones        ${int(metrics.count)}   (ganadoras ${int(metrics.wins)} / perdedoras ${int(metrics.losses)})`,
    `Win rate           ${pct(metrics.winRate)}   IC95% [${pct(metrics.winRateCi.lower)}, ${pct(metrics.winRateCi.upper)}]`,
    `Profit factor      ${num(metrics.profitFactor)}`,
    `Expectancy         ${num(metrics.expectancy)} por operación`,
    `Beneficio neto     ${num(metrics.netProfit)}`,
    `Payoff             ${num(metrics.payoffRatio)}   (media ganadora ${num(metrics.avgWin)} / perdedora ${num(metrics.avgLoss)})`,
    `Drawdown máximo    ${num(metrics.maxDrawdown)}   (${pct(metrics.maxDrawdownPct)}, ${int(metrics.maxDrawdownLength)} operaciones)`,
    `Rachas             ${int(metrics.maxConsecutiveWins)} ganadoras / ${int(metrics.maxConsecutiveLosses)} perdedoras seguidas`,
    `Sharpe por op.     ${num(metrics.sharpe, 3)}   Sortino ${num(metrics.sortino, 3)}`,
    `Estabilidad (R²)   ${num(metrics.equityR2, 3)}   ← equity contra una recta; alto = edge constante`,
    `t / p-valor        ${num(metrics.tStat, 2)} / ${metrics.pValue < 0.0001 ? "<0.0001" : num(metrics.pValue, 4)}`,
  ].join("\n");
}

/** Métricas en una línea, para tablas comparativas. */
export function metricsRow(label: string, metrics: CohortMetrics): string[] {
  return [
    label,
    int(metrics.count),
    pct(metrics.winRate),
    num(metrics.profitFactor),
    num(metrics.expectancy),
    num(metrics.maxDrawdown, 0),
    num(metrics.equityR2, 2),
    metrics.pValue < 0.0001 ? "<1e-4" : num(metrics.pValue, 4),
  ];
}

export const METRIC_HEADERS = ["Cohorte", "Ops", "WR", "PF", "Expect.", "DD", "R²", "p"];

export function heading(text: string): string {
  return `\n${text}\n${"═".repeat(text.length)}`;
}

export function warn(text: string): string {
  return `\n⚠  ${text}`;
}
