"use client";

import { useEffect, useState } from "react";
import { ApiError, deletePlugin, getPlugins, updatePlugin, uploadPlugin, type PluginResponse } from "@/lib/api";

export default function PluginsPage(): JSX.Element {
  const [plugins, setPlugins] = useState<PluginResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [configError, setConfigError] = useState<Record<string, string>>({});

  function load(): void {
    getPlugins()
      .then((res) => {
        setPlugins(res.plugins);
        setEditing(Object.fromEntries(res.plugins.map((p) => [p.id, JSON.stringify(p.config, null, 2)])));
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)));
  }

  useEffect(load, []);

  function toggle(plugin: PluginResponse): void {
    setBusy(plugin.id);
    updatePlugin(plugin.id, { enabled: !plugin.enabled })
      .then(load)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(null));
  }

  function remove(plugin: PluginResponse): void {
    const ok = window.confirm(
      `¿Eliminar "${plugin.name}"? Esto borra el plugin de disco. Las operaciones que ya generó se quedan en el ` +
        `historial, pero no vas a poder generar operaciones nuevas con él a menos que lo vuelvas a subir.`,
    );
    if (!ok) return;
    setBusy(plugin.id);
    deletePlugin(plugin.id)
      .then(load)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(null));
  }

  function saveConfigPatch(plugin: PluginResponse, patch: Record<string, unknown>): void {
    setBusy(plugin.id);
    updatePlugin(plugin.id, { config: patch })
      .then(load)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(null));
  }

  function saveConfig(plugin: PluginResponse): void {
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(editing[plugin.id] ?? "{}") as Record<string, unknown>;
    } catch {
      setConfigError((prev) => ({ ...prev, [plugin.id]: "JSON inválido" }));
      return;
    }
    setConfigError((prev) => ({ ...prev, [plugin.id]: "" }));
    saveConfigPatch(plugin, patch);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-base-100">Plugins</h1>
        <p className="mt-1 text-sm text-base-400">
          Activa, desactiva y configura las reglas de entrada y de variables ya instaladas. Cambiar la configuración
          crea una versión distinta de la regla: las operaciones antiguas y nuevas conviven, no se pierden. Después de
          tocar algo aquí, corre "Correr" en la pantalla de Datos para generar las operaciones con los nuevos ajustes.
        </p>
      </header>

      {error !== null && <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">{error}</div>}

      <UploadPluginPanel onInstalled={load} />

      <div className="space-y-4">
        {plugins.map((plugin) => (
          <div key={plugin.id} className="panel space-y-3 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-base-100">{plugin.name}</span>
                  {plugin.kind.map((k) => (
                    <span key={k} className="rounded bg-base-800 px-1.5 py-0.5 text-xs text-base-300">
                      {k === "entry" ? "regla de entrada" : k === "feature" ? "variables" : k}
                    </span>
                  ))}
                </div>
                <div className="mt-1 text-xs text-base-400">{plugin.description}</div>
                <div className="mt-1 font-mono text-xs text-base-400">
                  {plugin.id} · v{plugin.version} · {plugin.provides.length} variable
                  {plugin.provides.length === 1 ? "" : "s"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => toggle(plugin)}
                  disabled={busy === plugin.id}
                  className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                    plugin.enabled ? "bg-good/10 text-good border border-good/30" : "bg-base-800 text-base-400 border border-base-700"
                  }`}
                >
                  {plugin.enabled ? "activo" : "inactivo"}
                </button>
                <button
                  onClick={() => remove(plugin)}
                  disabled={busy === plugin.id}
                  className="rounded border border-bad/30 bg-bad/10 px-3 py-1.5 text-sm font-medium text-bad disabled:opacity-50"
                >
                  eliminar
                </button>
              </div>
            </div>

            <FriendlyConfig plugin={plugin} onSave={(patch) => saveConfigPatch(plugin, patch)} busy={busy === plugin.id} />

            <details>
              <summary className="cursor-pointer text-xs text-base-400 hover:text-base-100">
                configuración avanzada (JSON)
              </summary>
              <div className="mt-2 space-y-2">
                <textarea
                  value={editing[plugin.id] ?? "{}"}
                  onChange={(e) => setEditing((prev) => ({ ...prev, [plugin.id]: e.target.value }))}
                  rows={6}
                  className="w-full resize-y rounded border border-base-700 bg-base-950 px-3 py-2 font-mono text-xs text-base-100"
                />
                {configError[plugin.id] !== undefined && configError[plugin.id] !== "" && (
                  <div className="text-xs text-bad">{configError[plugin.id]}</div>
                )}
                <button
                  onClick={() => saveConfig(plugin)}
                  disabled={busy === plugin.id}
                  className="rounded bg-accent px-3 py-1 text-xs font-medium text-base-950 disabled:opacity-50"
                >
                  Guardar config
                </button>
              </div>
            </details>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Controles en español llano para los parámetros que un trader reconoce de
 * inmediato (riesgo, RR), en vez del JSON crudo. Sólo existen para los
 * plugins que los declaran aquí; el resto se configura con el editor JSON de
 * abajo, que sigue siendo la vía completa para cualquier plugin.
 */
function FriendlyConfig({
  plugin,
  onSave,
  busy,
}: {
  plugin: PluginResponse;
  onSave: (patch: Record<string, unknown>) => void;
  busy: boolean;
}): JSX.Element | null {
  const [riskPoints, setRiskPoints] = useState(String(plugin.config["riskPoints"] ?? 25));
  const [rr, setRr] = useState(String(plugin.config["riskRewardRatio"] ?? 2));

  if (plugin.id !== "entry-first-candle") return null;

  return (
    <div className="rounded border border-base-700 bg-base-850 p-3">
      <div className="mb-2 text-xs text-base-400">
        Compra si la primera vela de la sesión cierra por encima de su apertura; vende si cierra por debajo. Una
        operación por sesión.
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-base-400">Riesgo por operación (puntos de stop loss)</span>
          <input
            type="number"
            value={riskPoints}
            onChange={(e) => setRiskPoints(e.target.value)}
            className="input w-32"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-base-400">RR (objetivo = riesgo × RR)</span>
          <input type="number" step="0.1" value={rr} onChange={(e) => setRr(e.target.value)} className="input w-32" />
        </label>
        <button
          onClick={() => onSave({ riskPoints: Number(riskPoints), riskRewardRatio: Number(rr) })}
          disabled={busy}
          className="btn-primary"
        >
          Guardar
        </button>
      </div>
      <div className="mt-2 text-xs text-base-400">
        Con estos números: arriesgas {riskPoints} puntos por operación y el objetivo de ganancia queda en{" "}
        {(Number(riskPoints) * Number(rr)).toFixed(1)} puntos.
      </div>
    </div>
  );
}

/**
 * SUBIR / INSTALAR UN PLUGIN NUEVO.
 *
 * Escribe `plugin.json` + `src/index.ts` directamente en `plugins/` a través
 * de la API — no requiere terminal ni reiniciar nada: el plugin queda
 * disponible de inmediato en la lista de abajo. La API valida el manifiesto
 * y hace una carga de prueba antes de aceptarlo, así que un archivo mal
 * formado nunca llega a instalarse a medias.
 */
function UploadPluginPanel({ onInstalled }: { onInstalled: () => void }): JSX.Element {
  const [manifestText, setManifestText] = useState("");
  const [manifestFileName, setManifestFileName] = useState("");
  const [codeText, setCodeText] = useState("");
  const [codeFileName, setCodeFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function readFile(file: File, onText: (text: string) => void, onName: (name: string) => void): void {
    const reader = new FileReader();
    reader.onload = () => onText(String(reader.result ?? ""));
    reader.readAsText(file);
    onName(file.name);
  }

  function install(): void {
    setError(null);
    setSuccess(null);

    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      setError("El plugin.json no es JSON válido.");
      return;
    }
    if (codeText.trim() === "") {
      setError("Falta el código (index.ts).");
      return;
    }

    setBusy(true);
    uploadPlugin({ manifest, code: codeText })
      .then((res) => {
        setSuccess(`"${res.plugin.name}" instalado y listo para usar.`);
        setManifestText("");
        setManifestFileName("");
        setCodeText("");
        setCodeFileName("");
        onInstalled();
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  return (
    <details className="panel p-4">
      <summary className="cursor-pointer text-sm font-medium text-base-100">Subir un plugin nuevo</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-base-400">
          Sube los dos archivos que definen un plugin: <code>plugin.json</code> (sus datos) y <code>index.ts</code>{" "}
          (el código). Si no los tienes, pídele a Claude que te los prepare en el chat y descárgalos, o pega el
          contenido directamente en los cuadros de abajo.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-base-400">Archivo plugin.json{manifestFileName !== "" ? ` — ${manifestFileName}` : ""}</span>
              <input
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) readFile(file, setManifestText, setManifestFileName);
                }}
                className="text-xs text-base-300"
              />
            </label>
            <textarea
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              placeholder='{"id": "mi-plugin", "name": "...", "version": "1.0.0", "apiVersion": 1, "kind": ["entry"], ...}'
              rows={8}
              className="w-full resize-y rounded border border-base-700 bg-base-950 px-3 py-2 font-mono text-xs text-base-100"
            />
          </div>
          <div className="space-y-1">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-base-400">Archivo index.ts{codeFileName !== "" ? ` — ${codeFileName}` : ""}</span>
              <input
                type="file"
                accept=".ts,text/plain"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) readFile(file, setCodeText, setCodeFileName);
                }}
                className="text-xs text-base-300"
              />
            </label>
            <textarea
              value={codeText}
              onChange={(e) => setCodeText(e.target.value)}
              placeholder="export default defineEntryPlugin({ ... })"
              rows={8}
              className="w-full resize-y rounded border border-base-700 bg-base-950 px-3 py-2 font-mono text-xs text-base-100"
            />
          </div>
        </div>

        {error !== null && <div className="text-xs text-bad">{error}</div>}
        {success !== null && <div className="text-xs text-good">{success}</div>}

        <button
          onClick={install}
          disabled={busy || manifestText.trim() === "" || codeText.trim() === ""}
          className="btn-primary"
        >
          {busy ? "Instalando…" : "Instalar plugin"}
        </button>
      </div>
    </details>
  );
}
