import { ValidationError, type Bar } from "@trf/shared";
import { peekLines, readCsv, type Delimiter } from "./csv.js";
import { createTimezoneResolver, parseNaiveDateTime, type SourceTimezone } from "./timezone.js";

/**
 * PARSER DE VELAS EXPORTADAS DESDE MT5.
 *
 * Formato estándar de "Herramientas → Datos históricos → Exportar barras":
 *
 *   <DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>
 *   2024.01.02\t09:30:00\t16800.5\t16810.0\t16795.0\t16805.5\t1234\t0\t2
 *
 * El parser es tolerante porque en la práctica se ven variantes: separador coma
 * o punto y coma, cabecera con o sin `<>`, fecha y hora en una sola columna,
 * y columnas de volumen ausentes. Se mapea por CABECERA cuando la hay y por
 * posición cuando no.
 */

export interface Mt5BarParseOptions {
  /** Zona horaria del servidor del bróker. Ver `timezone.ts`. */
  readonly sourceTimezone: SourceTimezone;
  readonly delimiter?: Delimiter;
  /** Rechaza velas fuera de este rango (epoch ms). Útil para importar por años. */
  readonly fromTs?: number;
  readonly toTs?: number;
}

export interface ParsedRow {
  readonly bar: Bar;
  readonly lineNumber: number;
}

export interface ParseError {
  readonly lineNumber: number;
  readonly message: string;
  readonly raw: string;
}

/** Alias de cabecera aceptados, normalizados a minúsculas y sin `<>`. */
const HEADER_ALIASES: Record<string, string> = {
  date: "date",
  time: "time",
  datetime: "datetime",
  timestamp: "datetime",
  open: "open",
  high: "high",
  low: "low",
  close: "close",
  tickvol: "tickVolume",
  tickvolume: "tickVolume",
  vol: "volume",
  volume: "volume",
  realvolume: "volume",
  spread: "spread",
};

function normalizeHeader(field: string): string | null {
  const cleaned = field.replace(/[<>\s_]/g, "").toLowerCase();
  return HEADER_ALIASES[cleaned] ?? null;
}

interface ColumnMap {
  date: number;
  time: number;
  datetime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  volume: number;
  spread: number;
}

const POSITIONAL_MAP: ColumnMap = {
  date: 0,
  time: 1,
  datetime: -1,
  open: 2,
  high: 3,
  low: 4,
  close: 5,
  tickVolume: 6,
  volume: 7,
  spread: 8,
};

function buildColumnMap(fields: readonly string[]): ColumnMap | null {
  const map: ColumnMap = { ...POSITIONAL_MAP, date: -1, time: -1, datetime: -1, open: -1, high: -1, low: -1, close: -1, tickVolume: -1, volume: -1, spread: -1 };
  let matched = 0;
  fields.forEach((field, index) => {
    const key = normalizeHeader(field);
    if (key !== null) {
      (map as unknown as Record<string, number>)[key] = index;
      matched++;
    }
  });
  // Se considera cabecera si reconoce al menos OHLC + una columna temporal.
  const hasTime = map.date >= 0 || map.datetime >= 0;
  return matched >= 5 && hasTime && map.open >= 0 && map.close >= 0 ? map : null;
}

/** ¿La primera línea es una cabecera? */
export async function detectHeader(filePath: string, delimiter?: Delimiter): Promise<boolean> {
  const [first] = await peekLines(filePath, 1);
  if (first === undefined) return false;
  // Una línea de datos empieza siempre por un dígito (la fecha).
  return !/^\s*\d/.test(first) || first.includes("<");
}

function toNumber(fields: readonly string[], index: number, fallback: number | null, label: string, line: number): number {
  if (index < 0 || index >= fields.length) {
    if (fallback !== null) return fallback;
    throw new ValidationError(`Falta la columna ${label}`, { line, index });
  }
  const raw = (fields[index] as string).replace(/\s/g, "").replace(",", ".");
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    if (fallback !== null) return fallback;
    throw new ValidationError(`Valor no numérico en ${label}: "${fields[index]}"`, { line, raw: fields[index] });
  }
  return value;
}

