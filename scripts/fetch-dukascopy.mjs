#!/usr/bin/env node
import { getHistoricalRates } from "dukascopy-node";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Descarga historial de NAS100 (símbolo "usatechidxusd" en Dukascopy Bank SA)
 * y lo convierte al formato CSV de exportación de MT5, listo para
 * `pnpm trf data:import`.
 *
 * Existe porque el bróker del usuario sólo retiene ~17 meses de M5 para este
 * símbolo, y el motor de descubrimiento de patrones necesita muchas más
 * operaciones de las que ese historial permite. Dukascopy es un banco suizo
 * que publica datos históricos reales y gratuitos desde 2011 para este
 * instrumento — sin necesidad de cuenta ni API key.
 *
 * El formato de salida de dukascopy-node (timestamp epoch + OHLCV) no es el
 * mismo que exporta MT5 (fecha/hora en columnas separadas), así que este
 * script hace la conversión aquí mismo; el importador del framework no
 * necesita saber de dónde vino el CSV.
 *
 * Descarga en TRAMOS (por defecto de 6 meses) en vez de una sola llamada
 * gigante: así se ve el progreso tramo a tramo, y si la red falla a mitad de
 * un histórico de 13 años, sólo se reintenta ese tramo, no todo desde cero.
 * Cada tramo se escribe al fichero según llega (no se acumula todo en
 * memoria).
 *
 * Uso:
 *   node scripts/fetch-dukascopy.mjs --from 2011-09-19 --to 2024-11-26 --tf m5 --out downloads/nas100-dukascopy-m5.csv
 *   [--chunk-months 6]
 */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : (process.argv[i + 1] ?? fallback);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Convierte un epoch ms (UTC) a las columnas <DATE>/<TIME> de MT5. */
function toMt5DateTime(tsMs) {
  const d = new Date(tsMs);
  const date = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return { date, time };
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchChunkWithRetry(instrument, timeframe, from, to, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await getHistoricalRates({
        instrument,
        dates: { from, to },
        timeframe,
        format: "array",
      });
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        process.stdout.write(` (fallo, reintento ${attempt + 1}/${retries}) `);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw lastError;
}

async function main() {
  const from = arg("from", "2011-09-19");
  const to = arg("to", new Date().toISOString().slice(0, 10));
  const timeframe = arg("tf", "m5");
  const out = arg("out", `downloads/nas100-dukascopy-${timeframe}.csv`);
  const chunkMonths = Number(arg("chunk-months", "6"));

  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);

  mkdirSync(dirname(out), { recursive: true });
  const stream = createWriteStream(out, { encoding: "utf8" });
  stream.write("<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n");

  // Cuenta cuántos tramos habrá, sólo para mostrar "[3/27]" en el progreso.
  let totalChunks = 0;
  for (let t = fromDate; t < toDate; t = addMonths(t, chunkMonths)) totalChunks++;

  console.log(`Descargando usatechidxusd (${timeframe}) de Dukascopy: ${from} → ${to}`);
  console.log(`En ${totalChunks} tramos de ${chunkMonths} meses.\n`);

  let total = 0;
  let chunkStart = fromDate;
  let chunkIndex = 0;

  while (chunkStart < toDate) {
    const chunkEnd = new Date(Math.min(addMonths(chunkStart, chunkMonths).getTime(), toDate.getTime()));
    chunkIndex++;
    process.stdout.write(`  [${chunkIndex}/${totalChunks}] ${isoDay(chunkStart)} → ${isoDay(chunkEnd)} …`);

    const rows = await fetchChunkWithRetry("usatechidxusd", timeframe, chunkStart, chunkEnd);

    for (const row of rows) {
      const [ts, open, high, low, close, volume] = row;
      const { date, time } = toMt5DateTime(ts);
      stream.write(`${date}\t${time}\t${open}\t${high}\t${low}\t${close}\t${Math.round(volume ?? 0)}\t0\t0\n`);
    }
    total += rows.length;
    console.log(` ${rows.length} velas (acumulado ${total})`);

    chunkStart = chunkEnd;
  }

  await new Promise((resolve) => stream.end(resolve));

  console.log(`\nListo: ${out} (${total} velas en total)`);
  console.log("\nSiguiente paso:");
  console.log(`  pnpm trf data:import --file "${out}" --tf ${timeframe.toUpperCase()} --tz UTC`);
}

main().catch((err) => {
  console.error("\nError descargando de Dukascopy:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
