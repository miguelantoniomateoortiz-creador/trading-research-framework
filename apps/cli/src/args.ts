/**
 * Parser de argumentos mínimo.
 *
 * No se usa una librería a propósito: la superficie que se necesita
 * (`--clave valor`, `--bandera`, posicionales) son 40 líneas, y el CLI es la
 * puerta de entrada al proyecto — cuantas menos dependencias tenga, menos
 * probable es que deje de arrancar dentro de dos años.
 */

export interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=", 2);
      if (key === undefined || key.length === 0) continue;
      if (inlineValue !== undefined) {
        options.set(key, inlineValue);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          options.set(key, next);
          i++;
        } else {
          options.set(key, true);
        }
      }
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, options };
}

export function getString(args: ParsedArgs, key: string, fallback: string): string {
  const value = args.options.get(key);
  return typeof value === "string" ? value : fallback;
}

export function requireString(args: ParsedArgs, key: string): string {
  const value = args.options.get(key);
  if (typeof value !== "string") {
    throw new Error(`Falta la opción obligatoria --${key}`);
  }
  return value;
}

export function getNumber(args: ParsedArgs, key: string, fallback: number): number {
  const value = args.options.get(key);
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`La opción --${key} debe ser numérica`);
  return parsed;
}

export function getFlag(args: ParsedArgs, key: string): boolean {
  return args.options.get(key) === true || args.options.get(key) === "true";
}
