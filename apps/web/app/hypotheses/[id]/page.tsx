"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import type { DatasetSplit, ValidationRun } from "@trf/shared";
import {
  ApiError,
  getHypothesis,
  getSplits,
  validateHypothesis,
  type HypothesisDetailResponse,
  type ValidateHypothesisPreview,
  type ValidateHypothesisResult,
} from "@/lib/api";
import { MetricsCard } from "@/components/metrics-card";
import { EquityChart } from "@/components/equity-chart";
import { CohortTable } from "@/components/cohort-table";
import { SplitPicker } from "@/components/split-picker";
import { StatusBadge } from "@/components/status-badge";
import { dateTimeUtc, int, num, pct } from "@/lib/format";

const RUN_COLUMNS: ColumnDef<ValidationRun, any>[] = [
  { accessorFn: (r) => dateTimeUtc(r.ranAt), header: "Cuándo", id: "ranAt" },
  { accessorFn: (r) => (r.passed ? "validada" : "rechazada"), header: "Resultado", id: "passed" },
  { accessorFn: (r) => r.metrics.count, header: "Ops", id: "count", cell: (c) => int(c.getValue<number>()) },
  { accessorFn: (r) => r.metrics.winRate, header: "WR", id: "winRate", cell: (c) => pct(c.getValue<number>()) },
  { accessorFn: (r) => r.metrics.profitFactor, header: "PF", id: "pf", cell: (c) => num(c.getValue<number>()) },
  { accessorKey: "notes", header: "Notas", cell: (c) => <span className="text-xs">{c.getValue<string>()}</span> },
];

export default function HypothesisDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [detail, setDetail] = useState<HypothesisDetailResponse | null>(null);
  const [splits, setSplits] = useState<DatasetSplit[]>([]);
  const [validateSplit, setValidateSplit] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<ValidateHypothesisPreview | null>(null);
  const [result, setResult] = useState<ValidateHypothesisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function load(): void {
    getHypothesis(id)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)));
  }

  useEffect(() => {
    load();
    getSplits().then((res) => {
      setSplits(res.splits);
      const candidate = res.splits.find((s) => s.role !== "training");
      if (candidate !== undefined) setValidateSplit(candidate.name);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function requestValidation(): void {
    if (validateSplit === "") return;
    setBusy(true);
    setActionError(null);
    validateHypothesis(id, { split: validateSplit, confirm: false })
      .then((res) => {
        if (res.requiresConfirmation === true) setPreview(res);
      })
      .catch((err: unknown) => setActionError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function confirmValidation(): void {
    setBusy(true);
    setActionError(null);
    validateHypothesis(id, { split: validateSplit, confirm: true })
      .then((res) => {
        if (res.requiresConfirmation !== true) {
          setResult(res);
          setPreview(null);
          load();
        }
      })
      .catch((err: unknown) => setActionError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  if (error !== null) return <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">{error}</div>;
  if (detail === null) return <div className="text-sm text-base-400">Cargando…</div>;

  const { hypothesis, description, validationRuns } = detail;
  const closed = hypothesis.status === "validated" || hypothesis.status === "rejected";

  return (
    <div className="space-y-6">
      <button onClick={() => router.push("/hypotheses")} className="text-xs text-base-400 hover:text-base-100">
        ← todas las hipótesis
      </button>

      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-base-100">{hypothesis.name}</h1>
          <StatusBadge status={hypothesis.status} />
        </div>
        <p className="text-sm text-base-300">{description}</p>
        {hypothesis.description.length > 0 && <p className="text-sm text-base-400">{hypothesis.description}</p>}
        <div className="text-xs text-base-400">
          Espacio de búsqueda declarado: {int(hypothesis.searchSpaceSize)} · creada el {hypothesis.createdAt.slice(0, 10)}
        </div>
      </header>

      {hypothesis.trainingMetrics !== null && <MetricsCard title="Entrenamiento" metrics={hypothesis.trainingMetrics} />}

      <section className="space-y-3 border-t border-base-800 pt-6">
        <h2 className="text-sm font-medium text-base-100">Validación</h2>

        {closed ? (
          <div className="panel p-4 text-sm text-base-300">
            Esta hipótesis ya fue <StatusBadge status={hypothesis.status} /> y no se puede revalidar. Si quieres
            reintentar con otra definición, guarda una hipótesis nueva.
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-base-400">
              Compara contra el INTERVALO DE CONFIANZA del entrenamiento, no contra el punto. Escribe un registro
              inmutable y cierra la hipótesis pase lo que pase.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-base-400">Split de validación</span>
                <SplitPicker splits={splits} value={validateSplit} onChange={setValidateSplit} roles={["validation", "holdout"]} />
              </label>
              {preview === null && (
                <button
                  onClick={requestValidation}
                  disabled={busy || validateSplit === ""}
                  className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-base-950 disabled:opacity-50"
                >
                  {busy ? "…" : "Validar"}
                </button>
              )}
            </div>

            {preview !== null && (
              <div className="panel border-warn/40 bg-warn/5 space-y-3 p-4">
                <p className="text-sm text-warn">{preview.message}</p>
                <p className="text-xs text-base-400">
                  Esto es una acción DELIBERADA y no reversible en espíritu: la hipótesis quedará{" "}
                  <span className="text-good">validated</span> o <span className="text-bad">rejected</span> para
                  siempre.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={confirmValidation}
                    disabled={busy}
                    className="rounded bg-bad px-4 py-1.5 text-sm font-medium text-base-950 disabled:opacity-50"
                  >
                    {busy ? "…" : "Confirmar validación"}
                  </button>
                  <button onClick={() => setPreview(null)} className="rounded px-4 py-1.5 text-sm text-base-400 hover:text-base-100">
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {actionError !== null && <div className="text-sm text-bad">{actionError}</div>}
          </div>
        )}

        {result !== null && (
          <div className="space-y-4">
            <div
              className={`panel p-4 text-sm ${result.decision.passed ? "border-good/40 bg-good/5 text-good" : "border-bad/40 bg-bad/5 text-bad"}`}
            >
              <div className="text-base font-semibold">{result.decision.passed ? "✓ VALIDADA" : "✖ RECHAZADA"}</div>
              <div className="mt-1 text-base-300">{result.decision.reason}</div>
            </div>
            <MetricsCard title="Validación (fuera de muestra)" metrics={result.validationMetrics} />
            <EquityChart curve={result.curve} label="Curva de equity — validación" color="#fbbf24" />
          </div>
        )}
      </section>

      {validationRuns.length > 0 && (
        <section className="space-y-3 border-t border-base-800 pt-6">
          <h2 className="text-sm font-medium text-base-100">Historial de validaciones</h2>
          <CohortTable columns={RUN_COLUMNS} data={validationRuns} initialSort={[{ id: "ranAt", desc: true }]} />
        </section>
      )}
    </div>
  );
}
