/**
 * Calendario de mercado.
 *
 * Regla del framework: TODO se almacena en epoch ms UTC. Las partes de fecha
 * (hora, minuto, día de la semana) se derivan siempre en la zona horaria del
 * MERCADO, no del broker ni del ordenador del usuario.
 *
 * Por qué importa: el "9:30" del NAS100 es 9:30 America/New_York. Un broker MT5
 * suele exportar en GMT+2/GMT+3 con su propio DST, que NO coincide con el DST
 * de Nueva York (hay ~2 semanas al año de desfase). Derivar las horas en la
 * zona del mercado elimina esa clase entera de bugs silenciosos.
 *
 * Implementación sin dependencias: `Intl.DateTimeFormat` con `timeZone` maneja
 * DST correctamente. Cacheamos el formateador y además cacheamos el offset por
 * bloques de una hora, porque esto se ejecuta millones de veces.
 */

export interface CalendarParts {
  readonly year: number;
  /** 1..12 */
  readonly month: number;
  /** 1..31 */
  readonly dayOfMonth: number;
  /** 1 = lunes … 7 = domingo (ISO-8601). */
  readonly dayOfWeek: number;
  /** 0..23 */
  readonly hour: number;
  /** 0..59 */
  readonly minute: number;
  /** hour * 60 + minute, 0..1439. */
  readonly minuteOfDay: number;
  /** Día del año, 1..366. */
  readonly dayOfYear: number;
  /** Clave de sesión "YYYY-MM-DD" en zona de mercado; agrupa el día de trading. */
  readonly sessionDate: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Offset (ms) entre UTC y `timeZone` en el instante `ts`.
 * Cacheado por hora: dentro de una misma hora el offset nunca cambia
 * (los cambios de DST ocurren siempre en punto).
 */
const offsetCache = new Map<string, number>();
const HOUR_MS = 3_600_000;

export function timezoneOffsetMs(ts: number, timeZone: string): number {
  const hourBucket = Math.floor(ts / HOUR_MS);
  const cacheKey = `${timeZone}|${hourBucket}`;
  const cached = offsetCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const parts = getFormatter(timeZone).formatToParts(new Date(ts));
  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") lookup[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    lookup["year"] ?? 1970,
    (lookup["month"] ?? 1) - 1,
    lookup["day"] ?? 1,
    lookup["hour"] ?? 0,
    lookup["minute"] ?? 0,
    lookup["second"] ?? 0,
  );
  const offset = asUtc - ts + (ts % 1000);

  // Evita que el cache crezca sin límite en importaciones de años de datos.
  if (offsetCache.size > 200_000) offsetCache.clear();
  offsetCache.set(cacheKey, offset);
  return offset;
}

const DAY_MS = 86_400_000;

/** Descompone un epoch ms en partes de calendario en la zona del mercado. */
export function calendarParts(ts: number, timeZone: string): CalendarParts {
  const local = ts + timezoneOffsetMs(ts, timeZone);
  const d = new Date(local);

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const dayOfMonth = d.getUTCDate();
  const jsDay = d.getUTCDay(); // 0 = domingo
  const dayOfWeek = jsDay === 0 ? 7 : jsDay;
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();

  const startOfYear = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor((Date.UTC(year, month - 1, dayOfMonth) - startOfYear) / DAY_MS) + 1;

  return {
    year,
    month,
    dayOfMonth,
    dayOfWeek,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
    dayOfYear,
    sessionDate: `${pad4(year)}-${pad2(month)}-${pad2(dayOfMonth)}`,
  };
}

/** Medianoche del día de mercado que contiene `ts`, como epoch ms UTC. */
export function startOfSessionDay(ts: number, timeZone: string): number {
  const parts = calendarParts(ts, timeZone);
  // Primera aproximación asumiendo el offset actual, luego se corrige una vez
  // (basta una iteración: el error máximo es 1 hora por DST).
  const naiveUtc = Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth);
  const guess = naiveUtc - timezoneOffsetMs(ts, timeZone);
  return naiveUtc - timezoneOffsetMs(guess, timeZone);
}

/** Convierte "YYYY-MM-DD" + minuto del día (zona de mercado) a epoch ms UTC. */
export function sessionDateTimeToUtc(sessionDate: string, minuteOfDay: number, timeZone: string): number {
  const [y, m, d] = sessionDate.split("-").map(Number);
  const naiveUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + minuteOfDay * 60_000;
  const guess = naiveUtc - timezoneOffsetMs(naiveUtc, timeZone);
  return naiveUtc - timezoneOffsetMs(guess, timeZone);
}

/** Parsea "YYYY-MM-DD" como medianoche UTC. Para límites de datasets. */
export function parseIsoDateUtc(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
    throw new RangeError(`Fecha ISO inválida: ${isoDate}`);
  }
  return Date.UTC(y, m - 1, d);
}

export function formatUtcIso(ts: number): string {
  return new Date(ts).toISOString();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

/** Sesiones estándar para índices US, expresadas en minutos de la zona del mercado. */
export const US_SESSIONS = {
  /** 04:00–09:30 ET */
  premarket: { start: 240, end: 570 },
  /** 09:30–10:30 ET — la primera hora, foco de la investigación NAS100. */
  openingHour: { start: 570, end: 630 },
  /** 09:30–16:00 ET */
  regular: { start: 570, end: 960 },
  /** 11:30–14:00 ET */
  lunch: { start: 690, end: 840 },
  /** 15:00–16:00 ET */
  powerHour: { start: 900, end: 960 },
  /** 16:00–20:00 ET */
  afterHours: { start: 960, end: 1200 },
} as const;

export type SessionName = keyof typeof US_SESSIONS;

/**
 * Ventanas mutuamente excluyentes que cubren la sesión regular.
 * `regular` se excluye a propósito: contiene a las otras tres y sólo existe
 * como rango de conveniencia para filtros.
 */
const EXCLUSIVE_SESSIONS: readonly SessionName[] = [
  "premarket",
  "openingHour",
  "lunch",
  "powerHour",
  "afterHours",
];

/**
 * Devuelve la sesión MÁS ESPECÍFICA que contiene `minuteOfDay`.
 * El tramo 10:30–11:30 y 14:00–15:00 quedan dentro de `regular` sin etiqueta
 * propia, así que devuelven "regular".
 */
export function sessionOf(minuteOfDay: number): SessionName | null {
  for (const name of EXCLUSIVE_SESSIONS) {
    const window = US_SESSIONS[name];
    if (minuteOfDay >= window.start && minuteOfDay < window.end) return name;
  }
  const regular = US_SESSIONS.regular;
  if (minuteOfDay >= regular.start && minuteOfDay < regular.end) return "regular";
  return null;
}
