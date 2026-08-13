"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import type { DatasetSplit } from "@trf/shared";
import {
  ApiError,
  getRules,
  getSplits,
  runDiscover,
  type DiscoverResponse,
  type DiscoveryResultWithDescription,
  type EntryRule,
} from "@/lib/api";
import { CohortTable } from "@/components/cohort-table";
import { SplitPicker } from "@/components/split-picker";
import { int, num, pct, qValue, ruleLabel } from "@/lib/format";

const COLUMNS: ColumnDef<DiscoveryResultWithDescription, any>[] = [
  { accessorKey: "depth", header: "Cond." },
  { accessorKey: "description", header: "Hipótesis", cell: (c) => <span className="text-xs">{c.getValue<string>()}</span> },
  { accessorFn: (r) => r.metrics.count, header: "Ops", id: "count", cell: (c) => int(c.getValue<number>()) },
  { accessorFn: (r) => r.metrics.winRate, header: "WR", id: "winRate", cell: (c) => pct(c.getValue<number>()) },
  { accessorFn: (r) => r.metrics.profitFactor, header: "PF", id: "pf", cell: (c) => num(c.getValue<number>()) },
  { accessorFn: (r) => r.metrics.expectancy, header: "Expect.", id: "expectancy", cell: (c) => num(c.getValue<number>()) },
  { accessorFn: (r) => r.metrics.maxDrawdownPct, header: "DD%", id: "dd", cell: (c) => pct(c.getValue<number>()) },
  { accessorFn: (r) => r.metrics.equityR2, header: "R²", id: "r2", cell: (c) => num(c.getValue<number>(), 3) },
  { accessorKey: "qValue", header: "q-valor", cell: (c) => qValue(c.getValue<number>()) },
];

