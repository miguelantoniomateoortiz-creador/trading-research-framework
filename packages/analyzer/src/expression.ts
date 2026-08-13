import { ValidationError } from "@trf/shared";
import { and, between, compare, isNull, not, oneOf, or, type ComparisonOperator, type Predicate } from "./predicate.js";

/**
 * MINILENGUAJE DE HIPÓTESIS.
 *
 * Convierte texto en un árbol de predicados, para poder escribir en el CLI y
 * en la interfaz:
 *
 *   time.minuteOfDay == 570 and volatility.atr > 18 and market.gapPoints < 10
 *   (nas100.impulseDirection == 1 and nas100.excursionAgainstImpulseAtr > 0.5) or time.dayOfWeek in (1, 5)
 *   volatility.atrRegime between 0.9 and 1.4 and not vwap.side == -1
 *
 * Gramática (precedencia de menor a mayor):
 *
 *   expr    := term ( "or" term )*
 *   term    := factor ( "and" factor )*
 *   factor  := "not" factor | "(" expr ")" | atom
 *   atom    := IDENT ( comparación | "between" NUM "and" NUM | "in" "(" lista ")" | "is" "null" )
 *
 * El resultado es exactamente el mismo AST que se construye con las funciones
 * del módulo `predicate`, así que se guarda, se serializa y se valida igual.
 */

type TokenType = "ident" | "number" | "op" | "paren" | "comma" | "keyword";

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly position: number;
}

const KEYWORDS = new Set(["and", "or", "not", "between", "in", "is", "null"]);
const OPERATORS = [">=", "<=", "!=", "==", "=", ">", "<"];

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i] as string;

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char, position: i });
      i++;
      continue;
    }

    if (char === ",") {
      tokens.push({ type: "comma", value: ",", position: i });
      i++;
      continue;
    }

    const operator = OPERATORS.find((op) => input.startsWith(op, i));
    if (operator !== undefined) {
      tokens.push({ type: "op", value: operator === "=" ? "==" : operator, position: i });
      i += operator.length;
      continue;
    }

    if (/[0-9]/.test(char) || (char === "-" && /[0-9.]/.test(input[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < input.length && /[0-9._eE+-]/.test(input[j] as string)) {
        // Evita tragarse el signo de una expresión posterior.
        if ((input[j] === "+" || input[j] === "-") && !/[eE]/.test(input[j - 1] as string)) break;
        j++;
      }
      const raw = input.slice(i, j).replace(/_/g, "");
      if (!Number.isFinite(Number(raw))) {
        throw new ValidationError(`Número inválido: "${raw}"`, { position: i });
      }
      tokens.push({ type: "number", value: raw, position: i });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_.]/.test(input[j] as string)) j++;
      const word = input.slice(i, j);
      tokens.push({ type: KEYWORDS.has(word.toLowerCase()) ? "keyword" : "ident", value: word, position: i });
      i = j;
      continue;
    }

    throw new ValidationError(`Carácter inesperado "${char}" en la posición ${i}`, { position: i, input });
  }

  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): Predicate {
    const result = this.parseOr();
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index] as Token;
      throw new ValidationError(`Sobra "${token.value}" en la posición ${token.position}`, { token });
    }
    return result;
  }

  private peek(): Token | null {
    return this.tokens[this.index] ?? null;
  }

  private consumeKeyword(word: string): boolean {
    const token = this.peek();
    if (token !== null && token.type === "keyword" && token.value.toLowerCase() === word) {
      this.index++;
      return true;
    }
    return false;
  }

  private expect(type: TokenType, value?: string): Token {
    const token = this.peek();
    if (token === null || token.type !== type || (value !== undefined && token.value !== value)) {
      throw new ValidationError(
        `Se esperaba ${value ?? type} y se encontró ${token === null ? "el final de la expresión" : `"${token.value}"`}`,
        { expected: value ?? type, found: token?.value ?? null },
      );
    }
    this.index++;
    return token;
  }

  private parseOr(): Predicate {
    const operands = [this.parseAnd()];
    while (this.consumeKeyword("or")) operands.push(this.parseAnd());
    return operands.length === 1 ? (operands[0] as Predicate) : or(...operands);
  }

  private parseAnd(): Predicate {
    const operands = [this.parseFactor()];
    while (this.consumeKeyword("and")) operands.push(this.parseFactor());
    return operands.length === 1 ? (operands[0] as Predicate) : and(...operands);
  }

  private parseFactor(): Predicate {
    if (this.consumeKeyword("not")) return not(this.parseFactor());

    const token = this.peek();
    if (token !== null && token.type === "paren" && token.value === "(") {
      this.index++;
      const inner = this.parseOr();
      this.expect("paren", ")");
      return inner;
    }

    return this.parseAtom();
  }

  private parseAtom(): Predicate {
    const identifier = this.expect("ident");
    const variable = identifier.value;

    if (this.consumeKeyword("between")) {
      const min = Number(this.expect("number").value);
      if (!this.consumeKeyword("and")) {
        throw new ValidationError('En "between" falta la palabra "and"', { variable });
      }
      const max = Number(this.expect("number").value);
      return between(variable, min, max, true);
    }

    if (this.consumeKeyword("in")) {
      this.expect("paren", "(");
      const values: number[] = [Number(this.expect("number").value)];
      while (this.peek()?.type === "comma") {
        this.index++;
        values.push(Number(this.expect("number").value));
      }
      this.expect("paren", ")");
      return oneOf(variable, values);
    }

    if (this.consumeKeyword("is")) {
      if (!this.consumeKeyword("null")) {
        throw new ValidationError('Tras "is" se esperaba "null"', { variable });
      }
      return isNull(variable);
    }

    const operator = this.expect("op").value as ComparisonOperator;
    const value = Number(this.expect("number").value);
    return compare(variable, operator, value);
  }
}

/** Parsea una expresión y devuelve el predicado equivalente. */
export function parseExpression(input: string): Predicate {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { type: "always" };
  return new Parser(tokenize(trimmed)).parse();
}
