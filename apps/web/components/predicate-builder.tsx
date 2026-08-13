"use client";

import { useEffect, useState } from "react";
import type { VariableDefinition } from "@trf/shared";

/**
 * EDITOR VISUAL DE HIPÓTESIS.
 *
 * Compone cláusulas "variable OP valor" unidas por AND — el caso de uso más
 * común (regla 2 del README: la causalidad siempre visible, así que sólo
 * ofrece variables `predictor`). Para expresiones con OR, NOT, BETWEEN o IN
 * hay un modo de texto libre que habla el mismo minilenguaje que el CLI
 * (`packages/analyzer/src/expression.ts`); el propio servidor valida y
 * bloquea variables de resultado al guardar o probar, así que este
 * componente no necesita reimplementar esa guarda.
 */

type Op = ">" | ">=" | "<" | "<=" | "==" | "!=";
const OPERATORS: readonly Op[] = [">", ">=", "<", "<=", "==", "!="];

interface Clause {
  readonly id: string;
  readonly variable: string;
  readonly op: Op;
  readonly value: string;
}

function emptyClause(defaultVariable: string): Clause {
  return { id: crypto.randomUUID(), variable: defaultVariable, op: ">", value: "" };
}

function compile(clauses: readonly Clause[]): string {
  return clauses
    .filter((c) => c.variable.length > 0 && c.value.trim().length > 0)
    .map((c) => `${c.variable} ${c.op} ${c.value.trim()}`)
    .join(" and ");
}

export function PredicateBuilder({
  variables,
  value,
  onChange,
}: {
  variables: readonly VariableDefinition[];
  value: string;
  onChange: (expression: string) => void;
}): JSX.Element {
  const predictors = variables.filter((v) => v.causality === "predictor");
  const [mode, setMode] = useState<"builder" | "text">("text");
  const [clauses, setClauses] = useState<Clause[]>([emptyClause(predictors[0]?.key ?? "")]);

  useEffect(() => {
    if (mode === "builder") onChange(compile(clauses));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clauses, mode]);

  function updateClause(id: string, patch: Partial<Clause>): void {
    setClauses((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function addClause(): void {
    setClauses((prev) => [...prev, emptyClause(predictors[0]?.key ?? "")]);
  }

  function removeClause(id: string): void {
    setClauses((prev) => (prev.length > 1 ? prev.filter((c) => c.id !== id) : prev));
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          onClick={() => setMode("builder")}
          className={`rounded px-2 py-1 ${mode === "builder" ? "bg-base-800 text-accent" : "text-base-400 hover:text-base-100"}`}
        >
          Constructor visual
        </button>
        <button
          type="button"
          onClick={() => setMode("text")}
          className={`rounded px-2 py-1 ${mode === "text" ? "bg-base-800 text-accent" : "text-base-400 hover:text-base-100"}`}
        >
          Texto libre
        </button>
      </div>

      {mode === "builder" ? (
        <div className="space-y-2">
          {clauses.map((clause, i) => (
            <div key={clause.id} className="flex items-center gap-2">
              {i > 0 && <span className="w-8 shrink-0 text-xs text-base-400">AND</span>}
              {i === 0 && <span className="w-8 shrink-0" />}
              <select
                value={clause.variable}
                onChange={(e) => updateClause(clause.id, { variable: e.target.value })}
                className="flex-1 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
              >
                <option value="" disabled>
                  variable…
                </option>
                {predictors.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.label} ({v.key})
                  </option>
                ))}
              </select>
              <select
                value={clause.op}
                onChange={(e) => updateClause(clause.id, { op: e.target.value as Op })}
                className="w-20 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
              >
                {OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              <input
                type="number"
                value={clause.value}
                onChange={(e) => updateClause(clause.id, { value: e.target.value })}
                placeholder="valor"
                className="w-28 rounded border border-base-700 bg-base-850 px-2 py-1.5 text-sm text-base-100"
              />
              <button
                type="button"
                onClick={() => removeClause(clause.id)}
                className="px-1 text-base-400 hover:text-bad"
                aria-label="Quitar condición"
              >
                ✕
              </button>
            </div>
          ))}
          <button type="button" onClick={addClause} className="text-xs text-accent hover:underline">
            + añadir condición (AND)
          </button>
          <div className="rounded border border-base-800 bg-base-950 px-3 py-2 font-mono text-xs text-base-300">
            {compile(clauses) || "todas las operaciones"}
          </div>
        </div>
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder='time.minuteOfDay == 570 and volatility.atr > 18'
          rows={3}
          className="w-full resize-y rounded border border-base-700 bg-base-850 px-3 py-2 font-mono text-sm text-base-100"
        />
      )}
    </div>
  );
}
