import { ValidationError, timezoneOffsetMs } from "@trf/shared";

/**
 * NORMALIZACIÓN HORARIA DEL ORIGEN.
 *
 * Este es el punto donde más silenciosamente se corrompen los datos de MT5.
 *
 * El terminal exporta en HORA DEL SERVIDOR DEL BRÓKER, que casi nunca es UTC:
 * lo habitual es UTC+2 en invierno y UTC+3 en verano, siguiendo el horario de
 * verano EUROPEO. El NAS100 abre a las 09:30 de Nueva York, que sigue el
 * horario de verano ESTADOUNIDENSE. Los dos cambios de hora no coinciden: hay
 * unas dos semanas en marzo y una en noviembre en las que el desfase entre
 * ambos es de una hora.
 *
 * Consecuencia práctica: si tratas la hora del bróker como si fuera fija,
 * durante esas semanas las velas de "la apertura" son en realidad las de las
 * 08:30 o las 10:30. Son unos 15 días al año de datos mal etiquetados
 * mezclados con los buenos, justo en las fechas de más volatilidad.
 *
 * Por eso el importador EXIGE declarar la zona del origen y admite:
 *   - un desplazamiento fijo: "UTC+2", "UTC-5", "UTC"
 *   - una zona IANA con DST real: "Europe/Riga", "Europe/Athens"
 *
 * Si tu bróker aplica DST (casi todos), usa la zona IANA.
 */

export type SourceTimezone = string;

const FIXED_OFFSET_PATTERN = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/i;

export interface TimezoneResolver {
  /** Convierte una fecha/hora "de pared" del origen a epoch ms UTC. */
  toUtc(naiveUtcMs: number): number;
  readonly description: string;
}

/**
 * @param spec "UTC", "UTC+3", "UTC-5:30" o una zona IANA ("Europe/Riga").
 */
export function createTimezoneResolver(spec: SourceTimezone): TimezoneResolver {
  const normalized = spec.trim();

  if (/^utc$/i.test(normalized)) {
    return { toUtc: (naive) => naive, description: "UTC (sin desplazamiento)" };
  }

  const fixed = FIXED_OFFSET_PATTERN.exec(normalized);
  if (fixed !== null) {
    const sign = fixed[1] === "-" ? -1 : 1;
    const hours = Number(fixed[2]);
    const minutes = Number(fixed[3] ?? 0);
    const offsetMs = sign * (hours * 3_600_000 + minutes * 60_000);
    return {
      toUtc: (naive) => naive - offsetMs,
      description: `desplazamiento fijo ${normalized} (sin horario de verano)`,
    };
  }

  // Zona IANA: se resuelve con dos pasadas para acertar en los saltos de DST.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized });
  } catch {
    throw new ValidationError(
      `Zona horaria de origen desconocida: "${spec}". Usa "UTC", "UTC+2" o una zona IANA como "Europe/Riga".`,
      { spec },
    );
  }

  return {
    toUtc: (naive) => {
      const guess = naive - timezoneOffsetMs(naive, normalized);
      return naive - timezoneOffsetMs(guess, normalized);
    },
    description: `zona IANA ${normalized} (con horario de verano)`,
  };
}

/**
 * Parsea fecha y hora tal como las escribe MT5 y devuelve el instante "de
 * pared" como si fuera UTC. El resolver lo desplaza después.
 *
 * Formatos admitidos:
 *   fecha: 2024.01.02 | 2024-01-02 | 02/01/2024 (día primero, informes)
 *   hora:  09:30 | 09:30:00 | (vacía, para D1)
 */
export function parseNaiveDateTime(datePart: string, timePart: string): number {
  const date = datePart.trim();
  const time = timePart.trim();

  let year: number;
  let month: number;
  let day: number;

  if (/^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}$/.test(date)) {
    const [y, m, d] = date.split(/[.\-/]/).map(Number);
    year = y as number;
    month = m as number;
    day = d as number;
  } else if (/^\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}$/.test(date)) {
    const [d, m, y] = date.split(/[.\-/]/).map(Number);
    year = y as number;
    month = m as number;
    day = d as number;
  } else {
    throw new ValidationError(`Fecha no reconocida: "${datePart}"`, { datePart });
  }

  let hour = 0;
  let minute = 0;
  let second = 0;
  if (time.length > 0) {
    const parts = time.split(":").map(Number);
    hour = parts[0] ?? 0;
    minute = parts[1] ?? 0;
    second = parts[2] ?? 0;
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      throw new ValidationError(`Hora no reconocida: "${timePart}"`, { timePart });
    }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ValidationError(`Fecha fuera de rango: "${datePart}"`, { datePart });
  }

  return Date.UTC(year, month - 1, day, hour, minute, second);
}
