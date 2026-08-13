import { createHash } from "node:crypto";
import {
  DependencyError,
  PluginError,
  isValidVariableKey,
  type Timeframe,
  type VariableDefinition,
} from "@trf/shared";
import type { PluginManifest } from "./manifest.js";
import { isEntryPlugin, isFeaturePlugin, type EntryPlugin, type FeaturePlugin } from "./types.js";

/**
 * REGISTRO DE PLUGINS.
 *
 * Responsabilidades:
 *  1. Guardar qué plugins hay, con qué configuración y si están activos.
 *  2. Resolver el ORDEN de ejecución a partir de las dependencias entre
 *     variables (grafo dirigido acíclico).
 *  3. Detectar colisiones de claves y dependencias imposibles ANTES de
 *     procesar un solo dato.
 *  4. Calcular la "versión del conjunto de features", que permite saber qué
 *     operaciones hay que recalcular cuando cambia un plugin.
 */

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  /** Ruta absoluta del directorio del plugin. */
  readonly directory: string;
  readonly instance: FeaturePlugin<never> | EntryPlugin<never>;
  /** Config efectiva = defaults del manifiesto + overrides del usuario. */
  readonly config: Record<string, unknown>;
  enabled: boolean;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, LoadedPlugin>();
  /** variableKey -> pluginId que la produce. */
  private readonly variableOwners = new Map<string, string>();
  private orderCache: string[] | null = null;

  register(plugin: LoadedPlugin): void {
    if (this.plugins.has(plugin.manifest.id)) {
      throw new PluginError(`El plugin "${plugin.manifest.id}" ya está registrado`, { id: plugin.manifest.id });
    }

    if (isFeaturePlugin(plugin.instance)) {
      this.validateProvides(plugin);
      for (const definition of plugin.instance.provides) {
        this.variableOwners.set(definition.key, plugin.manifest.id);
      }
    } else if (!isEntryPlugin(plugin.instance)) {
      throw new PluginError(
        `El plugin "${plugin.manifest.id}" no implementa ni compute() ni onBarClose()`,
        { id: plugin.manifest.id },
      );
    }

    this.plugins.set(plugin.manifest.id, plugin);
    this.orderCache = null;
  }

  /**
   * Comprueba tres cosas que, si fallan, producen bugs silenciosos:
   *  - que las claves del manifiesto y las del código coincidan;
   *  - que las claves tengan formato `namespace.nombre`;
   *  - que ningún otro plugin ya produzca la misma clave.
   */
  private validateProvides(plugin: LoadedPlugin): void {
    const instance = plugin.instance as FeaturePlugin<never>;
    const codeKeys = instance.provides.map((d) => d.key).sort();
    const manifestKeys = [...plugin.manifest.provides].sort();

    if (manifestKeys.length > 0 && JSON.stringify(codeKeys) !== JSON.stringify(manifestKeys)) {
      throw new PluginError(
        `El plugin "${plugin.manifest.id}" declara en plugin.json variables distintas de las que produce su código`,
        { id: plugin.manifest.id, manifest: manifestKeys, code: codeKeys },
      );
    }

    for (const definition of instance.provides) {
      if (!isValidVariableKey(definition.key)) {
        throw new PluginError(
          `Clave de variable inválida "${definition.key}" (formato esperado: namespace.nombre)`,
          { id: plugin.manifest.id, key: definition.key },
        );
      }
      const owner = this.variableOwners.get(definition.key);
      if (owner !== undefined && owner !== plugin.manifest.id) {
        throw new PluginError(
          `Colisión de variables: "${definition.key}" ya la produce el plugin "${owner}"`,
          { key: definition.key, existingOwner: owner, newOwner: plugin.manifest.id },
        );
      }
    }
  }

  get(id: string): LoadedPlugin | null {
    return this.plugins.get(id) ?? null;
  }

  all(): readonly LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  setEnabled(id: string, enabled: boolean): void {
    const plugin = this.plugins.get(id);
    if (plugin === undefined) throw new PluginError(`Plugin desconocido: ${id}`, { id });
    plugin.enabled = enabled;
    this.orderCache = null;
  }

  /** Quita un plugin. El núcleo no se entera: nada depende de él por nombre. */
  unregister(id: string): boolean {
    const plugin = this.plugins.get(id);
    if (plugin === undefined) return false;
    if (isFeaturePlugin(plugin.instance)) {
      for (const definition of plugin.instance.provides) this.variableOwners.delete(definition.key);
    }
    this.plugins.delete(id);
    this.orderCache = null;
    return true;
  }

  // -------------------------------------------------------------------------
  // Resolución de dependencias
  // -------------------------------------------------------------------------

  /**
   * Orden topológico de los plugins de features activos.
   *
   * Si `reversal-plugin` necesita `volatility.atr14`, se garantiza que
   * `core-volatility` se ejecuta antes. Sin esto, el plugin recibiría `null` y
   * produciría variables silenciosamente vacías.
   *
   * Algoritmo de Kahn; el desempate es alfabético para que el orden sea
   * DETERMINISTA (dos ejecuciones distintas deben dar exactamente lo mismo).
   */
  resolveOrder(): string[] {
    if (this.orderCache !== null) return this.orderCache;

    const active = this.all().filter((p) => p.enabled && isFeaturePlugin(p.instance));
    const activeIds = new Set(active.map((p) => p.manifest.id));

    const dependencies = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();
    for (const plugin of active) {
      dependencies.set(plugin.manifest.id, new Set());
      dependents.set(plugin.manifest.id, new Set());
    }

    for (const plugin of active) {
      for (const requiredKey of plugin.manifest.requires.features) {
        const owner = this.variableOwners.get(requiredKey);
        if (owner === undefined) {
          throw new DependencyError(
            `El plugin "${plugin.manifest.id}" necesita la variable "${requiredKey}", que no la produce ningún plugin`,
            { plugin: plugin.manifest.id, missing: requiredKey },
          );
        }
        if (!activeIds.has(owner)) {
          throw new DependencyError(
            `El plugin "${plugin.manifest.id}" necesita "${requiredKey}", producida por "${owner}", que está desactivado`,
            { plugin: plugin.manifest.id, required: requiredKey, disabledOwner: owner },
          );
        }
        if (owner === plugin.manifest.id) continue;
        dependencies.get(plugin.manifest.id)?.add(owner);
        dependents.get(owner)?.add(plugin.manifest.id);
      }
    }

    const ready = active
      .filter((p) => (dependencies.get(p.manifest.id)?.size ?? 0) === 0)
      .map((p) => p.manifest.id)
      .sort();

    const order: string[] = [];
    while (ready.length > 0) {
      const id = ready.shift() as string;
      order.push(id);
      const next: string[] = [];
      for (const dependent of dependents.get(id) ?? []) {
        const deps = dependencies.get(dependent);
        deps?.delete(id);
        if (deps !== undefined && deps.size === 0) next.push(dependent);
      }
      next.sort();
      ready.push(...next);
      ready.sort();
    }

    if (order.length !== active.length) {
      const stuck = active.map((p) => p.manifest.id).filter((id) => !order.includes(id));
      throw new DependencyError("Ciclo de dependencias entre plugins", { involved: stuck });
    }

    this.orderCache = order;
    return order;
  }

  /** Plugins de features activos, ya ordenados. */
  featurePlugins(): LoadedPlugin[] {
    return this.resolveOrder().map((id) => this.plugins.get(id) as LoadedPlugin);
  }

  entryPlugins(): LoadedPlugin[] {
    return this.all()
      .filter((p) => p.enabled && isEntryPlugin(p.instance))
      .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  /** Todas las variables que aportan los plugins activos. */
  variableDefinitions(): VariableDefinition[] {
    const definitions: VariableDefinition[] = [];
    for (const plugin of this.featurePlugins()) {
      const instance = plugin.instance as FeaturePlugin<never>;
      for (const definition of instance.provides) {
        definitions.push({
          ...definition,
          producedBy: plugin.manifest.id,
          producerVersion: plugin.manifest.version,
        });
      }
    }
    return definitions;
  }

  /** Unión de los timeframes que piden los plugins activos. */
  requiredTimeframes(): Timeframe[] {
    const set = new Set<Timeframe>();
    for (const plugin of this.all()) {
      if (!plugin.enabled) continue;
      for (const tf of plugin.manifest.requires.timeframes) set.add(tf);
    }
    return [...set];
  }

  /** Máximo calentamiento pedido: dimensiona los buffers de velas. */
  maxWarmupBars(): number {
    let max = 0;
    for (const plugin of this.all()) {
      if (plugin.enabled) max = Math.max(max, plugin.manifest.requires.warmupBars);
    }
    return max;
  }

  /**
   * Huella del conjunto de features activo.
   *
   * Se guarda en cada operación (`featureSetVersion`). Cuando cambias la
   * configuración de un plugin o actualizas su versión, la huella cambia y
   * `trf features:build` sabe exactamente qué operaciones están obsoletas,
   * sin recalcularlo todo.
   */
  featureSetVersion(): string {
    const parts = this.featurePlugins()
      .map((p) => `${p.manifest.id}@${p.manifest.version}:${stableStringify(p.config)}`)
      .sort();
    return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  }
}

/** JSON con claves ordenadas: hashes estables ante reordenaciones. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
