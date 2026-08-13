import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  barCoverage,
  countTrades,
  createSplit,
  deleteSplit,
  findGaps,
  getPluginInstall,
  getSplitByName,
  listImportBatches,
  listPluginInstalls,
  listSplits,
  openDatabase,
  optimize,
  setPluginConfig,
  setPluginEnabled,
} from "@trf/database";
import {
  detectDelimiter,
  detectHeader,
  formatAsMt5Csv,
  formatImportSummary,
  generateNas100Bars,
  importBarsFromFile,
  parseMt5Bars,
  peekLines,
  type ParseError,
} from "@trf/importer";
import { runResearch } from "@trf/analyzer";
import { calendarParts, formatUtcIso, isTimeframe, parseIsoDateUtc, type Timeframe } from "@trf/shared";
import { getFlag, getNumber, getString, requireString, type ParsedArgs } from "../args.js";
import { heading, int, table, warn } from "../format.js";
import { loadRegistry, openContext } from "../context.js";

/** Comandos de datos: generar, importar, inspeccionar, ejecutar. */

export async function dbInit(): Promise<void> {
  const context = openContext();
  optimize(context.db);
  console.log(`Base de datos lista en:\n  ${context.config.databaseFile}`);
  console.log(`Instrumento activo: ${context.instrument.symbol} (${context.instrument.sessionTimezone})`);
  context.db.close();
}

export async function dataGenerate(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const from = getString(args, "from", "2022-01-01");
  const to = getString(args, "to", "2025-12-31");
  const seed = getNumber(args, "seed", 20240101);
  const injectPattern = getFlag(args, "inject-pattern");
  const output = getString(args, "out", join(context.config.importsDir, `nas100-synthetic-${from}_${to}.csv`));

  console.log(`Generando velas M1 sintéticas de NAS100 (${from} → ${to}, semilla ${seed})…`);
  if (injectPattern) {
    console.log("Con patrón inyectado: los días de gap grande revierten durante la primera hora.");
  }

  const bars = [...generateNas100Bars({ startDate: from, endDate: to, seed, injectPattern })];
  writeFileSync(output, formatAsMt5Csv(bars), "utf8");

  console.log(`${int(bars.length)} velas escritas en:\n  ${output}`);
  console.log(`\nSiguiente paso:\n  pnpm trf data:import --file "${output}" --tz America/New_York`);
  context.db.close();
}

export async function dataImport(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const filePath = resolve(requireString(args, "file"));
  const timeframeRaw = getString(args, "tf", "M1");
  if (!isTimeframe(timeframeRaw)) throw new Error(`Timeframe desconocido: ${timeframeRaw}`);

  const sourceTimezone = getString(args, "tz", "UTC");
  console.log(`Importando ${filePath}`);
  console.log(`Zona horaria del origen: ${sourceTimezone}`);
  if (sourceTimezone === "UTC" && !getFlag(args, "yes")) {
    console.log(
      "\n⚠  Estás importando como UTC. Si el CSV viene del terminal MT5, casi seguro está en hora\n" +
        "   del servidor del bróker (UTC+2/+3 con horario de verano europeo). Indícalo con --tz,\n" +
        "   por ejemplo: --tz Europe/Riga. Ver docs/03-importar-mt5.md",
    );
  }

  const summary = await importBarsFromFile({
    db: context.db,
    instrumentId: context.instrument.id,
    timeframe: timeframeRaw as Timeframe,
    filePath,
    sourceTimezone,
    onProgress: ({ rowsRead }) => {
      if (rowsRead % 100_000 === 0) process.stdout.write(`  ${int(rowsRead)} filas…\r`);
    },
  });

  console.log(`\n${formatImportSummary(summary)}`);
  optimize(context.db);
  context.db.close();
}

/**
 * Inspecciona un CSV ANTES de importarlo.
 *
 * Existe por una razón muy concreta: el error de zona horaria no da ningún
 * fallo, sólo conclusiones equivocadas. Este comando parsea las primeras filas
 * con la zona que le indiques y muestra en qué minuto del día se concentra la
 * actividad. Si el pico de volumen no cae cerca de las 09:30 del mercado, la
 * zona está mal y lo ves antes de meter cinco años de datos torcidos.
 */
