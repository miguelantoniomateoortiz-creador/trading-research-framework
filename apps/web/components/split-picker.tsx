"use client";

import type { DatasetSplit } from "@trf/shared";

const ROLE_LABEL: Record<string, string> = { training: "entrenamiento", validation: "validación", holdout: "holdout" };

export function SplitPicker({
  splits,
  value,
  onChange,
  roles,
}: {
  splits: readonly DatasetSplit[];
  value: string;
  onChange: (name: string) => void;
  /** Si se indica, sólo se listan splits con ese rol (p.ej. sólo "training"). */
  roles?: readonly string[];
}): JSX.Element {
  const filtered = roles === undefined ? splits : splits.filter((s) => roles.includes(s.role));

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
    >
      <option value="" disabled>
        split…
      </option>
      {filtered.map((split) => (
        <option key={split.id} value={split.name}>
          {split.name} ({ROLE_LABEL[split.role] ?? split.role}, {split.evaluationCount} usos)
        </option>
      ))}
    </select>
  );
}
