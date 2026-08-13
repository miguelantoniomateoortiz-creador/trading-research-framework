"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DatasetSplit, VariableDefinition } from "@trf/shared";
import {
  ApiError,
  getCohort,
  getMarginal,
  getSplits,
  getVariables,
  type CohortResponse,
  type MarginalResponse,
  type RankedMarginal,
} from "@/lib/api";
import { CohortTable } from "@/components/cohort-table";
import { SplitPicker } from "@/components/split-picker";
import { PredicateBuilder } from "@/components/predicate-builder";
import { MetricsCard } from "@/components/metrics-card";
import { EquityChart } from "@/components/equity-chart";
import { int, num, pct, qValue } from "@/lib/format";

const MARGINAL_COLUMNS: ColumnDef<RankedMarginal, any>[] = [
  { accessorKey: "variable", header: "Variable", cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span> },
  { accessorFn: (a) => a.bestBucket?.label ?? "—", header: "Mejor tramo", id: "bucket" },
  { accessorFn: (a) => a.bestBucket?.count ?? 0, header: "Ops", id: "count", cell: (c) => int(c.getValue<number>()) },
  {
    accessorFn: (a) => a.bestBucket?.metrics.winRate ?? Number.NaN,
    header: "WR",
    id: "winRate",
    cell: (c) => pct(c.getValue<number>()),
  },
  {
    accessorFn: (a) => a.bestBucket?.metrics.expectancy ?? Number.NaN,
    header: "Expect.",
    id: "expectancy",
    cell: (c) => num(c.getValue<number>()),
  },
  { accessorFn: (a) => a.bestBucket?.lift ?? Number.NaN, header: "Lift", id: "lift", cell: (c) => num(c.getValue<number>()) },
  { accessorFn: (a) => a.correlation, header: "Corr.", id: "correlation", cell: (c) => num(c.getValue<number>(), 3) },
  { accessorKey: "qValue", header: "q-valor", cell: (c) => qValue(c.getValue<number>()) },
];

