import {
  createHypothesis,
  createValidationRun,
  findHypothesis,
  listHypotheses,
  listVariables,
  setHypothesisStatus,
} from "@trf/database";
import {
  assertHypothesisSafe,
  bonferroniQValue,
  buildRegistry,
  collectVariables,
  decideValidation,
  describe as describePredicate,
  evaluateCohort,
  loadFeatureMatrix,
  parseExpression,
  parsePredicate,
  recordSplitUse,
  resolveSplit,
  serializePredicate,
} from "@trf/analyzer";
import { getFlag, getNumber, requireString, type ParsedArgs } from "../args.js";
import { heading, int, metricsBlock, num, pct, table, warn } from "../format.js";
import { openContext } from "../context.js";

/**
 * Comandos de nivel 7: guardar una hipótesis (predicado + resultado de
 * entrenamiento) y validarla formalmente contra un split que aún no se ha
 * mirado.
 */

function getOptionalNumber(args: ParsedArgs, key: string): number | undefined {
  const value = args.options.get(key);
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`La opción --${key} debe ser numérica`);
  return parsed;
}

export async function hypothesisSave(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const name = requireString(args, "name");
  const expression = requireString(args, "where");
  const splitName = requireString(args, "split");
  const description = args.options.get("description");
  const searchSpaceSize = getNumber(args, "search-space", 1);

  const { split, query } = resolveSplit(context.db, context.instrument.id, splitName);
  const definitions = listVariables(context.db);
  const registry = buildRegistry(definitions);

  const predicate = parseExpression(expression);
  assertHypothesisSafe(predicate, registry);

  const variables = collectVariables(predicate);
  const matrix = loadFeatureMatrix(context.db, { variables, query });
  const result = evaluateCohort(matrix, predicate);

  if (result.metrics.count === 0) {
    throw new Error("Ninguna operación del split de entrenamiento cumple esta hipótesis. No se guarda.");
  }

  const criteria: Record<string, unknown> = {};
  const minTrades = getOptionalNumber(args, "min-trades");
  const minWinRate = getOptionalNumber(args, "min-winrate");
  const minPf = getOptionalNumber(args, "min-pf");
  const maxDdPct = getOptionalNumber(args, "max-dd-pct");
  if (minTrades !== undefined) criteria["minTrades"] = minTrades;
  if (minWinRate !== undefined) criteria["minWinRate"] = minWinRate;
  if (minPf !== undefined) criteria["minProfitFactor"] = minPf;
  if (maxDdPct !== undefined) criteria["maxDrawdownPct"] = maxDdPct;

  const hypothesis = createHypothesis(context.db, {
    name,
    description: typeof description === "string" ? description : "",
    predicateJson: serializePredicate(predicate),
    variables,
    criteria,
    trainingMetrics: result.metrics,
    searchSpaceSize,
  });

  const labels = new Map(definitions.map((d) => [d.key, d.label]));
  console.log(heading(`Hipótesis "${hypothesis.name}" guardada`));
  console.log(`Id:          ${hypothesis.id}`);
  console.log(`Hipótesis:   ${describePredicate(predicate, labels)}`);
  console.log(`Split:       "${split.name}" (${split.role})`);
  console.log(`Espacio de búsqueda declarado: ${int(searchSpaceSize)} combinaciones`);
  console.log(`\nMétricas de entrenamiento:\n`);
  console.log(metricsBlock(result.metrics));

  if (searchSpaceSize > 1) {
    const q = bonferroniQValue(result.metrics.pValue, searchSpaceSize);
    console.log(
      `\nq-valor aproximado (Bonferroni, conservador): ${q < 0.0001 ? "<1e-4" : num(q, 4)}\n` +
        "No es el q-valor exacto de Benjamini-Hochberg de 'discover' (ese ya viene corregido); " +
        "es una cota superior conservadora porque aquí sólo se conoce CUÁNTO se buscó, no la lista completa de p-valores.",
    );
  }

  console.log(
    `\nEstado: ${hypothesis.status}. Siguiente paso, cuando estés listo (y sólo entonces):\n` +
      `  pnpm trf hypothesis:validate "${hypothesis.name}" --split <split de validación> --yes`,
  );
  context.db.close();
}

export async function hypothesisList(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const status = args.options.get("status");
  const hypotheses = listHypotheses(
    context.db,
    typeof status === "string" ? { status: status as "draft" } : {},
  );

  console.log(heading(`Hipótesis guardadas (${hypotheses.length})`));
  if (hypotheses.length === 0) {
    console.log("Ninguna todavía. Guarda una con 'trf hypothesis:save'.");
    context.db.close();
    return;
  }

  console.log(
    table(
      ["Id", "Nombre", "Estado", "Ops (train)", "WR", "PF", "Espacio búsq.", "Creada"],
      hypotheses.map((h) => [
        h.id,
        h.name,
        h.status,
        int(h.trainingMetrics?.count ?? 0),
        pct(h.trainingMetrics?.winRate ?? Number.NaN),
        num(h.trainingMetrics?.profitFactor ?? Number.NaN),
        int(h.searchSpaceSize),
        h.createdAt.slice(0, 10),
      ]),
    ),
  );
  context.db.close();
}

