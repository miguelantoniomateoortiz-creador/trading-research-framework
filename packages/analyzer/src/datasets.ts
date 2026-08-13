import { getSplitByName, recordEvaluation, type SqliteDatabase, type TradeQuery } from "@trf/database";
import { ConfigError, type DatasetSplit } from "@trf/shared";

/**
 * PUENTE ENTRE SPLITS Y CONSULTAS.
 *
 * Todo análisis se ejecuta contra un split con nombre, nunca contra "todos los
 * datos". Obligar a nombrar el conjunto tiene un efecto práctico: es imposible
 * mirar sin querer el periodo de validación, porque hay que escribirlo.
 */

export function splitToQuery(split: DatasetSplit, extra: TradeQuery = {}): TradeQuery {
  return {
    ...extra,
    instrumentId: split.instrumentId,
    fromTs: split.startTs,
    toTs: split.endTs,
  };
}

export interface ResolvedSplit {
  readonly split: DatasetSplit;
  readonly query: TradeQuery;
}

export function resolveSplit(
  db: SqliteDatabase,
  instrumentId: string,
  name: string,
  extra: TradeQuery = {},
): ResolvedSplit {
  const split = getSplitByName(db, instrumentId, name);
  if (split === null) {
    throw new ConfigError(`No existe el split "${name}" para el instrumento "${instrumentId}"`, {
      instrumentId,
      name,
    });
  }
  return { split, query: splitToQuery(split, extra) };
}

/**
 * Marca que se ha evaluado algo contra un split y avisa si se está gastando.
 *
 * El dataset de validación es un recurso que se consume. Cada vez que se mira,
 * se pierde parte de su independencia: con veinte hipótesis probadas contra el
 * mismo 2025, "pasó la validación" ya sólo significa "fue la mejor de veinte".
 */
export interface EvaluationWarning {
  readonly splitName: string;
  readonly evaluationCount: number;
  readonly message: string;
}

export function recordSplitUse(db: SqliteDatabase, split: DatasetSplit): EvaluationWarning | null {
  const count = recordEvaluation(db, split.id);
  if (split.role === "training") return null;

  if (count > 20) {
    return {
      splitName: split.name,
      evaluationCount: count,
      message:
        `El split "${split.name}" se ha usado ${count} veces. A estas alturas ya NO es fuera de muestra: ` +
        "está actuando como un segundo conjunto de entrenamiento. Reserva un periodo nuevo antes de sacar conclusiones.",
    };
  }
  if (count > 10) {
    return {
      splitName: split.name,
      evaluationCount: count,
      message:
        `El split "${split.name}" se ha usado ${count} veces. Ve pensando en apartar un periodo virgen: ` +
        "cada evaluación adicional resta valor a la validación.",
    };
  }
  return null;
}
