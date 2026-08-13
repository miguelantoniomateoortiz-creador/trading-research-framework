"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  generateData,
  getDataFiles,
  getDataStatus,
  importData,
  runResearch,
  type DataStatusResponse,
  type ImportFile,
} from "@/lib/api";
import { dateUtc, int, num } from "@/lib/format";

const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DataPage(): JSX.Element {
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>("M1");
  const [status, setStatus] = useState<DataStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [files, setFiles] = useState<ImportFile[]>([]);

  function loadStatus(timeframe: string): void {
    getDataStatus(timeframe)
      .then(setStatus)
      .catch((err: unknown) => setStatusError(err instanceof ApiError ? err.message : String(err)));
  }

  function loadFiles(): void {
    getDataFiles().then((res) => setFiles(res.files));
  }

  useEffect(() => {
    loadStatus(tf);
    loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold text-base-100">Datos</h1>
        <p className="mt-1 text-sm text-base-400">
          Importar historial, generar velas sintéticas y correr las reglas de entrada. Equivalente a{" "}
          <code>data:import</code>, <code>data:generate</code>, <code>data:status</code> y <code>run</code> del CLI.
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-base-100">Estado</h2>
          <select
            value={tf}
            onChange={(e) => setTf(e.target.value as (typeof TIMEFRAMES)[number])}
            className="rounded border border-base-700 bg-base-850 px-2 py-1 text-xs text-base-100"
          >
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {statusError !== null && <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">{statusError}</div>}

        {status !== null && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatCard label={`Velas (${tf})`} value={int(status.coverage.count)} />
              <StatCard label="Rango" value={`${dateUtc(status.coverage.firstTs)} → ${dateUtc(status.coverage.lastTs)}`} />
              <StatCard label="Operaciones" value={int(status.trades)} />
            </div>

            <details className="panel p-4">
              <summary className="cursor-pointer text-xs text-base-400 hover:text-base-100">
                huecos de más de 24h ({status.gaps.length})
              </summary>
              {status.gaps.length === 0 ? (
                <div className="mt-2 text-xs text-base-400">Ninguno.</div>
              ) : (
                <div className="mt-2 space-y-1 text-xs text-base-300">
                  {status.gaps.map((g, i) => (
                    <div key={i} className="font-mono">
                      {dateUtc(g.fromTs)} → {dateUtc(g.toTs)} ({(g.minutes / 60).toFixed(1)} h)
                    </div>
                  ))}
                </div>
              )}
            </details>

            <details className="panel p-4">
              <summary className="cursor-pointer text-xs text-base-400 hover:text-base-100">
                importaciones ({status.batches.length})
              </summary>
              <div className="mt-2 space-y-1 text-xs text-base-300">
                {status.batches.map((b) => (
                  <div key={b.id} className="font-mono">
                    {b.sourceFile} — {int(b.rowsAccepted)} aceptadas / {int(b.rowsRejected)} rechazadas
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
      </section>

      <GenerateSection onGenerated={loadFiles} />
      <ImportSection files={files} onImported={() => loadStatus(tf)} onRefreshFiles={loadFiles} />
      <RunSection onDone={() => loadStatus(tf)} defaultTf={tf} />
    </div>
  );
}

function GenerateSection({ onGenerated }: { onGenerated: () => void }): JSX.Element {
  const [from, setFrom] = useState("2022-01-01");
  const [to, setTo] = useState("2025-12-31");
  const [seed, setSeed] = useState(20240101);
  const [injectPattern, setInjectPattern] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function run(): void {
    setBusy(true);
    setError(null);
    setResult(null);
    generateData({ from, to, seed, injectPattern })
      .then((res) => {
        setResult(`${res.barsGenerated.toLocaleString("es-ES")} velas escritas en data/imports/${res.file}`);
        onGenerated();
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  return (
    <section className="space-y-3 border-t border-base-800 pt-8">
      <h2 className="text-sm font-medium text-base-100">Generar velas sintéticas</h2>
      <p className="text-xs text-base-400">
        Para probar el pipeline sin datos reales. Con "patrón inyectado" activado, los días con gap grande revierten
        durante la primera hora — sirve para comprobar que discovery de verdad encuentra algo cuando hay algo que
        encontrar.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Desde">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input" />
        </Field>
        <Field label="Hasta">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input" />
        </Field>
        <Field label="Semilla">
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} className="input w-28" />
        </Field>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-base-300">
          <input type="checkbox" checked={injectPattern} onChange={(e) => setInjectPattern(e.target.checked)} />
          patrón inyectado
        </label>
        <button onClick={run} disabled={busy} className="btn-primary">
          {busy ? "Generando…" : "Generar"}
        </button>
      </div>
      {error !== null && <div className="text-sm text-bad">{error}</div>}
      {result !== null && <div className="text-sm text-good">{result}</div>}
    </section>
  );
}

function ImportSection({
  files,
  onImported,
  onRefreshFiles,
}: {
  files: readonly ImportFile[];
  onImported: () => void;
  onRefreshFiles: () => void;
}): JSX.Element {
  const [file, setFile] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [useManual, setUseManual] = useState(false);
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>("M1");
  const [tz, setTz] = useState("UTC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  function run(): void {
    const target = useManual ? manualPath.trim() : file;
    if (target === "") return;
    setBusy(true);
    setError(null);
    setResult(null);
    setWarning(null);
    importData({ file: target, tf, tz })
      .then((res) => {
        setResult(res.summaryText);
        setWarning(res.utcTimezoneWarning);
        onImported();
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  return (
    <section className="space-y-3 border-t border-base-800 pt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-base-100">Importar CSV</h2>
        <button onClick={onRefreshFiles} className="text-xs text-accent hover:underline">
          refrescar lista
        </button>
      </div>
      <p className="text-xs text-base-400">
        Reimportar el mismo fichero es seguro: los duplicados se descartan por clave natural (instrumento, timeframe,
        fecha).
      </p>

      <div className="flex gap-2 text-xs">
        <button
          onClick={() => setUseManual(false)}
          className={`rounded px-2 py-1 ${!useManual ? "bg-base-800 text-accent" : "text-base-400 hover:text-base-100"}`}
        >
          elegir de data/imports/
        </button>
        <button
          onClick={() => setUseManual(true)}
          className={`rounded px-2 py-1 ${useManual ? "bg-base-800 text-accent" : "text-base-400 hover:text-base-100"}`}
        >
          ruta manual
        </button>
      </div>

      {!useManual ? (
        <select value={file} onChange={(e) => setFile(e.target.value)} className="input w-full max-w-lg">
          <option value="" disabled>
            {files.length === 0 ? "no hay ficheros en data/imports/" : "elige un fichero…"}
          </option>
          {files.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name} ({formatBytes(f.sizeBytes)})
            </option>
          ))}
        </select>
      ) : (
        <input
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          placeholder="/Users/tu-usuario/Downloads/nas100-mt5.csv"
          className="input w-full max-w-lg"
        />
      )}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Timeframe">
          <select value={tf} onChange={(e) => setTf(e.target.value as (typeof TIMEFRAMES)[number])} className="input">
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Zona horaria del origen">
          <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Europe/Riga" className="input w-40" />
        </Field>
        <button onClick={run} disabled={busy || (useManual ? manualPath.trim() === "" : file === "")} className="btn-primary">
          {busy ? "Importando…" : "Importar"}
        </button>
      </div>

      {warning !== null && <div className="panel border-warn/40 bg-warn/5 p-3 text-sm text-warn">{warning}</div>}
      {error !== null && <div className="text-sm text-bad">{error}</div>}
      {result !== null && <pre className="panel whitespace-pre-wrap p-3 font-mono text-xs text-base-300">{result}</pre>}
    </section>
  );
}

function RunSection({ onDone, defaultTf }: { onDone: () => void; defaultTf: string }): JSX.Element {
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>(defaultTf as (typeof TIMEFRAMES)[number]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function run(): void {
    setBusy(true);
    setError(null);
    setResult(null);
    runResearch({ tf })
      .then((res) => {
        const s = res.summary;
        setResult(
          `${int(s.barsProcessed)} velas · ${int(s.tradesClosed)} operaciones (escritas ${int(s.tradesWritten)}) · ` +
            `reglas: ${s.entryRuleIds.join(", ") || "ninguna"} · ${num(s.elapsedMs / 1000, 1)} s`,
        );
        onDone();
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  return (
    <section className="space-y-3 border-t border-base-800 pt-8">
      <h2 className="text-sm font-medium text-base-100">Correr (generar operaciones)</h2>
      <p className="text-xs text-base-400">
        Aplica los plugins de entrada activos sobre las velas importadas y calcula todas las variables. Corre esto
        después de importar datos nuevos o de cambiar la configuración de un plugin en la pantalla de Plugins.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Timeframe (el mismo con el que importaste)">
          <select value={tf} onChange={(e) => setTf(e.target.value as (typeof TIMEFRAMES)[number])} className="input">
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <button onClick={run} disabled={busy} className="btn-primary">
          {busy ? "Corriendo… (puede tardar)" : "Correr"}
        </button>
      </div>
      {error !== null && <div className="text-sm text-bad">{error}</div>}
      {result !== null && <div className="text-sm text-good">{result}</div>}
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="panel p-4">
      <div className="text-xs uppercase tracking-wide text-base-400">{label}</div>
      <div className="mt-1 font-mono text-lg text-base-100">{value}</div>
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
