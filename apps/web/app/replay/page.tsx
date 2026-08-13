"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  getBars,
  getInstrument,
  getRules,
  getTrades,
  type EntryRule,
  type RawBar,
  type RawTrade,
} from "@/lib/api";
import type { ColumnDef } from "@tanstack/react-table";
import { CandlestickChart, type ChartMarker } from "@/components/candlestick-chart";
import { CohortTable } from "@/components/cohort-table";
import { dateTimeNy, nyDisplayMs, num, ruleLabel } from "@/lib/format";

const SPEEDS = [
  { label: "1×", ms: 250 },
  { label: "2×", ms: 120 },
  { label: "4×", ms: 60 },
  { label: "8×", ms: 25 },
] as const;

/** Cuántas velas M1 se piden como máximo de una vez (≈ 20 días de trading). */
const BARS_LIMIT = 20000;

const EXIT_REASON_LABEL: Record<string, string> = {
  take_profit: "objetivo alcanzado",
  stop_loss: "stop loss",
  time_limit: "tiempo máximo",
  session_end: "fin de sesión",
  unknown: "desconocido",
};

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * La API espera fechas planas "YYYY-MM-DD" (así las interpreta
 * `parseIsoDateUtc`) — nada de hora ni "Z". `to` es exclusivo, así que basta
 * con pedir el día siguiente al final del rango como límite superior.
 */