export default function DiscoveryPage(): JSX.Element {
  const router = useRouter();
  const [splits, setSplits] = useState<DatasetSplit[]>([]);
  const [split, setSplit] = useState("");
  const [minTrades, setMinTrades] = useState(100);
  const [minWinrate, setMinWinrate] = useState<string>("");
  const [minPf, setMinPf] = useState<string>("");
  const [maxDdPct, setMaxDdPct] = useState<string>("");
  const [maxConditions, setMaxConditions] = useState(3);
  const [rule, setRule] = useState("");
  const [rules, setRules] = useState<EntryRule[]>([]);

  const [response, setResponse] = useState<DiscoverResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [evaluated, setEvaluated] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function loadSplits(): void {
    getSplits().then((res) => {
      setSplits(res.splits);
      if (split === "" && res.splits.length > 0 && res.splits[0] !== undefined) setSplit(res.splits[0].name);
    });
  }

  useEffect(loadSplits, []);
  useEffect(() => {
    getRules().then((res) => setRules(res.rules));
  }, []);

  function run(): void {
    if (split === "") return;
    setLoading(true);
    setError(null);
    setEvaluated(0);
    setResponse(null);
    runDiscover(
      {
        split,
        minTrades,
        minWinrate: minWinrate === "" ? undefined : Number(minWinrate),
        minPf: minPf === "" ? undefined : Number(minPf),
        maxDdPct: maxDdPct === "" ? undefined : Number(maxDdPct),
        maxConditions,
        top: 50,
        rule: rule || undefined,
      },
      (n) => setEvaluated(n),
    )
      .then(setResponse)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  function saveAsHypothesis(result: DiscoveryResultWithDescription): void {
    const params = new URLSearchParams({
      predicateJson: result.predicateJson,
      split,
      searchSpace: String(response?.report.searchSpaceSize ?? 1),
    });
    router.push(`/hypotheses?${params.toString()}`);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-base-100">Discovery — búsqueda de patrones</h1>
        <p className="mt-1 text-sm text-base-400">
          Búsqueda combinatoria estilo Apriori con poda anti-monótona y corrección de Benjamini-Hochberg sobre TODO lo
          evaluado. Equivalente a <code>pnpm trf discover</code>.
        </p>
      </header>

      <div className="panel flex flex-wrap items-end gap-3 p-4">
        <Field label="Split (entrenamiento)">
          <SplitPicker splits={splits} value={split} onChange={setSplit} roles={["training"]} />
        </Field>
        <Field label="Mín. operaciones">
          <input
            type="number"
            value={minTrades}
            onChange={(e) => setMinTrades(Number(e.target.value))}
            className="w-24 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
          />
        </Field>
        <Field label="Mín. WR">
          <input
            type="number"
            step="0.01"
            value={minWinrate}
            onChange={(e) => setMinWinrate(e.target.value)}
            placeholder="0.6"
            className="w-20 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
          />
        </Field>
        <Field label="Mín. PF">
          <input
            type="number"
            step="0.1"
            value={minPf}
            onChange={(e) => setMinPf(e.target.value)}
            placeholder="1.5"
            className="w-20 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
          />
        </Field>
        <Field label="Máx. DD%">
          <input
            type="number"
            step="0.01"
            value={maxDdPct}
            onChange={(e) => setMaxDdPct(e.target.value)}
            placeholder="0.05"
            className="w-20 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
          />
        </Field>
        <Field label="Máx. condiciones">
          <input
            type="number"
            value={maxConditions}
            onChange={(e) => setMaxConditions(Number(e.target.value))}
            className="w-20 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
          />
        </Field>
        <Field label="Regla de entrada (opcional)">
          <select
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            className="w-64 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
          >
            <option value="">todas las reglas</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {ruleLabel(r)}
              </option>
            ))}
          </select>
        </Field>
        <button
          onClick={run}
          disabled={split === "" || loading}
          className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-base-950 disabled:opacity-50"
        >
          {loading ? "Buscando…" : "Buscar patrones"}
        </button>
      </div>

      {loading && (
        <div className="panel p-4 text-sm text-base-300">
          Buscando… <span className="font-mono text-base-100">{int(evaluated)}</span> combinaciones evaluadas hasta
          ahora. Con muchas operaciones esto puede tardar varios minutos — el servidor sigue vivo mientras esto avanza.
        </div>
      )}

      {error !== null && <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">{error}</div>}

      {response !== null && (
        <div className="space-y-4">
          <div className="panel p-4 text-sm text-base-300">
            Espacio de búsqueda: <span className="font-mono text-base-100">{int(response.report.searchSpaceSize)}</span>{" "}
            combinaciones evaluadas ({int(response.report.level1Survivors)} condiciones simples de{" "}
            {int(response.report.candidateVariables)} variables) · {(response.report.elapsedMs / 1000).toFixed(1)} s
            {response.report.truncated && (
              <span className="ml-2 text-warn">⚠ búsqueda truncada por el límite de seguridad</span>
            )}
          </div>

          {response.report.results.length === 0 ? (
            <div className="panel p-6 text-center text-sm text-base-400">
              Ningún patrón cumple los umbrales, o ninguno es distinguible del azar tras corregir por multiplicidad.
              Esto también es un resultado válido.
            </div>
          ) : (
            <>
              <div className="text-xs text-base-400">
                {int(response.report.totalMatches)} patrones cumplen los umbrales, mostrando{" "}
                {response.report.results.length}. Ordenados por q-valor y, en empate, por R² (estabilidad de la
                equity). Click en una fila para prellenar <code>hypothesis:save</code>.
              </div>
              <CohortTable
                columns={COLUMNS}
                data={response.report.results}
                initialSort={[{ id: "qValue", desc: false }]}
                onRowClick={saveAsHypothesis}
              />
            </>
          )}

          {response.warning !== null && (
            <div className="panel border-warn/40 bg-warn/5 p-3 text-sm text-warn">{response.warning.message}</div>
          )}
        </div>
      )}
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
