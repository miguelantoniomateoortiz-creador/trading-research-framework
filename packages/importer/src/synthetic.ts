import { createRng, calendarParts, sessionDateTimeToUtc, type Bar } from "@trf/shared";

/**
 * GENERADOR DE DATOS SINTÉTICOS DE NAS100.
 *
 * Existe por tres razones, y ninguna es "hacer bonito":
 *
 *  1. Permite probar todo el pipeline sin datos reales, y con semilla fija los
 *     tests son deterministas.
 *  2. Permite INYECTAR UN PATRÓN CONOCIDO. Si el motor de descubrimiento no
 *     encuentra un edge que sabemos que está ahí, el motor está roto. Y si
 *     encuentra edges en datos generados SIN patrón, entonces sobreajusta.
 *     Es la calibración del instrumento antes de usarlo.
 *  3. Da una referencia de rendimiento: cuánto tarda importar y analizar N
 *     millones de velas.
 *
 * El proceso reproduce las regularidades básicas del índice: perfil de
 * volatilidad en U a lo largo del día con pico en la apertura, gaps de
 * apertura, fines de semana sin datos y una deriva alcista de fondo.
 */

export interface SyntheticOptions {
  /** Fecha inicial "YYYY-MM-DD" (inclusive). */
  readonly startDate: string;
  /** Fecha final "YYYY-MM-DD" (inclusive). */
  readonly endDate: string;
  readonly startPrice?: number;
  readonly seed?: number;
  readonly timeZone?: string;
  /** Primer y último minuto de la jornada generada (hora del mercado). */
  readonly firstMinute?: number;
  readonly lastMinute?: number;
  /**
   * Inyecta un patrón real y comprobable: los días en los que el gap de
   * apertura supera `patternGapThreshold` ATRs tienen una deriva bajista
   * adicional durante la primera hora. Es el "edge" que el motor debe
   * encontrar en los tests de calibración.
   */
  readonly injectPattern?: boolean;
  readonly patternGapThreshold?: number;
  /** Fuerza del patrón inyectado, en puntos por minuto. */
  readonly patternStrength?: number;
}

const DAY_MS = 86_400_000;

/**
 * Perfil de volatilidad intradía (multiplicador sobre la volatilidad base).
 * Pico en la apertura, valle a mediodía, repunte al cierre: la forma de U
 * característica de los índices.
 */
function volatilityMultiplier(minuteOfDay: number): number {
  if (minuteOfDay < 570) return 0.45; // premercado
  if (minuteOfDay < 585) return 3.2; // primeros 15 minutos
  if (minuteOfDay < 630) return 2.0; // resto de la primera hora
  if (minuteOfDay < 690) return 1.2;
  if (minuteOfDay < 840) return 0.75; // almuerzo
  if (minuteOfDay < 900) return 1.0;
  if (minuteOfDay < 960) return 1.6; // power hour
  return 0.4; // fuera de horas
}

function volumeProfile(minuteOfDay: number): number {
  return 200 + 2200 * (volatilityMultiplier(minuteOfDay) / 3.2);
}

/** Genera velas M1 en orden cronológico. Generador: memoria constante. */
export function* generateNas100Bars(options: SyntheticOptions): Generator<Bar> {
  const timeZone = options.timeZone ?? "America/New_York";
  const rng = createRng(options.seed ?? 20240101);
  const firstMinute = options.firstMinute ?? 480; // 08:00 ET
  const lastMinute = options.lastMinute ?? 960; // 16:00 ET
  const injectPattern = options.injectPattern ?? false;
  const gapThreshold = options.patternGapThreshold ?? 0.8;
  const patternStrength = options.patternStrength ?? 0.09;

  let price = options.startPrice ?? 16000;
  /** Volatilidad base en puntos por minuto; varía lentamente (clustering). */
  let baseVolatility = 3.0;

  const start = parseDateUtc(options.startDate);
  const end = parseDateUtc(options.endDate);

  for (let dayTs = start; dayTs <= end; dayTs += DAY_MS) {
    const parts = calendarParts(dayTs + 12 * 3_600_000, timeZone);
    if (parts.dayOfWeek > 5) continue; // sin fines de semana

    // La volatilidad de régimen deriva de un día a otro (clustering).
    baseVolatility = clamp(baseVolatility * (1 + rng.nextGaussian() * 0.12), 1.2, 12);

    // Gap de apertura respecto al cierre anterior.
    const gap = rng.nextGaussian() * baseVolatility * 4;
    price += gap;
    const gapInVolatility = Math.abs(gap) / (baseVolatility * 4);

    // Deriva del patrón inyectado: sólo en días con gap grande y sólo durante
    // la primera hora de sesión.
    const patternActive = injectPattern && gapInVolatility > gapThreshold;
    const patternDrift = patternActive ? -Math.sign(gap) * patternStrength * baseVolatility : 0;

    for (let minute = firstMinute; minute <= lastMinute; minute++) {
      const ts = sessionDateTimeToUtc(parts.sessionDate, minute, timeZone);
      const vol = baseVolatility * volatilityMultiplier(minute);

      const drift =
        0.00004 * price / 1440 + // deriva alcista anual moderada
        (patternActive && minute >= 570 && minute < 630 ? patternDrift : 0);

      const open = price;
      const move = rng.nextGaussian() * vol + drift;
      const close = open + move;

      // Las mechas se generan aparte para que el cuerpo no determine el rango.
      const wickUp = Math.abs(rng.nextGaussian()) * vol * 0.6;
      const wickDown = Math.abs(rng.nextGaussian()) * vol * 0.6;
      const high = Math.max(open, close) + wickUp;
      const low = Math.min(open, close) - wickDown;

      price = close;

      yield {
        ts,
        open: round1(open),
        high: round1(high),
        low: round1(low),
        close: round1(close),
        tickVolume: Math.round(volumeProfile(minute) * (0.6 + rng.next() * 0.8)),
        volume: 0,
        spread: 1 + Math.round(rng.next() * 2),
      };
    }
  }
}

/** Escribe las velas en un CSV con el formato exacto de MT5 (tabulado). */
export function formatAsMt5Csv(bars: Iterable<Bar>, timeZone = "America/New_York"): string {
  const lines = ["<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>"];
  for (const bar of bars) {
    const parts = calendarParts(bar.ts, timeZone);
    const date = `${parts.year}.${pad(parts.month)}.${pad(parts.dayOfMonth)}`;
    const time = `${pad(parts.hour)}:${pad(parts.minute)}:00`;
    lines.push(
      [date, time, bar.open, bar.high, bar.low, bar.close, bar.tickVolume, bar.volume, bar.spread].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

function parseDateUtc(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y ?? 2024, (m ?? 1) - 1, d ?? 1);
}
