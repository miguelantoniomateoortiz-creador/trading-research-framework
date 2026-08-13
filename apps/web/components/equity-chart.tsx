"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { num } from "@/lib/format";

/**
 * Curva de equity acumulada de una cohorte. El framework insiste en mirar
 * esto, no sólo el profit factor: una equity que sube en línea recta (R² alto
 * en la ficha de métricas) es un edge real; una que sube a saltos por dos
 * operaciones enormes es sobreajuste con buena suerte.
 */
export function EquityChart({
  curve,
  label,
  color = "#5eead4",
}: {
  curve: readonly number[];
  label?: string;
  color?: string;
}): JSX.Element {
  if (curve.length < 2) {
    return <div className="panel flex h-56 items-center justify-center text-sm text-base-400">Sin suficientes datos para graficar.</div>;
  }

  const data = curve.map((value, i) => ({ i, value }));

  return (
    <div className="panel p-4">
      {label !== undefined && <div className="mb-2 text-sm font-medium text-base-100">{label}</div>}
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3d" vertical={false} />
          <XAxis dataKey="i" tick={{ fill: "#7b8496", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "#2a2f3d" }} />
          <YAxis
            tick={{ fill: "#7b8496", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "#2a2f3d" }}
            tickFormatter={(v: number) => num(v, 0)}
            width={60}
          />
          <ReferenceLine y={0} stroke="#3a4155" />
          <Tooltip
            contentStyle={{ background: "#161922", border: "1px solid #2a2f3d", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "#a3abbb" }}
            formatter={(value: number) => [num(value, 2), "equity"]}
            labelFormatter={(i: number) => `operación #${i + 1}`}
          />
          <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