export async function hypothesisValidate(args: ParsedArgs): Promise<void> {
  const context = openContext();
  const idOrName = args.positionals[0];
  if (idOrName === undefined) {
    throw new Error('Indica la hipótesis: trf hypothesis:validate "<nombre o id>" --split val --yes');
  }
  const splitName = requireString(args, "split");
  const confirmed = getFlag(args, "yes");

  const hypothesis = findHypothesis(context.db, idOrName);
  if (hypothesis === null) {
    throw new Error(`No hay ninguna hipótesis "${idOrName}". Revisa 'trf hypothesis:list'.`);
  }
  if (hypothesis.status === "validated" || hypothesis.status === "rejected") {
    throw new Error(
      `La hipótesis "${hypothesis.name}" ya fue ${hypothesis.status === "validated" ? "VALIDADA" : "RECHAZADA"} ` +
        "y no se puede revalidar (eso convertiría la validación en un segundo entrenamiento disfrazado). " +
        "Si quieres reintentar con una definición o datos distintos, guarda una hipótesis nueva.",
    );
  }
  if (hypothesis.trainingMetrics === null) {
    throw new Error(`La hipótesis "${hypothesis.name}" no tiene métricas de entrenamiento. Algo salió mal al guardarla.`);
  }

  const { split, query } = resolveSplit(context.db, context.instrument.id, splitName);
  if (split.role === "training") {
    throw new Error(
      `"${splitName}" es un split de ENTRENAMIENTO. La validación debe correr contra un split de validación u holdout.`,
    );
  }

  if (!confirmed) {
    console.log(heading(`Validar "${hypothesis.name}" contra "${split.name}" (${split.role})`));
    console.log(
      `Este split se ha usado ${int(split.evaluationCount)} vez/veces antes.` +
        (split.evaluationCount > 0
          ? " Cada mirada adicional gasta un poco de su valor como fuera de muestra."
          : " Sería la primera vez — la comprobación más limpia posible."),
    );
    console.log(
      "\nEsto es una acción DELIBERADA, no reversible en espíritu: la hipótesis quedará marcada como\n" +
        "validated o rejected y no se podrá reintentar. Confirma explícitamente con --yes:\n\n" +
        `  pnpm trf hypothesis:validate "${hypothesis.name}" --split ${splitName} --yes`,
    );
    context.db.close();
    return;
  }

  const definitions = listVariables(context.db);
  const registry = buildRegistry(definitions);
  const predicate = parsePredicate(hypothesis.predicateJson);
  assertHypothesisSafe(predicate, registry);

  const variables = collectVariables(predicate);
  const matrix = loadFeatureMatrix(context.db, { variables, query });
  const result = evaluateCohort(matrix, predicate);

  const decision = decideValidation(hypothesis.trainingMetrics, result.metrics);

  createValidationRun(context.db, {
    hypothesisId: hypothesis.id,
    splitId: split.id,
    metrics: result.metrics,
    pValue: result.metrics.pValue,
    // Sin búsqueda adicional en este paso (el predicado ya está fijado), el
    // q-valor de esta evaluación concreta es su propio p-valor.
    qValue: result.metrics.pValue,
    passed: decision.passed,
    notes: decision.reason,
  });
  setHypothesisStatus(context.db, hypothesis.id, decision.passed ? "validated" : "rejected");

  const labels = new Map(definitions.map((d) => [d.key, d.label]));
  console.log(heading(`Validación · "${hypothesis.name}"`));
  console.log(`Hipótesis: ${describePredicate(predicate, labels)}`);
  console.log(`Split:     "${split.name}" (${split.role})\n`);

  console.log(heading("Entrenamiento"));
  console.log(metricsBlock(hypothesis.trainingMetrics));

  console.log(heading("Validación (fuera de muestra)"));
  if (result.metrics.count === 0) {
    console.log("Ninguna operación de este split cumple la hipótesis.");
  } else {
    console.log(metricsBlock(result.metrics));
  }

  console.log(heading("Decisión"));
  console.log(decision.passed ? "✓ VALIDADA" : "✖ RECHAZADA");
  console.log(decision.reason);

  const warning = recordSplitUse(context.db, split);
  if (warning !== null) console.log(warn(warning.message));
  context.db.close();
}
