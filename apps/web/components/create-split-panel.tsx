"use client";

import { useState } from "react";
import { ApiError, createSplit } from "@/lib/api";

/**
 * CREAR UN SPLIT (entrenamiento/validación/holdout) DESDE LA WEB.
 *
 * Equivalente a `pnpm trf splits:create`. Se usa en cualquier pantalla que
 * necesite un split y no lo encuentre — Discovery, Explorar, etc. — para que
 * definir el periodo de validación no dependa de la terminal.
 */
export function CreateSplitPanel({ onCreated }: { onCreated: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [role, setRole] = useState<"training" | "validation" | "holdout">("validation");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [embargoDays, setEmbargoDays] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function create(): void {
    setError(null);
    setSuccess(null);
    if (name.trim() === "" || from === "" || to === "") {
      setError("Completa nombre, desde y hasta.");
      return;
    }
    setBusy(true);
    createSplit({ name: name.trim(), role, from, to, embargoDays: Number(embargoDays) || 5 })
      .then((res) => {
        setSuccess(`Split "${res.split.name}" (${role}) creado.`);
        setName("");
        setFrom("");
        setTo("");
        onCreated();
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  return (
    <details className="panel p-4">
      <summary className="cursor-pointer text-sm font-medium text-base-100">Crear split nuevo</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-base-400">
          Un split es un periodo de fechas con nombre. Necesitas al menos uno de{" "}
          <strong>entrenamiento</strong> (donde BUSCAS patrones) y uno de <strong>validación</strong> (donde los
          COMPRUEBAS, sin haberlos usado para buscar) — así no confundes algo real con una casualidad. Un split de
          validación no puede solaparse en fechas con uno de entrenamiento.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-base-400">Nombre</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="val" className="input w-28" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-base-400">Rol</span>
            <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className="input w-36">
              <option value="training">entrenamiento</option>
              <option value="validation">validación</option>
              <option value="holdout">holdout</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-base-400">Desde</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-base-400">Hasta</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-base-400">Embargo (días)</span>
            <input
              type="number"
              value={embargoDays}
              onChange={(e) => setEmbargoDays(e.target.value)}
              className="input w-20"
            />
          </label>
          <button onClick={create} disabled={busy} className="btn-primary">
            {busy ? "Creando…" : "Crear split"}
          </button>
        </div>
        {error !== null && <div className="text-xs text-bad">{error}</div>}
        {success !== null && <div className="text-xs text-good">{success}</div>}
      </div>
    </details>
  );
}
