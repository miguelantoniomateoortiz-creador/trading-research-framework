/** Utilidades de presentación, réplica en el navegador de apps/cli/src/format.ts. */

import type { EntryRule } from "./api";

/**
 * Cuando el mismo plugin se corrió con distintos ajustes (ej. riesgo/RR
 * cambiado en Plugins), cada corrida genera una regla nueva con el mismo
 * nombre. Aquí se agregan los valores de configuración al texto para poder
 * distinguirlas en cualquier desplegable de reglas.
 */
export function ruleLabel(rule: EntryRule): string {
  const { riskPoints, riskRewardRatio } = rule.config as { riskPoints?: number; riskRewardRatio?: number };
  if (riskPoints !== undefined && riskRewardRatio !== undefined) {
    return `${rule.name} (riesgo ${riskPoints} · RR ${riskRewardRatio})`;
  }
  return `${rule.name} (${rule.id.slice(-8)})`;
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

export function qValue(value: number): string {
  return value < 0.0001 ? "<1e-4" : num(value, 4);
}

export function pValue(value: number): string {
  return value < 0.0001 ? "<0.0001" : num(value, 4);
}

export function dateUtc(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}

export function dateTimeUtc(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}

const NY_TIME_ZONE = "America/New_York";

/**
 * Offset (ms) entre UTC y hora de Nueva York en el instante dado, con el
 * cambio de horario de verano ya resuelto por el navegador (`Intl`).
 */
function nyOffsetMs(utcMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: NY_TIME_ZONE,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asIfUtc = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]) % 24,
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  return asIfUtc - utcMs;
}

/**
 * Timestamp "disfrazado": lightweight-charts sólo sabe mostrar UTC, así que
 * para que dibuje hora de Nueva York le pasamos un valor desplazado que, leído
 * como si fuera UTC, coincide con la hora de NY real. Úsalo SÓLO para lo que
 * se pinta en el gráfico — para comparar o filtrar sigue usando el timestamp
 * real sin tocar.
 */
export function nyDisplayMs(utcMs: number): number {
  return utcMs + nyOffsetMs(utcMs);
}

/** Formatea un timestamp real (epoch ms UTC) como hora de Nueva York legible. */
export function dateTimeNy(utcMs: number): string {
  return new Date(nyDisplayMs(utcMs)).toISOString().replace("T", " ").slice(0, 19);
}
