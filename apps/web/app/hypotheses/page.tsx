"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import type { DatasetSplit, HypothesisStatus, VariableDefinition } from "@trf/shared";
import {
  ApiError,
  getHypotheses,
  getSplits,
  getVariables,
  saveHypothesis,
  type HypothesisWithDescription,
} from "@/lib/api";
import { CohortTable } from "@/components/cohort-table";
import { SplitPicker } from "@/components/split-picker";
import { PredicateBuilder } from "@/components/predicate-builder";
import { StatusBadge } from "@/components/status-badge";
import { int, num, pct } from "@/lib/format";

const COLUMNS: ColumnDef<HypothesisWithDescription, any>[] = [
  { accessorKey: "name", header: "Nombre" },
  { accessorKey: "status", header: "Estado", cell: (c) => <StatusBadge status={c.getValue<HypothesisStatus>()} /> },
  { accessorKey: "description", header: "Hipótesis", cell: (c) => <span className="text-xs">{c.getValue<string>()}</span> },
  {
    accessorFn: (h) => h.trainingMetrics?.count ?? 0,
    header: "Ops (train)",
    id: "count",
    cell: (c) => int(c.getValue<number>()),
  },
  {
    accessorFn: (h) => h.trainingMetrics?.winRate ?? Number.NaN,
    header: "WR",
    id: "winRate",
    cell: (c) => pct(c.getValue<number>()),
  },
  {
    accessorFn: (h) => h.trainingMetrics?.profitFactor ?? Number.NaN,
    header: "PF",
    id: "pf",
    cell: (c) => num(c.getValue<number>()),
  },
  { accessorKey: "searchSpaceSize", header: "Espacio búsq.", cell: (c) => int(c.getValue<number>()) },
  { accessorFn: (h) => h.createdAt.slice(0, 10), header: "Creada", id: "createdAt" },
];

const STATUS_OPTIONS: readonly (HypothesisStatus | "all")[] = ["all", "draft", "training_passed", "validated", "rejected"];

export default function HypothesesPage(): JSX.Element {
  return (
    <Suspense fallback={<div className="text-sm text-base-400">Cargando…</div>}>
      <HypothesesPageContent />
    </Suspense>
  );
}

function HypothesesPageContent(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [splits, setSplits] = useState<DatasetSplit[]>([]);
  const [variables, setVariables] = useState<VariableDefinition[]>([]);
  const [hypotheses, setHypotheses] = useState<HypothesisWithDescription[]>([]);
  const [statusFilter, setStatusFilter] = useState<HypothesisStatus | "all">("all");
  const [listError, setListError] = useState<string | null>(null);

  const prefillPredicateJson = searchParams.get("predicateJson");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [where, setWhere] = useState(searchParams.get("where") ?? "");
  const [split, setSplit] = useState(searchParams.get("split") ?? "");
  const [searchSpaceSize, setSearchSpaceSize] = useState(searchParams.get("searchSpace") ?? "1");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  function loadList(status: HypothesisStatus | "all"): void {
    getHypotheses(status === "all" ? undefined : status)
      .then((res) => setHypotheses(res.hypotheses))
      .catch((err: unknown) => setListError(err instanceof ApiError ? err.message : String(err)));
  }

  useEffect(() => {
    Promise.all([getSplits(), getVariables()]).then(([s, v]) => {
      setSplits(s.splits);
      setVariables(v.variables);
      if (split === "" && s.splits.length > 0) {
        const training = s.splits.find((sp) => sp.role === "training");
        if (training !== undefined) setSplit(training.name);
      }
    });
    loadList("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadList(statusFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  function submit(): void {
    if (name.trim() === "" || split === "") return;
    if (prefillPredicateJson === null && where.trim() === "") return;

    setSaving(true);
    setSaveError(null);
    setSaved(null);
    saveHypothesis({
      name: name.trim(),
      description: description.trim() || undefined,
      ...(prefillPredicateJson !== null ? { predicateJson: prefillPredicateJson } : { where }),
      split,
      searchSpaceSize: Number(searchSpaceSize) || 1,
    })
      .then((res) => {
        setSaved(`Hipótesis "${res.hypothesis.name}" guardada (${res.hypothesis.status}).`);
        setName("");
        setDescription("");
        if (prefillPredicateJson !== null) router.replace("/hypotheses");
        loadList(statusFilter);
      })
      .catch((err: unknown) => setSaveError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setSaving(false));
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold text-base-100">Hipótesis</h1>
        <p className="mt-1 text-sm text-base-400">
          Nivel 7: guarda un predicado + su resultado en entrenamiento, y valídalo UNA vez contra un split que aún no
          se ha mirado.
        </p>
      </header>

      <section className="panel space-y-4 p-4">
        <h2 className="text-sm font-medium text-base-100">Guardar nueva hipótesis</h2>

        {prefillPredicateJson !== null && (
          <div className="rounded border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-base-300">
            Predicado prellenado desde Discovery. Espacio de búsqueda sugerido: {searchSpaceSize}.
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Nombre">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="reversión de apertura confirmada"
              className="w-full rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
            />
          </Field>
          <Field label="Split de entrenamiento">
            <SplitPicker splits={splits} value={split} onChange={setSplit} roles={["training"]} />
          </Field>
        </div>

        <Field label="Descripción (opcional)">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
          />
        </Field>

        {prefillPredicateJson === null ? (
          <Field label="Hipótesis">
            <PredicateBuilder variables={variables} value={where} onChange={setWhere} />
          </Field>
        ) : (
          <Field label="Espacio de búsqueda (combinaciones probadas)">
            <input
              type="number"
              value={searchSpaceSize}
              onChange={(e) => setSearchSpaceSize(e.target.value)}
              className="w-32 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
            />
          </Field>
        )}

        <button
          onClick={submit}
          disabled={saving || name.trim() === "" || split === ""}
          className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-base-950 disabled:opacity-50"
        >
          {saving ? "Guardando…" : "Guardar hipótesis"}
        </button>

        {saveError !== null && <div className="text-sm text-bad">{saveError}</div>}
        {saved !== null && <div className="text-sm text-good">{saved}</div>}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-base-100">Guardadas</h2>
          <div className="flex gap-1 text-xs">
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option}
                onClick={() => setStatusFilter(option)}
                className={`rounded px-2 py-1 ${
                  statusFilter === option ? "bg-base-800 text-accent" : "text-base-400 hover:text-base-100"
                }`}
              >
                {option === "all" ? "todas" : option}
              </button>
            ))}
          </div>
        </div>
        {listError !== null && <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">{listError}</div>}
        <CohortTable
          columns={COLUMNS}
          data={hypotheses}
          initialSort={[{ id: "createdAt", desc: true }]}
          onRowClick={(h) => router.push(`/hypotheses/${h.id}`)}
          emptyMessage="Ninguna todavía."
        />
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-base-400">{label}</span>
      {children}
    </label>
  );
}
