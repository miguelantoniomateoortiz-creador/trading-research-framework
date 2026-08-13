import { listVariables, materializeFeature } from "@trf/database";
import {
  analyzeAll,
  assertHypothesisSafe,
  buildRegistry,
  describe as describePredicate,
  discoverPatterns,
  evaluateCohort,
  evaluateComplement,
  loadFeatureMatrix,
  parseExpression,
  predictorKeys,
  recordSplitUse,
  resolveSplit,
  splitStability,
  collectVariables,
} from "@trf/analyzer";
import { summarize } from "@trf/shared";
import { getFlag, getNumber, getString, requireString, type ParsedArgs } from "../args.js";
import { METRIC_HEADERS, heading, int, metricsBlock, metricsRow, num, pct, table, warn } from "../format.js";
import { openContext } from "../context.js";

/** Comandos de análisis: catálogo, marginales y cohortes. */

export async function variablesList(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const causality = args.options.get("causality");
  const definitions = listVariables(
    context.db,
    typeof causality === "string" ? { causality: causality as "predictor" } : {},
  );

  console.log(heading(`Registro de variables (${definitions.length})`));
  console.log(
    table(
      ["Clave", "Tipo", "Causalidad", "Unidad", "Plugin", "Descripción"],
      definitions.map((d) => [
        d.key,
        d.valueType,
        d.causality,
        d.unit,
        d.producedBy,
        d.description.slice(0, 60),
      ]),
    ),
  );
  console.log(
    "\nSólo las variables 'predictor' pueden usarse en hipótesis. Las 'outcome' se conocen al cerrar\n" +
      "la operación y las 'meta' identifican, no explican.",
  );
  context.db.close();
}

function ruleFilter(args: ParsedArgs): { entryRuleId?: string } {
  const rule = args.options.get("rule");
  return typeof rule === "string" ? { entryRuleId: rule } : {};
}

export async function analyzeMarginal(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const splitName = requireString(args, "split");
  const top = getNumber(args, "top", 12);
  const minCount = getNumber(args, "min-count", 50);

  const { split, query } = resolveSplit(context.db, context.instrument.id, splitName, ruleFilter(args));
  const definitions = listVariables(context.db);
  const registry = buildRegistry(definitions);
  const predictors = predictorKeys(definitions);

  if (predictors.length === 0) {
    throw new Error("No hay variables predictoras registradas. Ejecuta 'trf run' primero.");
  }

  console.log(heading(`Análisis marginal · split "${split.name}" (${split.role})`));
  console.log(`Cargando ${predictors.length} variables…`);

  const matrix = loadFeatureMatrix(context.db, { variables: predictors, query });
  if (matrix.size === 0) {
    throw new Error("El split no contiene operaciones. ¿Has ejecutado 'trf run' con este rango de fechas?");
  }

  const baseline = summarize(matrix.pnl);
  console.log(`\nPoblación completa (${int(matrix.size)} operaciones):\n`);
  console.log(metricsBlock(baseline));

  const analyses = analyzeAll(matrix, predictors, registry, { minCount });

  console.log(heading(`Variables con más señal (top ${top})`));
  console.log(
    table(
      ["Variable", "Mejor tramo", "Ops", "WR", "Expect.", "Lift", "Corr.", "q-valor"],
      analyses.slice(0, top).map((analysis) => [
        analysis.variable,
        analysis.bestBucket?.label ?? "—",
        int(analysis.bestBucket?.count ?? 0),
        pct(analysis.bestBucket?.metrics.winRate ?? Number.NaN),
        num(analysis.bestBucket?.metrics.expectancy ?? Number.NaN),
        num(analysis.bestBucket?.lift ?? Number.NaN),
        num(analysis.correlation, 3),
        analysis.qValue < 0.0001 ? "<1e-4" : num(analysis.qValue, 4),
      ]),
    ),
  );

  console.log(
    "\nEl q-valor ya está corregido por el número de variables examinadas (Benjamini-Hochberg).\n" +
      "Un q alto significa que ese 'mejor tramo' es lo que cabría esperar por azar.",
  );

  if (getFlag(args, "detail")) {
    const best = analyses[0];
    if (best !== undefined) {
      console.log(heading(`Detalle de ${best.variable}`));
      console.log(
        table(
          ["Tramo", "Ops", "Cobertura", "WR", "PF", "Expect.", "Lift"],
          best.buckets.map((bucket) => [
            bucket.label,
            int(bucket.count),
            pct(bucket.coverage),
            pct(bucket.metrics.winRate),
            num(bucket.metrics.profitFactor),
            num(bucket.metrics.expectancy),
            num(bucket.lift),
          ]),
        ),
      );
    }
  }

  const warning = recordSplitUse(context.db, split);
  if (warning !== null) console.log(warn(warning.message));
  context.db.close();
}

