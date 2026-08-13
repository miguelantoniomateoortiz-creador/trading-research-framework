"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { VariableDefinition } from "@trf/shared";
import { ApiError, getVariables } from "@/lib/api";
import { CohortTable } from "@/components/cohort-table";
import { CausalityBadge } from "@/components/causality-badge";

const COLUMNS: ColumnDef<VariableDefinition, any>[] = [
  { accessorKey: "key", header: "Clave", cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span> },
  { accessorKey: "label", header: "Nombre" },
  { accessorKey: "valueType", header: "Tipo" },
  {
    accessorKey: "causality",
    header: "Causalidad",
    cell: (c) => <CausalityBadge causality={c.getValue<VariableDefinition["causality"]>()} />,
  },
  { accessorKey: "unit", header: "Unidad" },
  { accessorKey: "producedBy", header: "Plugin" },
  {
    accessorKey: "description",
    header: "Descripción",
    cell: (c) => <span className="text-base-300">{c.getValue<string>()}</span>,
  },
];

export default function VariablesPage(): JSX.Element {
  const [variables, setVariables] = useState<VariableDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "predictor" | "outcome" | "meta">("all");

  useEffect(() => {
    getVariables()
      .then((res) => setVariables(res.variables))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)));
  }, []);

  const filtered = useMemo(
    () => (filter === "all" ? variables : variables.filter((v) => v.causality === filter)),
    [variables, filter],
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-base-100">Registro de variables</h1>
        <p className="mt-1 text-sm text-base-400">
          Sólo las <CausalityBadgeInline text="predictor" /> pueden usarse en hipótesis. Las{" "}
          <CausalityBadgeInline text="resultado" /> sólo se conocen al cerrar la operación — filtrar por ellas produce
          resultados imposibles de operar, y el servidor lo bloquea siempre, no sólo aquí.
        </p>
      </header>

      {error !== null && <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">{error}</div>}

      <div className="flex gap-2 text-xs">
        {(["all", "predictor", "outcome", "meta"] as const).map((option) => (
          <button
            key={option}
            onClick={() => setFilter(option)}
            className={`rounded px-2 py-1 ${filter === option ? "bg-base-800 text-accent" : "text-base-400 hover:text-base-100"}`}
          >
            {option === "all" ? "todas" : option === "predictor" ? "predictor" : option === "outcome" ? "resultado" : "meta"}
          </button>
        ))}
        <span className="ml-auto text-base-400">{filtered.length} variables</span>
      </div>

      <CohortTable columns={COLUMNS} data={filtered} initialSort={[{ id: "key", desc: false }]} />
    </div>
  );
}

function CausalityBadgeInline({ text }: { text: "predictor" | "resultado" }): JSX.Element {
  const cls = text === "predictor" ? "text-good" : "text-bad";
  return <span className={`font-medium ${cls}`}>{text}</span>;
}
