import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Lector CSV/TSV por streaming, sin dependencias.
 *
 * Por qué no una librería: los exports de MT5 son ficheros planos sin comillas
 * ni saltos de línea embebidos, y un fichero de 5 años de M1 pesa ~100 MB. Lo
 * único que se necesita es leer línea a línea sin cargar el fichero en memoria,
 * y eso son 30 líneas de `readline`. Una dependencia aquí sería más superficie
 * de mantenimiento que código.
 *
 * Sí soporta comillas dobles porque algunos exports de informes las usan.
 */

export type Delimiter = "," | "\t" | ";";

/** Detecta el separador contando ocurrencias en las primeras líneas. */
export function detectDelimiter(sample: string): Delimiter {
  const candidates: Delimiter[] = ["\t", ",", ";"];
  let best: Delimiter = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = sample.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

/** Divide una línea respetando comillas dobles. */
export function splitLine(line: string, delimiter: Delimiter): string[] {
  if (!line.includes('"')) return line.split(delimiter);

  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export interface CsvLine {
  readonly lineNumber: number;
  readonly fields: readonly string[];
}

export interface ReadCsvOptions {
  readonly delimiter?: Delimiter;
  /** Líneas a saltar al principio (cabeceras de informes de MT5). */
  readonly skipLines?: number;
}

/**
 * Lee un CSV/TSV línea a línea.
 *
 * Es un generador asíncrono: el consumidor decide el ritmo y la memoria se
 * mantiene constante independientemente del tamaño del fichero.
 */
export async function* readCsv(filePath: string, options: ReadCsvOptions = {}): AsyncGenerator<CsvLine> {
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 1 << 20 });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  let delimiter = options.delimiter;
  let lineNumber = 0;
  const skip = options.skipLines ?? 0;

  try {
    for await (const rawLine of reader) {
      lineNumber++;
      if (lineNumber <= skip) continue;

      const line = rawLine.trim();
      if (line.length === 0) continue;

      if (delimiter === undefined) delimiter = detectDelimiter(line);
      yield { lineNumber, fields: splitLine(line, delimiter).map((f) => f.trim()) };
    }
  } finally {
    reader.close();
    stream.close();
  }
}

/** Lee sólo las primeras `count` líneas. Sirve para detectar el formato. */
export async function peekLines(filePath: string, count: number): Promise<string[]> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  try {
    for await (const line of reader) {
      lines.push(line);
      if (lines.length >= count) break;
    }
  } finally {
    reader.close();
    stream.close();
  }
  return lines;
}