export async function analyzeCohort(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const splitName = requireString(args, "split");
  const expression = requireString(args, "where");
  const diagnostic = getFlag(args, "diagnostic");

  const { split, query } = resolveSplit(context.db, context.instrument.id, splitName, ruleFilter(args));
  const definitions = listVariables(context.db);
  const registry = buildRegistry(definitions);

  const predicate = parseExpression(expression);
  assertHypothesisSafe(predicate, registry, diagnostic ? { purpose: "diagnostic" } : {});

  const variables = collectVariables(predicate);
  const matrix = loadFeatureMatrix(context.db, { variables, query });

  const labels = new Map(definitions.map((d) => [d.key, d.label]));
  console.log(heading(`Cohorte · split "${split.name}" (${split.role})`));
  console.log(`Hipótesis: ${describePredicate(predicate, labels)}`);
  if (diagnostic) console.log("Modo DIAGNÓSTICO: se permiten variables de resultado. No sirve para validar nada.");

  const result = evaluateCohort(matrix, predicate);
  if (result.metrics.count === 0) {
    console.log("\nNinguna operación cumple la condición.");
    context.db.close();
    return;
  }

  console.log(`\nCobertura: ${pct(result.coverage)} de ${int(matrix.size)} operaciones\n`);
  console.log(metricsBlock(result.metrics));

  console.log(heading("Comparación"));
  console.log(
    table(METRIC_HEADERS, [
      metricsRow("Cumple", result.metrics),
      metricsRow("No cumple", evaluateComplement(matrix, result.mask)),
      metricsRow("Población", summarize(matrix.pnl)),
    ]),
  );

  const stability = splitStability(matrix, result.mask);
  console.log(heading("Estabilidad temporal (mitades del split)"));
  console.log(
    table(METRIC_HEADERS, [
      metricsRow("1ª mitad", stability.first),
      metricsRow("2ª mitad", stability.second),
    ]),
  );
  if (Math.abs(stability.winRateDelta) > 0.1) {
    console.log(
      warn(
        `El win rate cambia ${pct(Math.abs(stability.winRateDelta))} entre mitades. ` +
          "Un edge real no debería moverse tanto: sospecha de sobreajuste antes de gastar la validación.",
      ),
    );
  }

  const warning = recordSplitUse(context.db, split);
  if (warning !== null) console.log(warn(warning.message));
  context.db.close();
}

function getOptionalNumber(args: ParsedArgs, key: string): number | undefined {
  const value = args.options.get(key);
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`La opción --${key} debe ser numérica`);
  return parsed;
}

