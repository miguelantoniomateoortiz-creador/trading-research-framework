import type { VariableCausality } from "@trf/shared";

/**
 * Regla 2 del README de nivel 8: la causalidad de cada variable SIEMPRE
 * visible y distinguida por color. `outcome` en rojo no es un detalle
 * estético — es el mismo aviso que `assertHypothesisSafe` hace cumplir en el
 * servidor, sólo que aquí se ve ANTES de que el usuario intente usarla.
 */
const STYLES: Record<VariableCausality, string> = {
  predictor: "bg-good/10 text-good border-good/30",
  outcome: "bg-bad/10 text-bad border-bad/30",
  meta: "bg-base-700/40 text-base-400 border-base-700",
};

const LABELS: Record<VariableCausality, string> = {
  predictor: "predictor",
  outcome: "resultado",
  meta: "meta",
};

export function CausalityBadge({ causality }: { causality: VariableCausality }): JSX.Element {
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${STYLES[causality]}`}>
      {LABELS[causality]}
    </span>
  );
}
