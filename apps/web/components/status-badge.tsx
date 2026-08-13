import type { HypothesisStatus } from "@trf/shared";

const STYLES: Record<HypothesisStatus, string> = {
  draft: "bg-base-700/40 text-base-400 border-base-700",
  training_passed: "bg-warn/10 text-warn border-warn/30",
  validated: "bg-good/10 text-good border-good/30",
  rejected: "bg-bad/10 text-bad border-bad/30",
  retired: "bg-base-700/40 text-base-400 border-base-700",
};

const LABELS: Record<HypothesisStatus, string> = {
  draft: "borrador",
  training_passed: "entrenada",
  validated: "validada",
  rejected: "rechazada",
  retired: "retirada",
};

export function StatusBadge({ status }: { status: HypothesisStatus }): JSX.Element {
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${STYLES[status]}`}>
      {LABELS[status]}
    </span>
  );
}