export async function discover(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const splitName = requireString(args, "split");
  const minTrades = getNumber(args, "min-trades", 100);
  const minWinRate = getOptionalNumber(args, "min-winrate");
  const minProfitFactor = getOptionalNumber(args, "min-pf");
  const maxDrawdownPct = getOptionalNumber(args, "max-dd-pct");
  const maxConditions = getNumber(args, "max-conditions", 3);
  const top = getNumber(args, "top", 20);

  const { split, query } = resolveSplit(context.db, context.instrument.id, splitName, ruleFilter(args));
  const definitions = listVariables(context.db);
  const registry = buildRegistry(definitions);
  const predictors = predictorKeys(definitions);

  if (predictors.length === 0) {
    throw new Error("No hay variables predictoras registradas. Ejecuta 'trf run' primero.");
  }

  console.log(heading(`Pattern Discovery · split "${split.name}" (${split.role})`));
  const ruleOption = args.options.get("rule");
  if (typeof ruleOption === "string") console.log(`Regla de entrada: ${ruleOption} (filtrado)`);
  console.log(
    `Umbrales: ≥${int(minTrades)} operaciones` +
      (minWinRate !== undefined ? `, WR ≥ ${pct(minWinRate)}` : "") +
      (minProfitFactor !== undefined ? `, PF ≥ ${num(minProfitFactor)}` : "") +
      (maxDrawdownPct !== undefined ? `, DD ≤ ${pct(maxDrawdownPct)}` : "") +
      ` · hasta ${int(maxConditions)} condiciones`,
  );
  console.log(`Cargando ${predictors.length} variables…`);

  const matrix = loadFeatureMatrix(context.db, { variables: predictors, query });
  if (matrix.size === 0) {
    throw new Error("El split no contiene operaciones. ¿Has ejecutado 'trf run' con este rango de fechas?");
  }

  console.log("Buscando…");
  const report = await discoverPatterns(
    matrix,
    predictors,
    registry,
    {
      minTrades,
      minWinRate,
      minProfitFactor,
      maxDrawdownPct,
      maxConditions,
      top,
    },
    (evaluated) => process.stdout.write(`\r  ${int(evaluated)} combinaciones evaluadas…`),
  );
  process.stdout.write("\r" + " ".repeat(60) + "\r");

  console.log(
    `\nEspacio de búsqueda: ${int(report.searchSpaceSize)} combinaciones evaluadas ` +
      `(${int(report.level1Survivors)} condiciones simples superaron la poda de ${int(minTrades)} operaciones, ` +
      `de ${int(report.candidateVariables)} variables candidatas).`,
  );
  if (report.truncated) {
    console.log(warn("La búsqueda se cortó por el límite de seguridad (--min-trades muy bajo para tantas variables). Sube --min-trades o reduce --max-conditions."));
  }
  console.log(`Tiempo: ${(report.elapsedMs / 1000).toFixed(1)} s`);

  const labels = new Map(definitions.map((d) => [d.key, d.label]));

  if (report.results.length === 0) {
    console.log(
      "\nNingún patrón cumple los umbrales pedidos, o ninguno es distinguible del azar tras corregir por " +
        `multiplicidad (${int(report.searchSpaceSize)} combinaciones probadas). Esto es un resultado válido: ` +
        "no todo instrumento/periodo tiene un edge explotable con las variables actuales.",
    );
    context.db.close();
    return;
  }

  console.log(heading(`Patrones encontrados (${int(report.totalMatches)}, mostrando ${int(report.results.length)})`));
  console.log(
    table(
      ["#", "Condiciones", "Hipótesis", "Ops", "WR", "PF", "Expect.", "DD%", "R²", "q-valor"],
      report.results.map((result, i) => [
        String(i + 1),
        String(result.depth),
        describePredicate(result.predicate, labels).slice(0, 70),
        int(result.metrics.count),
        pct(result.metrics.winRate),
        num(result.metrics.profitFactor),
        num(result.metrics.expectancy),
        pct(result.metrics.maxDrawdownPct),
        num(result.metrics.equityR2, 3),
        result.qValue < 0.0001 ? "<1e-4" : num(result.qValue, 4),
      ]),
    ),
  );

  console.log(
    "\nOrdenados por q-valor (rigor estadístico sobre TODO lo evaluado) y, en caso de empate, por R²\n" +
      "(estabilidad de la equity). Un q-valor bajo con R² alto es lo que vale la pena convertir en hipótesis\n" +
      "con 'hypothesis:save' (nivel 7) y validar contra el split de validación — nunca actuar sobre esto\n" +
      "directamente sin ese paso.",
  );

  const warning = recordSplitUse(context.db, split);
  if (warning !== null) console.log(warn(warning.message));
  context.db.close();
}

export async function variablesMaterialize(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const key = getString(args, "key", "");
  if (key.length === 0) throw new Error("Indica la variable: trf variables:materialize --key volatility.atr");

  const result = materializeFeature(context.db, key);
  console.log(
    result.created
      ? `Variable "${key}" materializada como columna ${result.column}, con índice.`
      : `La variable "${key}" ya estaba materializada (${result.column}); índice verificado.`,
  );
  console.log("Los filtros sobre esta variable pasan a resolverse por índice en lugar de escanear la tabla.");
  context.db.close();
}
