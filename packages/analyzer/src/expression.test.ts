import { describe, expect, it } from "vitest";
import { parseExpression } from "./expression.js";
import { and, between, eq, gt, isNull, lt, not, oneOf, or } from "./predicate.js";

describe("minilenguaje de hipótesis", () => {
  it("parsea una comparación simple", () => {
    expect(parseExpression("volatility.atr > 18")).toEqual(gt("volatility.atr", 18));
  });

  it("acepta = como sinónimo de ==", () => {
    expect(parseExpression("time.minuteOfDay = 570")).toEqual(eq("time.minuteOfDay", 570));
  });

  it("encadena condiciones con and", () => {
    expect(parseExpression("time.minuteOfDay == 570 and volatility.atr > 18")).toEqual(
      and(eq("time.minuteOfDay", 570), gt("volatility.atr", 18)),
    );
  });

  it("and tiene más precedencia que or", () => {
    expect(parseExpression("a.x > 1 and a.y > 2 or a.z > 3")).toEqual(
      or(and(gt("a.x", 1), gt("a.y", 2)), gt("a.z", 3)),
    );
  });

  it("los paréntesis cambian la precedencia", () => {
    expect(parseExpression("a.x > 1 and (a.y > 2 or a.z > 3)")).toEqual(
      and(gt("a.x", 1), or(gt("a.y", 2), gt("a.z", 3))),
    );
  });

  it("soporta not", () => {
    expect(parseExpression("not vwap.side == -1")).toEqual(not(eq("vwap.side", -1)));
  });

  it("soporta between (extremos incluidos)", () => {
    expect(parseExpression("volatility.atrRegime between 0.9 and 1.4")).toEqual(
      between("volatility.atrRegime", 0.9, 1.4, true),
    );
  });

  it("soporta in con lista", () => {
    expect(parseExpression("time.dayOfWeek in (1, 3, 5)")).toEqual(oneOf("time.dayOfWeek", [1, 3, 5]));
  });

  it("soporta is null", () => {
    expect(parseExpression("market.gapPoints is null")).toEqual(isNull("market.gapPoints"));
  });

  it("acepta números negativos y decimales", () => {
    expect(parseExpression("trend.slopeEma20 < -0.25")).toEqual(lt("trend.slopeEma20", -0.25));
  });

  it("una expresión vacía selecciona todo", () => {
    expect(parseExpression("   ")).toEqual({ type: "always" });
  });

  it("reproduce el ejemplo completo del proyecto", () => {
    const predicate = parseExpression(
      "time.minuteOfDay == 570 and volatility.atr > 18 and market.gapPoints < 10 and trend.slopeEma20 > 0",
    );
    expect(predicate.type).toBe("and");
    if (predicate.type !== "and") throw new Error("se esperaba un predicado 'and'");
    expect(predicate.operands).toHaveLength(4);
  });

  it("da errores comprensibles", () => {
    expect(() => parseExpression("volatility.atr >")).toThrow(/final de la expresión/);
    expect(() => parseExpression("volatility.atr 18")).toThrow(/Se esperaba/);
    expect(() => parseExpression("(a.x > 1")).toThrow(/Se esperaba \)/);
    expect(() => parseExpression("a.x between 1")).toThrow(/and/);
    expect(() => parseExpression("a.x @ 1")).toThrow(/inesperado/);
  });
});