/**
 * Recorre el fichero y emite velas normalizadas a UTC.
 *
 * Los errores NO abortan la importación: se devuelven por el callback
 * `onError`. Un fichero de MT5 con tres líneas corruptas al final (pasa) no
 * debe tirar por tierra cinco años de datos válidos.
 */
export async function* parseMt5Bars(
  filePath: string,
  options: Mt5BarParseOptions,
  onError?: (error: ParseError) => void,
): AsyncGenerator<ParsedRow> {
  const resolver = createTimezoneResolver(options.sourceTimezone);
  let columns: ColumnMap | null = null;
  let headerChecked = false;

  for await (const { lineNumber, fields } of readCsv(filePath, { delimiter: options.delimiter })) {
    if (!headerChecked) {
      headerChecked = true;
      const detected = buildColumnMap(fields);
      if (detected !== null) {
        columns = detected;
        continue; // era la cabecera
      }
      columns = POSITIONAL_MAP;
    }

    const map = columns as ColumnMap;

    try {
      let naive: number;
      if (map.datetime >= 0) {
        const value = fields[map.datetime] ?? "";
        const [datePart, timePart] = value.split(/[ T]/);
        naive = parseNaiveDateTime(datePart ?? "", timePart ?? "");
      } else {
        naive = parseNaiveDateTime(fields[map.date] ?? "", fields[map.time] ?? "");
      }
      const ts = resolver.toUtc(naive);

      if (options.fromTs !== undefined && ts < options.fromTs) continue;
      if (options.toTs !== undefined && ts >= options.toTs) continue;

      const open = toNumber(fields, map.open, null, "open", lineNumber);
      const high = toNumber(fields, map.high, null, "high", lineNumber);
      const low = toNumber(fields, map.low, null, "low", lineNumber);
      const close = toNumber(fields, map.close, null, "close", lineNumber);

      // Coherencia OHLC. Una vela con high < low es dato corrupto, no ruido.
      if (high < low || open > high || open < low || close > high || close < low) {
        throw new ValidationError("Vela incoherente (OHLC fuera de rango)", { open, high, low, close });
      }

      yield {
        lineNumber,
        bar: {
          ts,
          open,
          high,
          low,
          close,
          tickVolume: toNumber(fields, map.tickVolume, 0, "tickVolume", lineNumber),
          volume: toNumber(fields, map.volume, 0, "volume", lineNumber),
          spread: toNumber(fields, map.spread, 0, "spread", lineNumber),
        },
      };
    } catch (error) {
      onError?.({
        lineNumber,
        message: error instanceof Error ? error.message : String(error),
        raw: fields.join(" | ").slice(0, 200),
      });
    }
  }
}

/** Variante JSON: array de objetos o NDJSON con las mismas claves. */
export function parseJsonBar(raw: unknown, resolverSpec: SourceTimezone): Bar {
  const resolver = createTimezoneResolver(resolverSpec);
  const record = raw as Record<string, unknown>;

  const tsValue = record["ts"] ?? record["time"] ?? record["datetime"] ?? record["date"];
  let ts: number;
  if (typeof tsValue === "number") {
    // Epoch en segundos o milisegundos: se distingue por magnitud.
    ts = tsValue > 1e11 ? tsValue : tsValue * 1000;
  } else if (typeof tsValue === "string") {
    const [datePart, timePart] = tsValue.split(/[ T]/);
    ts = resolver.toUtc(parseNaiveDateTime(datePart ?? "", (timePart ?? "").replace("Z", "")));
  } else {
    throw new ValidationError("El registro JSON no tiene marca de tiempo reconocible", { record });
  }

  const num = (key: string, fallback?: number): number => {
    const value = record[key];
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`Campo numérico ausente o inválido: ${key}`, { key, value });
  };

  return {
    ts,
    open: num("open"),
    high: num("high"),
    low: num("low"),
    close: num("close"),
    tickVolume: num("tickVolume", num("tick_volume", 0)),
    volume: num("volume", 0),
    spread: num("spread", 0),
  };
}
