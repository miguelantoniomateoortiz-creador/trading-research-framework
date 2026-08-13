import { summarize } from "@trf/shared";
import { describe, expect, it } from "vitest";
import { bonferroniQValue, decideValidation } from "./hypotheses.js";

/**
 * `decideValidation` es el corazón del nivel 7: comparar contra el INTERVALO
 * de confianza de entrenamiento, no contra el punto. Las pruebas construyen
 * poblaciones de P&L realistas (en vez de objetos `CohortMetrics` a mano)
 * para que el IC salga de la misma `summarize()` que usa el resto del motor.
 */

function pnl(n: number, winFraction: number, win: number, loss: number): number[] {
  const wins = Math.round(n * winFraction);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i < wins ? win : -loss);
  return out;
}

describe("decideValidation", () => {
  // WR ≈ 70%, n=200 -> IC95% aproximadamente [0.636, 0.764].
  const training = summarize(pnl(200, 0.7, 10, 8));

  it("valida cuando el WR de validación cae dentro del IC de entrenamiento y la expectancy es positiva", () => {
    const validation = summarize(pnl(80, 0.68, 10, 8));
    const decision = decideValidation(training, validation);
    expect(decision.passed).toBe(true);
    expect(decision.reason).toMatch(/IC95%/);
  });

  it("NO rechaza sólo porque el WR puntual baje, si sigue dentro del IC", () => {
    // 68% < 70% (el punto bajó) pero sigue dentro de [63.6%, 76.4%]: no es un fallo.
    const validation = summarize(pnl(80, 0.68, 10, 8));
    expect(validation.winRate).toBeLessThan(training.winRate);
    expect(decideValidation(training, validation).passed).toBe(true);
  });

  it("rechaza cuando el WR de validación cae por debajo del límite inferior del IC", () => {
    const validation = summarize(pnl(80, 0.3, 10, 8));
    const decision = decideValidation(training, validation);
    expect(decision.passed).toBe(false);
    expect(decision.reason).toMatch(/por debajo/);
  });

  it("rechaza si el WR es compatible pero la expectancy en validación no es positiva", () => {
    // WR 70%, dentro del IC, pero las ganadoras son minúsculas frente a las perdedoras.
    const validation = summarize(pnl(80, 0.7, 1, 3));
    expect(validation.expectancy).toBeLessThan(0);
    const decision = decideValidation(training, validation);
    expect(decision.passed).toBe(false);
    expect(decision.reason).toMatch(/no es positiva/);
  });

  it("rechaza si el split de validación no aporta ninguna operación", () => {
    const decision = decideValidation(training, summarize([]));
    expect(decision.passed).toBe(false);
    expect(decision.reason).toMatch(/ninguna operación/);
  });
});

describe("bonferroniQValue", () => {
  it("multiplica el p-valor por el tamaño del espacio de búsqueda, acotado a 1", () => {
    expect(bonferroniQValue(0.001, 100)).toBeCloseTo(0.1, 10);
    expect(bonferroniQValue(0.5, 100)).toBe(1);
  });

  it("no reduce el p-valor por debajo de sí mismo (espacio mínimo 1)", () => {
    expect(bonferroniQValue(0.03, 0)).toBeCloseTo(0.03, 10);
  });

  it("es siempre más conservador (mayor o igual) que un BH real sobre el mismo conjunto", () => {
    // Con 5 p-valores, BH del más pequeño es min(1, p_(1) * n / 1) = p_(1) * n,
    // que coincide con Bonferroni sólo para el más significativo: es la cota,
    // no una aproximación más laxa.
    const q = bonferroniQValue(0.01, 5);
    expect(q).toBeCloseTo(0.05, 10);
  });
});