export async function dataPeek(args: ParsedArgs): Promise<void> {
  const filePath = resolve(requireString(args, "file"));
  const sourceTimezone = getString(args, "tz", "UTC");
  const sampleSize = getNumber(args, "sample", 20_000);

  console.log(heading("Muestra en crudo"));
  const rawLines = await peekLines(filePath, 4);
  for (const line of rawLines) console.log(`  ${line.slice(0, 160)}`);

  const first = rawLines[0] ?? "";
  const delimiter = detectDelimiter(first);
  const hasHeader = await detectHeader(filePath);
  console.log(heading("Formato detectado"));
  console.log(`Separador:  ${delimiter === "\t" ? "tabulador" : `"${delimiter}"`}`);
  console.log(`Cabecera:   ${hasHeader ? "sí" : "no (mapeo posicional)"}`);
  console.log(`Columnas:   ${first.split(delimiter).length}`);
  console.log(`Zona usada: ${sourceTimezone}`);

  const errors: ParseError[] = [];
  const minuteCounts = new Map<number, number>();
  const volumeByMinute = new Map<number, number>();
  let count = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  const context = openContext();
  const timeZone = context.instrument.sessionTimezone;
  context.db.close();

  for await (const row of parseMt5Bars(filePath, { sourceTimezone }, (e) => {
    if (errors.length < 20) errors.push(e);
  })) {
    if (firstTs === null) firstTs = row.bar.ts;
    lastTs = row.bar.ts;
    const minute = calendarParts(row.bar.ts, timeZone).minuteOfDay;
    minuteCounts.set(minute, (minuteCounts.get(minute) ?? 0) + 1);
    volumeByMinute.set(minute, (volumeByMinute.get(minute) ?? 0) + row.bar.tickVolume);
    if (++count >= sampleSize) break;
  }

  console.log(heading(`Muestra parseada (${int(count)} velas)`));
  console.log(`Primera:  ${firstTs === null ? "—" : formatUtcIso(firstTs)} UTC`);
  console.log(`Última:   ${lastTs === null ? "—" : formatUtcIso(lastTs)} UTC`);
  console.log(`Errores:  ${errors.length}${errors.length >= 20 ? "+ (muestra truncada)" : ""}`);
  for (const error of errors.slice(0, 5)) console.log(`   L${error.lineNumber}: ${error.message}`);

  // Dónde se concentra la actividad, en hora de mercado.
  const ranked = [...volumeByMinute.entries()]
    .filter(([, volume]) => volume > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (ranked.length > 0) {
    console.log(heading("Minutos con más volumen (hora del mercado)"));
    console.log(
      table(
        ["Hora", "Minuto del día", "Velas", "Volumen"],
        ranked.map(([minute, volume]) => [
          `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
          String(minute),
          int(minuteCounts.get(minute) ?? 0),
          int(volume),
        ]),
      ),
    );

    const peak = ranked[0]?.[0] ?? 0;
    const distance = Math.abs(peak - 570);
    if (distance <= 15) {
      console.log(`\n✓ El pico de actividad cae en el minuto ${peak} (09:30 = 570). La zona horaria cuadra.`);
    } else {
      console.log(
        `\n⚠  El pico de actividad cae en el minuto ${peak}, a ${distance} minutos de la apertura (570).\n` +
          `   Casi seguro la zona horaria es incorrecta. Desfase aparente: ${(distance / 60).toFixed(1)} h.\n` +
          "   Prueba con --tz Europe/Riga (UTC+2/+3, el más común) o consulta docs/03-importar-mt5.md",
      );
    }
  }

  const rango = firstTs !== null && lastTs !== null ? (lastTs - firstTs) / 86_400_000 : 0;
  console.log(
    `\nSi todo cuadra:\n  pnpm trf data:import --file "${filePath}" --tz ${sourceTimezone}` +
      (rango > 0 ? `\n  (la muestra cubre ${rango.toFixed(1)} días; el fichero completo será mayor)` : ""),
  );
}

export async function dataStatus(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const timeframeRaw = getString(args, "tf", "M1");
  if (!isTimeframe(timeframeRaw)) throw new Error(`Timeframe desconocido: ${timeframeRaw}`);
  const timeframe = timeframeRaw as Timeframe;

  const coverage = barCoverage(context.db, context.instrument.id, timeframe);
  console.log(heading(`Datos de ${context.instrument.symbol} (${timeframe})`));
  console.log(`Velas:      ${int(coverage.count)}`);
  console.log(
    `Rango:      ${coverage.firstTs === null ? "—" : formatUtcIso(coverage.firstTs)} → ${
      coverage.lastTs === null ? "—" : formatUtcIso(coverage.lastTs)
    }`,
  );
  console.log(`Operaciones: ${int(countTrades(context.db, { instrumentId: context.instrument.id }))}`);

  const gaps = findGaps(context.db, { instrumentId: context.instrument.id, timeframe }, 24 * 60);
  console.log(heading(`Huecos de más de 24 h (${gaps.length})`));
  if (gaps.length === 0) {
    console.log("Ninguno.");
  } else {
    console.log(
      table(
        ["Desde", "Hasta", "Horas"],
        gaps
          .slice(0, 15)
          .map((gap) => [formatUtcIso(gap.fromTs), formatUtcIso(gap.toTs), (gap.minutes / 60).toFixed(1)]),
      ),
    );
    console.log(
      "\nLos huecos de fin de semana son normales. Los de mitad de semana significan datos que faltan:\n" +
        "revisa si coinciden con días de alta volatilidad antes de sacar conclusiones.",
    );
  }

  const batches = listImportBatches(context.db, context.instrument.id);
  console.log(heading(`Importaciones (${batches.length})`));
  if (batches.length > 0) {
    console.log(
      table(
        ["Lote", "Formato", "Fichero", "Leídas", "Rechazadas"],
        batches.slice(0, 10).map((b) => [b.id, b.format, b.sourceFile, int(b.rowsRead), int(b.rowsRejected)]),
      ),
    );
  }
  context.db.close();
}

export async function run(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const registry = await loadRegistry(context);

  const fromOption = args.options.get("from");
  const toOption = args.options.get("to");

  // Antes este flag no existía y `runResearch` asumía siempre M1 por dentro.
  // Con datos importados en otro timeframe (M5, M15...) la corrida buscaba
  // velas M1 que nunca existían y terminaba en silencio con 0 operaciones,
  // sin ningún error: parecía que el pipeline funcionaba pero no hacía nada.
  const timeframeRaw = getString(args, "tf", "M1");
  if (!isTimeframe(timeframeRaw)) throw new Error(`Timeframe desconocido: ${timeframeRaw}`);
  const timeframe = timeframeRaw as Timeframe;

  const coverage = barCoverage(context.db, context.instrument.id, timeframe);
  if (coverage.count === 0) {
    throw new Error(
      `No hay velas ${timeframe} para ${context.instrument.symbol}. ` +
        `Revisa con qué --tf importaste los datos (pnpm trf data:status --tf ${timeframe}) ` +
        "y pasa el mismo valor aquí con --tf.",
    );
  }

  console.log(heading("Corrida de investigación"));
  console.log(`Timeframe:            ${timeframe} (${int(coverage.count)} velas disponibles)`);
  console.log(`Plugins de variables: ${registry.featurePlugins().map((p) => p.manifest.id).join(", ") || "ninguno"}`);
  console.log(`Plugins de entrada:   ${registry.entryPlugins().map((p) => p.manifest.id).join(", ") || "ninguno"}`);
  console.log(`Huella del conjunto de features: ${registry.featureSetVersion()}`);

  // Conexión SEPARADA para los volcados de operaciones por lotes durante el
  // recorrido: `context.db` está ocupado iterando las velas con
  // `iterateBars`, y better-sqlite3 no permite ejecutar otra consulta en esa
  // misma conexión mientras ese recorrido sigue abierto. Ver el comentario en
  // `RunOptions.writerDb` (packages/analyzer/src/runner.ts) para el porqué.
  const writer = openDatabase();

  let summary;
  try {
    summary = await runResearch({
      db: context.db,
      writerDb: writer.db,
      instrument: context.instrument,
      registry,
      timeframe,
      ...(typeof fromOption === "string" ? { fromTs: parseIsoDateUtc(fromOption) } : {}),
      ...(typeof toOption === "string" ? { toTs: parseIsoDateUtc(toOption) } : {}),
      verbose: getFlag(args, "verbose"),
      onProgress: ({ barsProcessed, tradesClosed }) => {
        process.stdout.write(`  ${int(barsProcessed)} velas, ${int(tradesClosed)} operaciones…\r`);
      },
    });
  } finally {
    writer.db.close();
  }

  console.log(`\nVelas procesadas:   ${int(summary.barsProcessed)}`);
  console.log(`Señales generadas:  ${int(summary.signalsGenerated)}`);
  console.log(`Operaciones:        ${int(summary.tradesClosed)} (escritas ${int(summary.tradesWritten)})`);
  console.log(`Reglas de entrada:  ${summary.entryRuleIds.join(", ")}`);
  console.log(`Tiempo:             ${(summary.elapsedMs / 1000).toFixed(1)} s`);

  optimize(context.db);
  context.db.close();
}

export async function pluginsList(): Promise<void> {
  const context = openContext();
  const registry = await loadRegistry(context);
  const installs = listPluginInstalls(context.db);

  console.log(heading(`Plugins instalados (${installs.length})`));
  console.log(
    table(
      ["Id", "Versión", "Estado", "Tipo", "Variables", "Autor"],
      installs.map((install) => {
        const loaded = registry.get(install.id);
        const kinds = loaded?.manifest.kind.join("+") ?? "—";
        const variables = loaded === null || loaded === undefined ? "—" : String(loaded.manifest.provides.length);
        return [install.id, install.version, install.enabled ? "activo" : "inactivo", kinds, variables, install.author];
      }),
    ),
  );

  console.log(heading("Orden de ejecución (resuelto por dependencias)"));
  console.log(registry.resolveOrder().join(" → ") || "—");
  context.db.close();
}

export async function pluginsToggle(args: ParsedArgs, enabled: boolean): Promise<void> {
  const context = openContext();
  const id = args.positionals[0];
  if (id === undefined) throw new Error("Indica el id del plugin: trf plugins:enable <id>");

  if (!setPluginEnabled(context.db, id, enabled)) {
    throw new Error(`No hay ningún plugin registrado con id "${id}". Ejecuta 'trf plugins:list' primero.`);
  }
  console.log(`Plugin "${id}" ${enabled ? "activado" : "desactivado"}.`);
  console.log("Recuerda volver a ejecutar 'trf run': la huella del conjunto de features ha cambiado.");
  context.db.close();
}

/**
 * Cambia la configuración de un plugin ya instalado.
 *
 * `setPluginConfig` fusiona (no reemplaza) las claves indicadas sobre la
 * configuración actual, así que basta con pasar la clave que quieres tocar.
 * Un cambio de configuración cambia la HUELLA de la regla de entrada
 * (`entryRuleId` = id del plugin + hash de su config), así que las
 * operaciones generadas antes y después del cambio conviven en la base
 * distinguidas por esa huella: no hace falta borrar nada.
 */
export async function pluginsConfig(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const id = args.positionals[0];
  if (id === undefined) {
    throw new Error(
      'Indica el id del plugin: trf plugins:config <id> --set \'{"clave": valor}\'',
    );
  }

  const current = getPluginInstall(context.db, id);
  if (current === null) {
    throw new Error(`No hay ningún plugin registrado con id "${id}". Ejecuta 'trf plugins:list' primero.`);
  }

  const setRaw = args.options.get("set");
  if (typeof setRaw !== "string") {
    console.log(heading(`Configuración actual de "${id}"`));
    console.log(JSON.stringify(current.config, null, 2));
    context.db.close();
    return;
  }

  let patch: Record<string, unknown>;
  try {
    patch = JSON.parse(setRaw) as Record<string, unknown>;
  } catch {
    throw new Error(`--set no es JSON válido: ${setRaw}`);
  }

  const merged = { ...current.config, ...patch };
  setPluginConfig(context.db, id, merged);

  console.log(`Configuración de "${id}" actualizada:`);
  console.log(JSON.stringify(merged, null, 2));
  console.log(
    "\nLa huella de la regla de entrada ha cambiado. Vuelve a ejecutar 'trf run' para generar las\n" +
      "operaciones con la nueva configuración; las anteriores siguen en la base, con su propia huella\n" +
      "(las verás distintas en 'Reglas de entrada' al terminar 'run').",
  );
  context.db.close();
}

export async function splitsCreate(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const name = requireString(args, "name");
  const role = getString(args, "role", "training");
  if (role !== "training" && role !== "validation" && role !== "holdout") {
    throw new Error("--role debe ser training, validation o holdout");
  }

  const split = createSplit(context.db, {
    id: `${context.instrument.id}_${name}`,
    name,
    instrumentId: context.instrument.id,
    role,
    startTs: parseIsoDateUtc(requireString(args, "from")),
    endTs: parseIsoDateUtc(requireString(args, "to")),
    embargoDays: getNumber(args, "embargo", 5),
    description: getString(args, "description", ""),
  });

  console.log(`Split "${split.name}" (${split.role}) creado.`);
  context.db.close();
}

/**
 * Borra un split por nombre, para poder redefinirlo (p.ej. tras ampliar el
 * historial disponible). No borra operaciones ni afecta a nada más: un split
 * es sólo un rango de fechas con nombre y un contador de usos.
 */
export async function splitsDelete(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const name = args.positionals[0];
  if (name === undefined) throw new Error("Indica el nombre del split: trf splits:delete <nombre>");

  const split = getSplitByName(context.db, context.instrument.id, name);
  if (split === null) {
    throw new Error(`No hay ningún split llamado "${name}" para ${context.instrument.symbol}.`);
  }
  if (split.evaluationCount > 0) {
    console.log(
      warn(
        `El split "${name}" se había usado ${split.evaluationCount} vez/veces antes de borrarlo. ` +
          "Si lo recreas con el mismo rango de fechas, ese uso previo sigue siendo válido: no era ruido, era información real.",
      ),
    );
  }
  deleteSplit(context.db, split.id);
  console.log(`Split "${name}" borrado.`);
  context.db.close();
}

export async function splitsList(): Promise<void> {
  const context = openContext();
  const splits = listSplits(context.db, { instrumentId: context.instrument.id });

  console.log(heading(`Splits de ${context.instrument.symbol}`));
  if (splits.length === 0) {
    console.log("Ninguno. Crea al menos uno de entrenamiento y uno de validación:\n");
    console.log('  pnpm trf splits:create --name train --role training --from 2022-01-01 --to 2025-01-01');
    console.log('  pnpm trf splits:create --name val --role validation --from 2025-01-10 --to 2026-01-01');
  } else {
    console.log(
      table(
        ["Nombre", "Rol", "Desde", "Hasta", "Embargo", "Usos", "Operaciones"],
        splits.map((split) => [
          split.name,
          split.role,
          formatUtcIso(split.startTs).slice(0, 10),
          formatUtcIso(split.endTs).slice(0, 10),
          `${split.embargoDays} d`,
          String(split.evaluationCount),
          int(
            countTrades(context.db, {
              instrumentId: split.instrumentId,
              fromTs: split.startTs,
              toTs: split.endTs,
            }),
          ),
        ]),
      ),
    );
  }
  context.db.close();
}
