import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "@trf/shared";

/**
 * Localiza la raíz del monorepo subiendo hasta encontrar el package.json cuyo
 * `name` es `trading-research-framework`. Evita rutas relativas frágiles que
 * se rompen según desde dónde se lance el proceso.
 */
export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
        if (pkg.name === "trading-research-framework") return dir;
      } catch {
        // package.json ilegible: seguimos subiendo.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError("No se encontró la raíz del monorepo (package.json 'trading-research-framework')", {
    startDir: startDir ?? "auto",
  });
}

export interface DatabaseConfig {
  readonly repoRoot: string;
  readonly databaseFile: string;
  /** Caché binaria de columnas para el analizador. */
  readonly cacheDir: string;
  readonly importsDir: string;
  readonly pluginsDir: string;
}

/**
 * Configuración de rutas. `TRF_DATABASE_FILE` permite apuntar a otra base
 * (imprescindible para tests: cada suite abre su propio fichero temporal).
 */
export function loadDatabaseConfig(overrides: Partial<DatabaseConfig> = {}): DatabaseConfig {
  const repoRoot = overrides.repoRoot ?? findRepoRoot();
  const databaseFile =
    overrides.databaseFile ?? process.env["TRF_DATABASE_FILE"] ?? join(repoRoot, "data", "db", "trf.db");

  return {
    repoRoot,
    databaseFile: resolve(databaseFile),
    cacheDir: overrides.cacheDir ?? join(repoRoot, "data", "cache"),
    importsDir: overrides.importsDir ?? join(repoRoot, "data", "imports"),
    pluginsDir: overrides.pluginsDir ?? join(repoRoot, "plugins"),
  };
}

export function ensureDirectories(config: DatabaseConfig): void {
  mkdirSync(dirname(config.databaseFile), { recursive: true });
  mkdirSync(config.cacheDir, { recursive: true });
  mkdirSync(config.importsDir, { recursive: true });
}
