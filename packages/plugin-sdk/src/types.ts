import type { Direction, FeatureVector, Instrument, VariableDefinition } from "@trf/shared";
import type { MarketView } from "./market-view.js";
import type { PluginManifest } from "./manifest.js";

/**
 * CONTRATOS DE PLUGIN.
 *
 * Tres tipos, todos opcionales dentro del mismo paquete:
 *   - `FeaturePlugin`: añade variables a cada operación.
 *   - `EntryPlugin`: genera operaciones (define cuándo se entra).
 *   - `AnalysisPlugin`: aporta análisis derivados (para el nivel 6-8).
 *
 * El núcleo no conoce ninguna estrategia concreta. Añadir una idea nueva =
 * crear una carpeta en `plugins/`. Cero cambios en el núcleo.
 */

export interface PluginLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

/** Contexto de inicialización: se ejecuta una vez por corrida. */
export interface PluginInitContext<Config = Record<string, unknown>> {
  readonly config: Config;
  readonly instrument: Instrument;
  readonly logger: PluginLogger;
}

/** Datos de la operación conocidos EN EL MOMENTO DE LA ENTRADA. */
export interface TradeEntryContext {
  readonly id: string;
  readonly direction: Direction;
  readonly entryTs: number;
  readonly entryPrice: number;
  readonly takeProfitPrice: number | null;
  readonly stopLossPrice: number | null;
  readonly entryRuleId: string;
}

/**
 * Contexto de cálculo de variables.
 *
 * Fíjate en lo que NO está: ni el precio de salida, ni el P&L, ni el MAE. Un
 * `FeaturePlugin` no puede ver el resultado ni por accidente.
 */
export interface FeatureContext<Config = Record<string, unknown>> {
  readonly config: Config;
  readonly market: MarketView;
  readonly trade: TradeEntryContext;
  /**
   * Valor de una variable producida por un plugin del que este depende
   * (declarado en `requires.features`). `null` si aún no está disponible.
   */
  feature(key: string): number | null;
  readonly logger: PluginLogger;
}

export interface FeaturePlugin<Config = Record<string, unknown>> {
  /**
   * Opcional: el manifiesto autorizado es siempre el `plugin.json` del disco.
   * El cargador lo inyecta aquí, de modo que un plugin no tiene que repetir
   * su id y su versión en dos sitios (y no pueden desincronizarse).
   */
  readonly manifest?: PluginManifest;
  /** Definiciones completas de las variables que produce. */
  readonly provides: readonly VariableDefinition[];

  init?(ctx: PluginInitContext<Config>): void | Promise<void>;

  /**
   * Calcula las variables para una operación.
   *
   * Debe ser PURA respecto al mercado: mismas velas + misma config = mismo
   * resultado. Si necesita estado incremental (una EMA, por ejemplo), debe
   * mantenerlo con `onBar`, no dentro de `compute`.
   */
  compute(ctx: FeatureContext<Config>): FeatureVector;

  /**
   * Gancho opcional invocado con cada vela cerrada, en orden cronológico,
   * ANTES de cualquier `compute` de esa vela. Es donde se actualizan
   * indicadores incrementales (EMA, ATR, VWAP) en O(1).
   */
  onBar?(bar: import("@trf/shared").Bar, market: MarketView): void;

  /** Reinicia el estado incremental (cambio de instrumento o de dataset). */
  reset?(): void;
  dispose?(): void;
}

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

/**
 * Señal de entrada emitida por un `EntryPlugin`.
 *
 * Sólo describe la ENTRADA y las condiciones de salida. El simulador
 * (`@trf/analyzer/simulator`) resuelve el resultado recorriendo las velas
 * siguientes; el plugin nunca decide cuánto ganó.
 */
export interface EntrySignal {
  readonly direction: Direction;
  /** Distancia del take profit en puntos. `null` = sin TP. */
  readonly takeProfitPoints: number | null;
  /** Distancia del stop loss en puntos. `null` = sin SL. */
  readonly stopLossPoints: number | null;
  /** Cierre forzado tras N minutos. Evita operaciones abiertas para siempre. */
  readonly maxHoldMinutes: number;
  /** Etiqueta libre; se guarda como feature `entry.tag`. */
  readonly tag?: string;
}

export interface EntryContext<Config = Record<string, unknown>> {
  readonly config: Config;
  readonly market: MarketView;
  readonly logger: PluginLogger;
}

export interface EntryPlugin<Config = Record<string, unknown>> {
  readonly manifest?: PluginManifest;
  init?(ctx: PluginInitContext<Config>): void | Promise<void>;

  /**
   * Se invoca en el cierre de cada vela del timeframe primario.
   * Devuelve las señales que se abren en la APERTURA de la vela siguiente.
   *
   * Esa regla (decidir en el cierre, entrar en la apertura siguiente) es lo
   * que hace el backtest honesto: no se puede entrar a un precio que ya sabes.
   */
  onBarClose(ctx: EntryContext<Config>): readonly EntrySignal[];

  reset?(): void;
  dispose?(): void;
}

export type AnyPlugin = FeaturePlugin<never> | EntryPlugin<never>;

// ---------------------------------------------------------------------------
// Helpers de autoría
// ---------------------------------------------------------------------------

/**
 * Ayuda a escribir un plugin de variables con inferencia de tipos correcta.
 * No hace magia: sólo fija el tipo de `Config`.
 */
export function defineFeaturePlugin<Config>(plugin: FeaturePlugin<Config>): FeaturePlugin<Config> {
  return plugin;
}

export function defineEntryPlugin<Config>(plugin: EntryPlugin<Config>): EntryPlugin<Config> {
  return plugin;
}

export function isFeaturePlugin(plugin: unknown): plugin is FeaturePlugin<Record<string, unknown>> {
  return typeof plugin === "object" && plugin !== null && typeof (plugin as FeaturePlugin).compute === "function";
}

export function isEntryPlugin(plugin: unknown): plugin is EntryPlugin<Record<string, unknown>> {
  return typeof plugin === "object" && plugin !== null && typeof (plugin as EntryPlugin).onBarClose === "function";
}

/** Logger de consola con prefijo del plugin. */
export function createLogger(pluginId: string, verbose = false): PluginLogger {
  const prefix = `[${pluginId}]`;
  return {
    debug(message, context) {
      if (verbose) console.debug(prefix, message, context ?? "");
    },
    info(message, context) {
      console.info(prefix, message, context ?? "");
    },
    warn(message, context) {
      console.warn(prefix, message, context ?? "");
    },
  };
}
