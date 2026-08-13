import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginError, ValidationError } from "@trf/shared";
import { parseManifest, type PluginManifest } from "./manifest.js";
import { PluginRegistry, type LoadedPlugin } from "./registry.js";
import { isEntryPlugin, isFeaturePlugin, type EntryPlugin, type FeaturePlugin } from "./types.js";

/**
 * CARGADOR DE PLUGINS.
 *
 * Descubre subdirectorios de `plugins/` que contengan `plugin.json`, valida el
 * manifiesto e importa el módulo dinámicamente.
 *
 * Dos fases separadas a propósito:
 *   1. `discoverManifests()` — sólo lee JSON. Barato y seguro: el dashboard
 *      puede listar y activar/desactivar plugins sin ejecutar su código.
 *   2. `loadPlugins()` — importa los módulos de los plugins activos.
 *
 * Un plugin desactivado nunca se importa, así que un plugin roto no puede
 * tumbar la plataforma: basta con desactivarlo.
 */

export interface DiscoveredPlugin {
  readonly manifest: PluginManifest;
  readonly directory: string;
}

/** Busca `plugin.json` en cada subdirectorio de primer nivel de `pluginsDir`. */
export function discoverManifests(pluginsDir: string): DiscoveredPlugin[] {
  if (!existsSync(pluginsDir)) return [];

  const discovered: DiscoveredPlugin[] = [];
  for (const entry of readdirSync(pluginsDir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const directory = join(pluginsDir, entry);
    if (!statSync(directory).isDirectory()) continue;

    const manifestPath = join(directory, "plugin.json");
    if (!existsSync(manifestPath)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (cause) {
      throw new ValidationError(`plugin.json ilegible en ${directory}`, { directory }, { cause });
    }
    discovered.push({ manifest: parseManifest(raw, manifestPath), directory: resolve(directory) });
  }

  return discovered.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

export interface LoadOptions {
  /** Estado guardado en base de datos: si un plugin está activo y con qué config. */
  readonly overrides?: ReadonlyMap<string, { enabled?: boolean; config?: Record<string, unknown> }>;
  /** Si es true, un plugin que falla al importarse se salta con aviso. */
  readonly tolerant?: boolean;
  readonly onError?: (pluginId: string, error: unknown) => void;
}

/** Importa el módulo de un plugin y devuelve su instancia. */
export async function importPlugin(discovered: DiscoveredPlugin): Promise<FeaturePlugin<never> | EntryPlugin<never>> {
  const entryPath = resolve(discovered.directory, discovered.manifest.entry);
  if (!existsSync(entryPath)) {
    throw new PluginError(`El plugin "${discovered.manifest.id}" apunta a un entry inexistente`, {
      id: discovered.manifest.id,
      entry: entryPath,
    });
  }

  const module = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
  const candidate = module["default"] ?? module["plugin"];

  if (!isFeaturePlugin(candidate) && !isEntryPlugin(candidate)) {
    throw new PluginError(
      `El plugin "${discovered.manifest.id}" debe exportar por defecto un objeto con compute() u onBarClose()`,
      { id: discovered.manifest.id, entry: entryPath, exportedKeys: Object.keys(module) },
    );
  }

  // El manifiesto del disco manda: es la fuente única de verdad para id,
  // versión y dependencias. Se inyecta con defineProperty en vez de con spread
  // para no romper el `this` de plugins escritos como clases.
  Object.defineProperty(candidate, "manifest", {
    value: discovered.manifest,
    enumerable: true,
    configurable: true,
    writable: false,
  });
  return candidate as FeaturePlugin<never> | EntryPlugin<never>;
}

/** Descubre, importa y registra todos los plugins de un directorio. */
export async function loadPlugins(pluginsDir: string, options: LoadOptions = {}): Promise<PluginRegistry> {
  const registry = new PluginRegistry();
  const discovered = discoverManifests(pluginsDir);

  for (const item of discovered) {
    const override = options.overrides?.get(item.manifest.id);
    const enabled = override?.enabled ?? item.manifest.enabledByDefault;
    const config = { ...item.manifest.config, ...(override?.config ?? {}) };

    if (!enabled) {
      // No se importa el módulo: un plugin desactivado no ejecuta código.
      continue;
    }

    try {
      const instance = await importPlugin(item);
      const loaded: LoadedPlugin = { manifest: item.manifest, directory: item.directory, instance, config, enabled };
      registry.register(loaded);
    } catch (error) {
      if (options.tolerant === true) {
        options.onError?.(item.manifest.id, error);
        continue;
      }
      throw error;
    }
  }

  // Falla temprano si el grafo de dependencias es imposible.
  registry.resolveOrder();
  return registry;
}

/** Inicializa los plugins registrados. Se llama una vez por corrida. */
export async function initializePlugins(
  registry: PluginRegistry,
  context: { instrument: import("@trf/shared").Instrument; verbose?: boolean },
): Promise<void> {
  const { createLogger } = await import("./types.js");
  for (const plugin of [...registry.featurePlugins(), ...registry.entryPlugins()]) {
    const instance = plugin.instance as { init?: (ctx: unknown) => void | Promise<void> };
    if (typeof instance.init === "function") {
      await instance.init({
        config: plugin.config,
        instrument: context.instrument,
        logger: createLogger(plugin.manifest.id, context.verbose ?? false),
      });
    }
  }
}