export default function ExplorePage(): JSX.Element {
  const [splits, setSplits] = useState<DatasetSplit[]>([]);
  const [variables, setVariables] = useState<VariableDefinition[]>([]);
  const [split, setSplit] = useState("");
  const [minCount, setMinCount] = useState(50);
  const [rule, setRule] = useState("");

  const [marginal, setMarginal] = useState<MarginalResponse | null>(null);
  const [selected, setSelected] = useState<RankedMarginal | null>(null);
  const [loadingMarginal, setLoadingMarginal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [where, setWhere] = useState("");
  const [cohort, setCohort] = useState<CohortResponse | null>(null);
  const [cohortError, setCohortError] = useState<string | null>(null);
  const [loadingCohort, setLoadingCohort] = useState(false);

  useEffect(() => {
    Promise.all([getSplits(), getVariables()]).then(([s, v]) => {
      setSplits(s.splits);
      setVariables(v.variables);
      if (s.splits.length > 0 && s.splits[0] !== undefined) setSplit(s.splits[0].name);
    });
  }, []);

  function runMarginal(): void {
    if (split === "") return;
    setLoadingMarginal(true);
    setError(null);
    setSelected(null);
    getMarginal({ split, minCount, rule: rule || undefined })
      .then((res) => setMarginal(res))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoadingMarginal(false));
  }

  function runCohort(): void {
    if (split === "" || where.trim() === "") return;
    setLoadingCohort(true);
    setCohortError(null);
    getCohort({ split, where, rule: rule || undefined })
      .then((res) => setCohort(res))
      .catch((err: unknown) => setCohortError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoadingCohort(false));
  }

  const bucketChartData = useMemo(
    () =>
      selected?.buckets
        .filter((b) => b.label !== "sin valor")
        .map((b) => ({ label: b.label, lift: b.lift, count: b.count })) ?? [],
    [selected],
  );

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold text-base-100">Explorar — análisis marginal</h1>
        <p className="mt-1 text-sm text-base-400">
          Qué hace cada variable por su cuenta. Equivalente a <code>pnpm trf analyze:marginal</code>.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Split">
          <SplitPicker splits={splits} value={split} onChange={setSplit} />
        </Field>
        <Field label="Mín. operaciones por tramo">
          <input
            type="number"
            value={minCount}
            onChange={(e) => setMinCount(Number(e.target.value))}
            className="w-24 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
          />
        </Field>
        <Field label="Regla de entrada (opcional)">
          <input
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            placeholder="id de la regla"
            className="w-56 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
          />
        </Field>
        <button
          onClick={runMarginal}
          disabled={split === "" || loadingMarginal}
          className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-base-950 disabled:opacity-50"
        >
          {loadingMarginal ? "Analizando…" : "Analizar"}
        </button>
      </div>

      {error !== null && <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">{error}</div>}

      {marginal !== null && (
        <div className="space-y-4">
          <MetricsCard title="Población completa" metrics={marginal.population} />
          <div className="text-xs text-base-400">
            El q-valor ya está corregido por el número de variables examinadas (Benjamini-Hochberg). Haz click en una
            fila para ver sus tramos.
          </div>
          <CohortTable
            columns={MARGINAL_COLUMNS}
            data={marginal.variables}
            initialSort={[{ id: "qValue", desc: false }]}
            onRowClick={setSelected}
          />
        </div>
      )}

      {selected !== null && (
        <div className="panel p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-medium text-base-100">
              Tramos de <span className="font-mono text-accent">{selected.variable}</span>
            </div>
            <button
              onClick={() => {
                setWhere(selected.bestBucket !== null ? describeBucketAsExpression(selected) : "");
              }}
              className="text-xs text-accent hover:underline"
              disabled={selected.bestBucket === null}
            >
              usar mejor tramo en el probador de cohortes ↓
            </button>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={bucketChartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3d" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#7b8496", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "#2a2f3d" }} />
              <YAxis tick={{ fill: "#7b8496", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "#2a2f3d" }} width={50} />
              <Tooltip
                contentStyle={{ background: "#161922", border: "1px solid #2a2f3d", borderRadius: 8, fontSize: 12 }}
                formatter={(value: number, name: string) => [num(value, 2), name === "lift" ? "lift" : name]}
              />
              <Bar dataKey="lift" radius={[3, 3, 0, 0]}>
                {bucketChartData.map((entry, i) => (
                  <Cell key={i} fill={entry.lift >= 0 ? "#4ade80" : "#f87171"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <section className="space-y-4 border-t border-base-800 pt-8">
        <header>
          <h2 className="text-lg font-semibold text-base-100">Probador de cohortes</h2>
          <p className="mt-1 text-sm text-base-400">
            Escribe una hipótesis y mira qué pasa. Equivalente a <code>pnpm trf analyze:cohort</code>. El servidor
            bloquea variables de resultado igual que en cualquier otro sitio.
          </p>
        </header>

        <PredicateBuilder variables={variables} value={where} onChange={setWhere} />

        <button
          onClick={runCohort}
          disabled={split === "" || where.trim() === "" || loadingCohort}
          className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-base-950 disabled:opacity-50"
        >
          {loadingCohort ? "Probando…" : "Probar cohorte"}
        </button>

        {cohortError !== null && <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">{cohortError}</div>}

        {cohort !== null && (
          <div className="space-y-4">
            <div className="text-sm text-base-300">
              <span className="text-base-400">Hipótesis:</span> {cohort.description} — cobertura {pct(cohort.coverage)}
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <MetricsCard title="Cumple" metrics={cohort.cohort} />
              <MetricsCard title="No cumple" metrics={cohort.complement} />
              <MetricsCard title="Población" metrics={cohort.population} />
            </div>
            <EquityChart curve={cohort.curve} label="Curva de equity — cohorte que cumple" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <MetricsCard title="1ª mitad del split" metrics={cohort.stability.first} />
              <MetricsCard title="2ª mitad del split" metrics={cohort.stability.second} />
            </div>
            {Math.abs(cohort.stability.winRateDelta) > 0.1 && (
              <div className="panel border-warn/40 bg-warn/5 p-3 text-sm text-warn">
                El win rate cambia {pct(Math.abs(cohort.stability.winRateDelta))} entre mitades. Sospecha de sobreajuste
                antes de gastar la validación.
              </div>
            )}
            {cohort.warning !== null && (
              <div className="panel border-warn/40 bg-warn/5 p-3 text-sm text-warn">{cohort.warning.message}</div>
            )}
            <Link
              href={`/hypotheses?where=${encodeURIComponent(where)}&split=${encodeURIComponent(split)}`}
              className="inline-block rounded border border-accent/40 px-4 py-1.5 text-sm text-accent hover:bg-accent/10"
            >
              Guardar como hipótesis →
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}

function describeBucketAsExpression(analysis: RankedMarginal): string {
  const predicate = analysis.bestBucket?.predicate;
  if (predicate === undefined) return "";
  switch (predicate.type) {
    case "between":
      return `${predicate.variable} between ${predicate.min} and ${predicate.max}`;
    case "compare":
      return `${predicate.variable} ${predicate.op} ${predicate.value}`;
    default:
      return "";
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-base-400">{label}</span>
      {children}
    </label>
  );
}
