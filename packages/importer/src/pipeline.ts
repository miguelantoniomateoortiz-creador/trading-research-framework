import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import {
  createImportBatch,
  findBatchByHash,
  finishImportBatch,
  insertBars,
  type SqliteDatabase,
} from "@trf/database";
import { formatUtcIso, type Bar, type Timeframe } from "@trf/shared";
import { parseMt5Bars, type Mt5BarParseOptions, type ParseError } from "./mt5-bars.js";

/**
 * ORQUESTACIÓN DE LA IMPORTACIÓN.
 *
 * Tres propiedades que se cuidan a conciencia:
 *
 *  1. STREAMING. El fichero nunca se carga entero. Se acumulan velas en lotes
 *     de `batchSize` y cada lote va en una transacción.
 *  2. IDEMPOTENCIA. La clave natural (instrumento, timeframe, ts) descarta
 *     duplicados en la base. Reimportar solapando meses es seguro.
 *  3. TRAZABILIDAD. Cada importación deja un `ImportBatch` con el hash del
 *     fichero, cuántas filas se leyeron, cuántas se aceptaron y los primeros
 *     errores. Sin esto es imposible auditar de dónde salió un dato raro.
 */

export interface ImportBarsOptions extends Mt5BarParseOptions {
  readonly db: SqliteDatabase;
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  readonly filePath: string;
  /** Velas por transacción. 20.000 es un buen equilibrio memoria/velocidad. */
  readonly batchSize?: number;
  readonly onProgress?: (progress: { rowsRead: number; inserted: number }) => void;
  /** Si es false, aborta cuando el fichero ya se importó antes. */
  readonly allowReimport?: boolean;
}

export interface ImportSummary {
  readonly batchId: string;
  readonly rowsRead: number;
  readonly rowsAccepted: number;
  readonly rowsRejected: number;
  readonly rowsInserted: number;
  readonly duplicatesSkipped: number;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  readonly errors: readonly ParseError[];
  readonly previousBatchId: string | null;
  readonly elapsedMs: number;
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function importBarsFromFile(options: ImportBarsOptions): Promise<ImportSummary> {
  const started = Date.now();
  const batchSize = options.batchSize ?? 20_000;
  const sourceHash = await hashFile(options.filePath);

  const previousBatchId = findBatchByHash(options.db, options.instrumentId, sourceHash);
  if (previousBatchId !== null && options.allowReimport === false) {
    return {
      batchId: previousBatchId,
      rowsRead: 0,
      rowsAccepted: 0,
      rowsRejected: 0,
      rowsInserted: 0,
      duplicatesSkipped: 0,
      firstTs: null,
      lastTs: null,
      errors: [],
      previousBatchId,
      elapsedMs: Date.now() - started,
    };
  }

  const batchId = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  createImportBatch(options.db, {
    id: batchId,
    instrumentId: options.instrumentId,
    format: `mt5-bars-${options.timeframe}`,
    sourceFile: basename(options.filePath),
    sourceHash,
  });

  const errors: ParseError[] = [];
  let buffer: Bar[] = [];
  let rowsRead = 0;
  let rowsAccepted = 0;
  let rowsInserted = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  const flush = (): void => {
    if (buffer.length === 0) return;
    rowsInserted += insertBars(options.db, options.instrumentId, options.timeframe, buffer);
    buffer = [];
    options.onProgress?.({ rowsRead, inserted: rowsInserted });
  };

  for await (const row of parseMt5Bars(options.filePath, options, (error) => {
    if (errors.length < 100) errors.push(error);
  })) {
    rowsRead++;
    rowsAccepted++;
    if (firstTs === null || row.bar.ts < firstTs) firstTs = row.bar.ts;
    if (lastTs === null || row.bar.ts > lastTs) lastTs = row.bar.ts;

    buffer.push(row.bar);
    if (buffer.length >= batchSize) flush();
  }
  flush();

  const rowsRejected = errors.length;
  finishImportBatch(options.db, batchId, {
    rowsRead: rowsRead + rowsRejected,
    rowsAccepted,
    rowsRejected,
    errors: errors.map((e) => `L${e.lineNumber}: ${e.message}`),
  });

  return {
    batchId,
    rowsRead: rowsRead + rowsRejected,
    rowsAccepted,
    rowsRejected,
    rowsInserted,
    duplicatesSkipped: rowsAccepted - rowsInserted,
    firstTs,
    lastTs,
    errors,
    previousBatchId,
    elapsedMs: Date.now() - started,
  };
}

/** Resumen legible para el CLI. */
export function formatImportSummary(summary: ImportSummary): string {
  const lines = [
    `Lote:            ${summary.batchId}`,
    `Filas leídas:    ${summary.rowsRead.toLocaleString("es-ES")}`,
    `Aceptadas:       ${summary.rowsAccepted.toLocaleString("es-ES")}`,
    `Rechazadas:      ${summary.rowsRejected.toLocaleString("es-ES")}`,
    `Insertadas:      ${summary.rowsInserted.toLocaleString("es-ES")}`,
    `Duplicadas:      ${summary.duplicatesSkipped.toLocaleString("es-ES")} (ya estaban en la base)`,
    `Rango:           ${summary.firstTs === null ? "—" : formatUtcIso(summary.firstTs)} → ${
      summary.lastTs === null ? "—" : formatUtcIso(summary.lastTs)
    }`,
    `Tiempo:          ${(summary.elapsedMs / 1000).toFixed(1)} s`,
  ];
  if (summary.previousBatchId !== null) {
    lines.push(`Aviso:           este fichero ya se importó en el lote ${summary.previousBatchId}`);
  }
  if (summary.errors.length > 0) {
    lines.push("", "Primeros errores:");
    for (const error of summary.errors.slice(0, 5)) {
      lines.push(`  L${error.lineNumber}: ${error.message}`);
    }
  }
  return lines.join("\n");
}
