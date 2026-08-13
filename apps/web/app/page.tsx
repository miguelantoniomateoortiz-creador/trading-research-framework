"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, createSplit, deleteSplit, getInstrument, getSplits, type InstrumentResponse } from "@/lib/api";
import type { DatasetSplit } from "@trf/shared";
import { dateUtc, int } from "@/lib/format";

const ROLE_LABEL: Record<string, string> = { training: "entrenamiento", validation: "validación", holdout: "holdout" };

export default function HomePage(): JSX.Element {
  const [instrument, setInstrument] = useState<InstrumentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getInstrument()
      .then(setInstrument)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-base-100">Panel</h1>
        <p className="mt-1 text-sm text-base-400">
          Cobertura de datos y splits definidos. Todo lo que ves aquí también sale de <code>pnpm trf data:status</code> y{" "}
          <code>pnpm trf splits:list</code>.
        </p>
      </header>

      {loading && <div className="text-sm text-base-400">Cargando…</div>}
      {error !== null && (
        <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">
          {error}
          {error.includes("API local") && (
            <div className="mt-2 text-base-400">
              Arranca la API en otra terminal: <code className="text-base-100">pnpm api</code>
            </div>
          )}
        </div>
      )}

      {instrument !== null && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label="Velas (M1)" value={int(instrument.bars.count)} />
          <StatCard
            label="Rango de datos"
            value={`${dateUtc(instrument.bars.firstTs)} → ${dateUtc(instrument.bars.lastTs)}`}
          />
          <StatCard label="Operaciones generadas" value={int(instrument.trades)} />
        </div>
      )}

      <SplitsSection />

      <section className="panel p-4 text-sm text-base-400">
        Siguiente paso habitual:{" "}
        <Link href="/explore" className="text-accent hover:underline">
          análisis marginal
        </Link>{" "}
        →{" "}
        <Link href="/discovery" className="text-accent hover:underline">
          discovery
        </Link>{" "}
        →{" "}
        <Link href="/hypotheses" className="text-accent hover:underline">
          guardar y validar hipótesis
        </Link>
        .
      </section>
    </div>
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

/**
 * SPLITS (entrenamiento / validación / holdout).
 *
 * `createSplit` no tiene "editar": esta pantalla lo simula borrando el split
 * y creando uno nuevo con el mismo nombre y las fechas actualizadas — el
 * mismo formulario sirve para crear y para editar, cambiando solo qué hace
 * "Guardar" según si venías de "editar" una fila o no.
 */
