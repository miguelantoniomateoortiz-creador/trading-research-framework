import type { CohortMetrics } from "@trf/shared";

/**
 * VALIDACIÓN FORMAL — nivel 7.
 *
 * La pregunta que responde este módulo: "¿el resultado en el split de
 * validación confirma la hipótesis, o la desmiente?".
 *
 * LA REGLA CENTRAL, tomada tal cual del enunciado del proyecto: se compara
 * contra el INTERVALO DE CONFIANZA de entrenamiento, no contra su valor
 * puntual. Que el win rate baje del 68% al 64% no es un fallo si el IC95% de
 * entrenamiento era [63%, 73%] — 64% sigue siendo compatible con ese
 * intervalo. Comparar sólo puntos convierte cualquier ruido normal de
 * muestreo en un "la hipótesis falló" prematuro.
 *
 * Además de caer dentro del IC, se exige que la expectancy en validación siga
 * siendo positiva: un win rate compatible con el IC pero con expectancy
 * negativa (payoff peor de lo esperado) no es una ventaja operable.
 */

export interface ValidationDecision {
  readonly passed: boolean;
  readonly reason: string;
}

export function decideValidation(training: CohortMetrics, validation: CohortMetrics): ValidationDecision {
  if (validation.count === 0) {
    return {
      passed: false,
      reason: "El split de validación no tiene ninguna operación que cumpla la hipótesis.",
    };
  }

  const lower = training.winRateCi.lower;
  const upper = training.winRateCi.upper;

  if (!Number.isFinite(lower)) {
    return {
      passed: false,
      reason: "El intervalo de confianza de entrenamiento no es válido (¿muy pocas operaciones al guardar la hipótesis?).",
    };
  }

  if (validation.winRate < lower) {
    return {
      passed: false,
      reason:
        `El win rate de validación (${pct(validation.winRate)}) cae por debajo del límite inferior del IC95% ` +
        `de entrenamiento (${pct(lower)}, IC completo [${pct(lower)}, ${pct(upper)}]).`,
    };
  }

  if (!(validation.expectancy > 0)) {
    return {
      passed: false,
      reason:
        `El win rate de validación (${pct(validation.winRate)}) es compatible con el IC95% de entrenamiento ` +
        `[${pct(lower)}, ${pct(upper)}], pero la expectancy en validación (${validation.expectancy.toFixed(2)}) ` +
        "no es positiva: el payoff no compensa. No es una ventaja operable.",
    };
  }

  return {
    passed: true,
    reason:
      `El win rate de validación (${pct(validation.winRate)}) cae dentro del IC95% de entrenamiento ` +
      `[${pct(lower)}, ${pct(upper)}], y la expectancy sigue siendo positiva (${validation.expectancy.toFixed(2)}).`,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Corrección conservadora para una hipótesis guardada FUERA de una búsqueda de
 * `discover` (p.ej. escrita a mano con `analyze:cohort` + `hypothesis:save`).
 *
 * `discover` ya devuelve un q-valor de Benjamini-Hochberg correcto porque
 * conoce el p-valor de TODO lo que evaluó. Aquí sólo se conoce un número —
 * cuántas combinaciones se probaron (`searchSpaceSize`), no su lista de
 * p-valores — así que no se puede recalcular BH exacto. Se usa en su lugar la
 * cota de Bonferroni (p × N, acotada a 1), que es más conservadora que BH:
 * sobreestima el riesgo de falso positivo en vez de subestimarlo, lo cual es
 * el error seguro a cometer aquí.
 */
export function bonferroniQValue(pValue: number, searchSpaceSize: number): number {
  return Math.min(1, pValue * Math.max(1, searchSpaceSize));
}