function dateRange(from: string, to: string): { from: string; to: string } {
  const toMs = Date.parse(`${to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  return { from, to: isoDate(toMs) };
}

export default function ReplayPage(): JSX.Element {
  const [rules, setRules] = useState<EntryRule[]>([]);
  const [rule, setRule] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [bars, setBars] = useState<RawBar[]>([]);
  const [barsTruncated, setBarsTruncated] = useState(false);
  const [trades, setTrades] = useState<RawTrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState<number>(SPEEDS[1].ms);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getRules().then((res) => {
      setRules(res.rules);
      if (res.rules.length > 0 && res.rules[0] !== undefined) setRule(res.rules[0].id);
    });
    getInstrument().then((res) => {
      if (res.bars.lastTs !== null) {
        // Ventana de 7 días por defecto, para que se vea más de una operación
        // sin tener que cargar meses de velas de golpe.
        setDateTo(isoDate(res.bars.lastTs));
        setDateFrom(isoDate(res.bars.lastTs - 6 * 24 * 60 * 60 * 1000));
      }
    });
  }, []);

  function load(): void {
    if (dateFrom === "" || dateTo === "") return;
    setLoading(true);
    setError(null);
    setPlaying(false);
    setIndex(0);
    const { from, to } = dateRange(dateFrom, dateTo);
    Promise.all([getBars({ tf: "M1", from, to, limit: BARS_LIMIT }), getTrades({ from, to, rule: rule || undefined })])
      .then(([barsRes, tradesRes]) => {
        setBars(barsRes.bars);
        setBarsTruncated(barsRes.truncated);
        setTrades(tradesRes.trades);
        setIndex(0);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  /** Al hacer clic en una fila de la tabla, mueve el visor del gráfico a ese momento. */
  function jumpToTrade(trade: RawTrade): void {
    setPlaying(false);
    const i = bars.findIndex((b) => b.ts >= trade.entryTs);
    if (i >= 0) setIndex(i);
  }

  // Reproducción.
  useEffect(() => {
    if (!playing) {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      setIndex((i) => {
        if (i >= bars.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, speedMs);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [playing, speedMs, bars.length]);

  const visibleBars = useMemo(() => bars.slice(0, index + 1), [bars, index]);
  const currentTs = visibleBars.length > 0 ? (visibleBars[visibleBars.length - 1] as RawBar).ts : null;

  /**
   * lightweight-charts sólo sabe pintar en UTC — le pasamos las velas con el
   * timestamp "disfrazado" a hora de Nueva York (ver `nyDisplayMs`) para que
   * el eje y el cursor muestren la misma hora que usan los plugins de sesión.
   * `currentTs` arriba se queda en UTC real, que es lo que se usa para
   * comparar contra `trades`.
   */
  const chartBars = useMemo(() => visibleBars.map((b) => ({ ...b, ts: nyDisplayMs(b.ts) })), [visibleBars]);

  const markers = useMemo<ChartMarker[]>(() => {
    if (currentTs === null) return [];
    const out: ChartMarker[] = [];
    for (const t of trades) {
      if (t.entryTs > currentTs) continue;
      out.push({
        ts: nyDisplayMs(t.entryTs),
        position: t.direction === "long" ? "belowBar" : "aboveBar",
        color: t.direction === "long" ? "#4ade80" : "#f87171",
        shape: t.direction === "long" ? "arrowUp" : "arrowDown",
        text: t.direction === "long" ? "compra" : "venta",
      });
      if (t.exitTs <= currentTs) {
        out.push({
          ts: nyDisplayMs(t.exitTs),
          position: t.direction === "long" ? "aboveBar" : "belowBar",
          color: t.pnlMoney >= 0 ? "#4ade80" : "#f87171",
          shape: "circle",
          text: `${t.pnlMoney >= 0 ? "+" : ""}${num(t.pnlPoints, 1)} pts`,
        });
      }
    }
    return out;
  }, [trades, currentTs]);

  const visibleTradesClosed = trades.filter((t) => currentTs !== null && t.exitTs <= currentTs);
  const netSoFar = visibleTradesClosed.reduce((sum, t) => sum + t.pnlMoney, 0);

  const netTotal = trades.reduce((sum, t) => sum + t.pnlMoney, 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-base-100">Repetición</h1>
        <p className="mt-1 text-sm text-base-400">
          Ve cómo se habrían ejecutado las operaciones de una regla sobre un rango de fechas, tanto en el gráfico
          como en una tabla con el detalle de cada operación. Esto usa historial, no una conexión en vivo con tu
          bróker. Las horas que ves en el gráfico y en la tabla están en <strong>hora de Nueva York</strong>, la misma
          que usan los plugins para definir sesiones — no UTC.
        </p>
      </header>

      <div className="panel flex flex-wrap items-end gap-3 p-4">
        <Field label="Regla de entrada">
          <select value={rule} onChange={(e) => setRule(e.target.value)} className="input w-64">
            {rules.length === 0 && <option value="">no hay reglas todavía — corre 'run' primero</option>}
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {ruleLabel(r)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Desde">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input" />
        </Field>
        <Field label="Hasta">
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input" />
        </Field>
        <button onClick={load} disabled={loading || dateFrom === "" || dateTo === ""} className="btn-primary">
          {loading ? "Cargando…" : "Cargar rango"}
        </button>
      </div>

      {error !== null && <div className="panel border-bad/40 bg-bad/5 p-4 text-sm text-bad">{error}</div>}

      {barsTruncated && (
        <div className="panel border-warn/40 bg-warn/5 p-4 text-sm text-warn">
          El rango tiene más velas de las que se cargan de una vez ({num(BARS_LIMIT, 0)}). Se muestran solo las
          primeras; achica el rango de fechas para ver el resto.
        </div>
      )}

      {bars.length > 0 && (
        <div className="space-y-3">
          <CandlestickChart bars={chartBars} markers={markers} />

          <div className="panel flex flex-wrap items-center gap-4 p-4">
            <button onClick={() => setPlaying((p) => !p)} className="btn-primary w-24">
              {playing ? "Pausa" : "Reproducir"}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, bars.length - 1)}
              value={index}
              onChange={(e) => {
                setPlaying(false);
                setIndex(Number(e.target.value));
              }}
              className="flex-1"
            />
            <select
              value={speedMs}
              onChange={(e) => setSpeedMs(Number(e.target.value))}
              className="input w-20"
            >
              {SPEEDS.map((s) => (
                <option key={s.ms} value={s.ms}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className="w-48 shrink-0 font-mono text-xs text-base-400">
              {currentTs !== null ? `${dateTimeNy(currentTs)} (NY)` : "—"}
            </span>
          </div>

          <div className="panel p-4 text-sm text-base-300">
            {visibleTradesClosed.length} operación{visibleTradesClosed.length === 1 ? "" : "es"} cerrada
            {visibleTradesClosed.length === 1 ? "" : "s"} hasta este punto · resultado acumulado{" "}
            <span className={netSoFar >= 0 ? "text-good" : "text-bad"}>{num(netSoFar)}</span>
          </div>
        </div>
      )}

      {!loading && bars.length === 0 && error === null && (
        <div className="panel p-6 text-center text-sm text-base-400">
          Elige un rango de fechas con datos y pulsa "Cargar rango". Si no ves velas, comprueba en la pantalla de
          Datos que ese rango esté dentro de lo importado.
        </div>
      )}

      {trades.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-base-100">
              Historial de operaciones ({trades.length}) — resultado total{" "}
              <span className={netTotal >= 0 ? "text-good" : "text-bad"}>{num(netTotal)}</span>
            </h2>
            <span className="text-xs text-base-400">clic en una fila para ver ese momento en el gráfico</span>
          </div>
          <CohortTable columns={TRADE_COLUMNS} data={trades} onRowClick={jumpToTrade} />
        </section>
      )}
    </div>
  );
}

const TRADE_COLUMNS: ColumnDef<RawTrade, any>[] = [
  { accessorFn: (t) => dateTimeNy(t.entryTs), header: "Entrada (hora NY)", id: "entryTs" },
  {
    accessorFn: (t) => (t.direction === "long" ? "compra" : "venta"),
    header: "Dirección",
    id: "direction",
    cell: (c) => (
      <span className={c.getValue<string>() === "compra" ? "text-good" : "text-bad"}>{c.getValue<string>()}</span>
    ),
  },
  { accessorFn: (t) => t.entryPrice, header: "Precio entrada", id: "entryPrice", cell: (c) => num(c.getValue<number>()) },
  { accessorFn: (t) => t.exitPrice, header: "Precio salida", id: "exitPrice", cell: (c) => num(c.getValue<number>()) },
  {
    accessorFn: (t) => t.pnlPoints,
    header: "Resultado (puntos)",
    id: "pnlPoints",
    cell: (c) => {
      const v = c.getValue<number>();
      return <span className={v >= 0 ? "text-good" : "text-bad"}>{v >= 0 ? "+" : ""}{num(v, 1)}</span>;
    },
  },
  {
    accessorFn: (t) => t.exitReason,
    header: "Motivo de salida",
    id: "exitReason",
    cell: (c) => EXIT_REASON_LABEL[c.getValue<string>()] ?? c.getValue<string>(),
  },
];

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-base-400">{label}</span>
      {children}
    </label>
  );
}