function SplitsSection(): JSX.Element {
  const [splits, setSplits] = useState<DatasetSplit[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"training" | "validation" | "holdout">("training");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [embargoDays, setEmbargoDays] = useState("5");
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function load(): void {
    getSplits()
      .then((res) => setSplits(res.splits))
      .catch((err: unknown) => setLoadError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function resetForm(): void {
    setEditingId(null);
    setName("");
    setRole("training");
    setFrom("");
    setTo("");
    setEmbargoDays("5");
    setFormError(null);
  }

  function startEdit(split: DatasetSplit): void {
    setEditingId(split.id);
    setName(split.name);
    setRole(split.role as "training" | "validation" | "holdout");
    setFrom(dateUtc(split.startTs));
    setTo(dateUtc(split.endTs));
    setEmbargoDays(String(split.embargoDays));
    setFormError(null);
    setSuccess(null);
  }

  function save(): void {
    setFormError(null);
    setSuccess(null);
    if (name.trim() === "" || from === "" || to === "") {
      setFormError("Completa nombre, desde y hasta.");
      return;
    }

    const editing = editingId === null ? undefined : splits.find((s) => s.id === editingId);
    setBusy(editingId ?? "new");

    const create = (afterDelete: boolean): void => {
      createSplit({ name: name.trim(), role, from, to, embargoDays: Number(embargoDays) || 5 })
        .then((res) => {
          setSuccess(`Split "${res.split.name}" (${ROLE_LABEL[role]}) guardado.`);
          resetForm();
          load();
        })
        .catch((err: unknown) => {
          const msg = err instanceof ApiError ? err.message : String(err);
          setFormError(
            afterDelete
              ? `El split anterior ya se borró, pero el nuevo no se pudo crear: ${msg}. Vuelve a intentarlo con otras fechas.`
              : msg,
          );
        })
        .finally(() => setBusy(null));
    };

    if (editing !== undefined) {
      deleteSplit(editing.id)
        .then(() => {
          // Refrescamos YA, no esperamos a que termine la creación: si esta
          // falla después, la pantalla igual debe reflejar que el split
          // viejo ya no existe (evita el error "no hay ningún split con id…"
          // si se intenta tocar otra vez esa fila).
          load();
          create(true);
        })
        .catch((err: unknown) => {
          setFormError(err instanceof ApiError ? err.message : String(err));
          setBusy(null);
        });
    } else {
      create(false);
    }
  }

  function remove(split: DatasetSplit): void {
    const ok = window.confirm(
      `¿Eliminar el split "${split.name}"? Se ha usado ${split.evaluationCount} vez/veces. Esto no borra operaciones ni datos, solo el rango de fechas guardado.`,
    );
    if (!ok) return;
    setBusy(split.id);
    deleteSplit(split.id)
      .then(() => {
        if (editingId === split.id) resetForm();
        load();
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof ApiError ? err.message : String(err));
        // Si ya no existe (p.ej. se borró en un intento de edición previo
        // que falló a mitad de camino), refrescamos igual para que la fila
        // stale desaparezca de la pantalla.
        load();
      })
      .finally(() => setBusy(null));
  }

  const editingSplit = editingId === null ? undefined : splits.find((s) => s.id === editingId);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-base-100">Splits (entrenamiento / validación)</h2>
        {splits.length === 0 && !loading && (
          <span className="text-xs text-base-400">Ninguno todavía — créalo abajo.</span>
        )}
      </div>
      <p className="text-xs text-base-400">
        Un split es un periodo de fechas con nombre. Necesitas al menos uno de <strong>entrenamiento</strong> (donde
        BUSCAS patrones, en Discovery) y uno de <strong>validación</strong> (donde los COMPRUEBAS, en Hipótesis, sin
        haberlos usado para buscar). Un split de validación no puede solaparse en fechas con uno de entrenamiento.
      </p>

      {loadError !== null && <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">{loadError}</div>}

      {splits.length > 0 && (
        <div className="panel overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-base-800 text-xs uppercase tracking-wide text-base-400">
                <th className="table-cell">Split</th>
                <th className="table-cell">Rol</th>
                <th className="table-cell">Desde</th>
                <th className="table-cell">Hasta</th>
                <th className="table-cell">Embargo</th>
                <th className="table-cell">Usos</th>
                <th className="table-cell"></th>
              </tr>
            </thead>
            <tbody>
              {splits.map((s) => (
                <tr key={s.id} className="border-b border-base-800 last:border-0">
                  <td className="table-cell text-base-100">{s.name}</td>
                  <td className="table-cell text-base-300">{ROLE_LABEL[s.role] ?? s.role}</td>
                  <td className="table-cell font-mono text-xs text-base-300">{dateUtc(s.startTs)}</td>
                  <td className="table-cell font-mono text-xs text-base-300">{dateUtc(s.endTs)}</td>
                  <td className="table-cell text-base-300">{s.embargoDays} d</td>
                  <td className="table-cell text-base-300">{s.evaluationCount}</td>
                  <td className="table-cell">
                    <div className="flex gap-2">
                      <button
                        onClick={() => startEdit(s)}
                        disabled={busy === s.id}
                        className="text-xs text-accent hover:underline disabled:opacity-50"
                      >
                        editar
                      </button>
                      <button
                        onClick={() => remove(s)}
                        disabled={busy === s.id}
                        className="text-xs text-bad hover:underline disabled:opacity-50"
                      >
                        eliminar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel space-y-3 p-4">
        <div className="text-sm font-medium text-base-100">
          {editingId === null ? "Crear split nuevo" : `Editando "${editingSplit?.name}"`}
        </div>
        {editingId !== null && editingSplit !== undefined && editingSplit.evaluationCount > 0 && (
          <div className="text-xs text-warn">
            Este split se usó {editingSplit.evaluationCount} vez/veces. Guardar cambios lo borra y lo vuelve a crear
            con el contador de usos en 0.
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Nombre">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="val" className="input w-28" />
          </Field>
          <Field label="Rol">
            <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className="input w-36">
              <option value="training">entrenamiento</option>
              <option value="validation">validación</option>
              <option value="holdout">holdout</option>
            </select>
          </Field>
          <Field label="Desde">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input" />
          </Field>
          <Field label="Hasta">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input" />
          </Field>
          <Field label="Embargo (días)">
            <input
              type="number"
              value={embargoDays}
              onChange={(e) => setEmbargoDays(e.target.value)}
              className="input w-20"
            />
          </Field>
          <button onClick={save} disabled={busy !== null} className="btn-primary">
            {busy !== null ? "Guardando…" : editingId === null ? "Crear split" : "Guardar cambios"}
          </button>
          {editingId !== null && (
            <button onClick={resetForm} className="text-xs text-base-400 hover:text-base-100">
              cancelar edición
            </button>
          )}
        </div>
        {formError !== null && <div className="text-xs text-bad">{formError}</div>}
        {success !== null && <div className="text-xs text-good">{success}</div>}
      </div>
    </section>
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
