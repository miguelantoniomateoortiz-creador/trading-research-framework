import {
  computeRuleFingerprint,
  insertTrades,
  iterateBars,
  upsertEntryRule,
  upsertVariables,
  type SqliteDatabase,
  type TradeRow,
} from "@trf/database";
import {
  DailyAggregator,
  SeriesBuffer,
  createLogger,
  createMarketView,
  isEntryPlugin,
  isFeaturePlugin,
  type EntryPlugin,
  type EntrySignal,
  type FeaturePlugin,
  type MarketView,
  type PluginRegistry,
} from "@trf/plugin-sdk";
import {
  calendarParts,
  timeframeToMinutes,
  type Bar,
  type FeatureVector,
  type Instrument,
  type Timeframe,
} from "@trf/shared";
import { TradeSimulator, type ClosedTrade, type SimulationCosts } from "./simulator.js";
import { TimeframeAggregator } from "./timeframe.js";

/**
 * MOTOR DE EJECUCIÓN — de velas a operaciones con variables.
 *
 * Un ÚNICO recorrido cronológico del histórico. Para cada vela, en este orden
 * exacto (el orden ES la corrección del backtest):
 *
 *   1. Abrir las señales pendientes de la vela anterior, a la APERTURA de ésta.
 *   2. Calcular sus variables. Los buffers todavía contienen sólo velas
 *      anteriores, así que ningún plugin puede ver la vela en la que entra.
 *   3. Actualizar las posiciones abiertas con esta vela (recorrido, TP/SL).
 *   4. Cerrar la vela: alimentar buffers e indicadores de los plugins.
 *   5. Preguntar a los plugins de entrada. Sus señales se abrirán en el paso 1
 *      de la vela siguiente.
 *
 * Invertir 2 y 4 sería el clásico lookahead de un solo periodo: el backtest
 * mejoraría muchísimo y sería mentira.
 */

export interface RunOptions {
  readonly db: SqliteDatabase;
  /**
   * Conexión SEPARADA para escribir (variables, reglas de entrada, lotes de
   * operaciones). Si no se pasa, se reutiliza `db`.
   *
   * Por qué hace falta: `db` recorre las velas con `iterateBars`, que usa
   * `Statement#iterate()` de better-sqlite3 — un iterador que mantiene el
   * statement "a medio pasar" entre vela y vela. Ejecutar OTRA consulta en esa
   * misma conexión mientras el iterador sigue abierto (p.ej. el volcado por
   * lotes de operaciones a mitad de recorrido) hace que better-sqlite3 lance
   * "This database connection is busy executing a query". Con datasets
   * pequeños nunca se cruzaba el umbral de lote (`batchSize`) antes de que el
   * recorrido terminase, así que el fallo no se veía; con años de M5 (cientos
   * de miles de velas) sí. El modo WAL (activo por defecto, ver
   * `connection.ts`) permite que dos conexiones al mismo fichero lean y
   * escriban a la vez sin bloquearse, así que abrir una segunda conexión sólo
   * para escribir es la solución correcta, no un parche.
   */
  readonly writerDb?: SqliteDatabase;
  readonly instrument: Instrument;
  readonly registry: PluginRegistry;
  readonly timeframe?: Timeframe;
  readonly fromTs?: number;
  readonly toTs?: number;
  readonly costs?: SimulationCosts;
  /** Operaciones acumuladas antes de escribir en la base. */
  readonly batchSize?: number;
  readonly verbose?: boolean;
  readonly onProgress?: (progress: { barsProcessed: number; tradesClosed: number }) => void;
}

export interface RunSummary {
  readonly barsProcessed: number;
  readonly signalsGenerated: number;
  readonly tradesClosed: number;
  readonly tradesWritten: number;
  readonly entryRuleIds: readonly string[];
  readonly featureSetVersion: string;
  readonly firstTs: number | null;
  readonly lastTs: number | null;
  readonly elapsedMs: number;
}

export async function runResearch(options: RunOptions): Promise<RunSummary> {
  const started = Date.now();
  const timeframe = options.timeframe ?? "M1";
  const { db, instrument, registry } = options;
  const writerDb = options.writerDb ?? db;
  const batchSize = options.batchSize ?? 5000;
  const timeZone = instrument.sessionTimezone;

  const featurePlugins = registry.featurePlugins();
  const entryPlugins = registry.entryPlugins();
  const featureSetVersion = registry.featureSetVersion();

  // El registro de variables se sincroniza antes de generar nada: si el
  // proceso muere a medias, al menos el catálogo queda coherente.
  upsertVariables(writerDb, registry.variableDefinitions());

  // --- Reglas de entrada ---------------------------------------------------
  const entryRuleIds: string[] = [];
  for (const plugin of entryPlugins) {
    const manifest = plugin.manifest;
    const fingerprint = computeRuleFingerprint(manifest.id, manifest.version, plugin.config);
    const ruleId = `${manifest.id}__${fingerprint.slice(0, 8)}`;
    upsertEntryRule(writerDb, {
      id: ruleId,
      pluginId: manifest.id,
      name: manifest.name,
      description: manifest.description,
      config: plugin.config,
      fingerprint,
    });
    entryRuleIds.push(ruleId);
  }

  // --- Estado de mercado ---------------------------------------------------
  const warmup = Math.max(registry.maxWarmupBars(), 250);
  const capacity = warmup + 50;
  const timeframes = new Set<Timeframe>([timeframe, ...registry.requiredTimeframes()]);

  const buffers = new Map<Timeframe, SeriesBuffer>();
  const aggregators = new Map<Timeframe, TimeframeAggregator>();
  for (const tf of timeframes) {
    buffers.set(tf, new SeriesBuffer(tf, capacity));
    if (tf !== timeframe) aggregators.set(tf, new TimeframeAggregator(tf, timeZone));
  }

  const daily = new DailyAggregator(timeZone);
  const sources = { instrument, primaryTimeframe: timeframe, buffers, daily };
  const barMs = timeframeToMinutes(timeframe) * 60_000;

  const simulator = new TradeSimulator({
    instrument,
    ...(options.costs !== undefined ? { costs: options.costs } : {}),
  });

  // --- Inicialización de plugins ------------------------------------------
  for (const plugin of [...featurePlugins, ...entryPlugins]) {
    const instance = plugin.instance as { init?: (ctx: unknown) => void | Promise<void>; reset?: () => void };
    instance.reset?.();
    if (typeof instance.init === "function") {
      await instance.init({
        config: plugin.config,
        instrument,
        logger: createLogger(plugin.manifest.id, options.verbose ?? false),
      });
    }
  }

  // --- Recorrido -----------------------------------------------------------
  interface Pending {
    readonly signal: EntrySignal;
    readonly entryRuleId: string;
  }

  let pending: Pending[] = [];
  const featuresByPosition = new Map<string, FeatureVector>();
  const rows: TradeRow[] = [];

  let barsProcessed = 0;
  let signalsGenerated = 0;
  let tradesClosed = 0;
  let tradesWritten = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let lastBar: Bar | null = null;

  const flushRows = (): void => {
    if (rows.length === 0) return;
    tradesWritten += insertTrades(writerDb, rows);
    rows.length = 0;
  };

  const barQuery = {
    instrumentId: instrument.id,
    timeframe,
    ...(options.fromTs !== undefined ? { fromTs: options.fromTs } : {}),
    ...(options.toTs !== undefined ? { toTs: options.toTs } : {}),
  };

  for (const bar of iterateBars(db, barQuery)) {
    barsProcessed++;
    if (firstTs === null) firstTs = bar.ts;
    lastTs = bar.ts;
    lastBar = bar;

    // 1 + 2. Abrir pendientes y calcular sus variables ANTES de que esta vela
    // entre en los buffers.
    if (pending.length > 0) {
      const view = createMarketView(sources, bar.ts);
      for (const item of pending) {
        const position = simulator.openPosition(item.signal, bar, item.entryRuleId);
        featuresByPosition.set(
          position.id,
          computeFeatures(featurePlugins, view, {
            id: position.id,
            direction: position.direction,
            entryTs: position.entryTs,
            entryPrice: position.entryPrice,
            takeProfitPrice: position.takeProfitPrice,
            stopLossPrice: position.stopLossPrice,
            entryRuleId: item.entryRuleId,
          }, options.verbose ?? false),
        );
      }
      pending = [];
    }

    // 3. Actualizar posiciones abiertas.
    for (const closed of simulator.onBar(bar)) {
      tradesClosed++;
      rows.push(toTradeRow(closed, instrument, featuresByPosition, featureSetVersion));
      featuresByPosition.delete(closed.position.id);
      if (rows.length >= batchSize) flushRows();
    }

    // 4. Cerrar la vela: buffers, agregados y estado incremental de plugins.
    daily.push(bar);
    (buffers.get(timeframe) as SeriesBuffer).push(bar);
    for (const [tf, aggregator] of aggregators) {
      const aggregated = aggregator.push(bar);
      if (aggregated !== null) (buffers.get(tf) as SeriesBuffer).push(aggregated);
    }

    const closeTs = bar.ts + barMs;
    const closeView = createMarketView(sources, closeTs);
    for (const plugin of featurePlugins) {
      const instance = plugin.instance as FeaturePlugin<never>;
      instance.onBar?.(bar, closeView);
    }

    // 5. Señales de entrada para la vela siguiente.
    if (barsProcessed > warmup) {
      for (let i = 0; i < entryPlugins.length; i++) {
        const plugin = entryPlugins[i] as (typeof entryPlugins)[number];
        const instance = plugin.instance as EntryPlugin<never>;
        if (!isEntryPlugin(instance)) continue;
        const signals = instance.onBarClose({
          config: plugin.config as never,
          market: closeView,
          logger: createLogger(plugin.manifest.id, options.verbose ?? false),
        });
        for (const signal of signals) {
          pending.push({ signal, entryRuleId: entryRuleIds[i] as string });
          signalsGenerated++;
        }
      }
    }

    if (barsProcessed % 50_000 === 0) options.onProgress?.({ barsProcessed, tradesClosed });
  }

  // Cierre de lo que quede abierto.
  if (lastBar !== null) {
    for (const closed of simulator.flush(lastBar)) {
      tradesClosed++;
      rows.push(toTradeRow(closed, instrument, featuresByPosition, featureSetVersion));
    }
  }
  flushRows();

  return {
    barsProcessed,
    signalsGenerated,
    tradesClosed,
    tradesWritten,
    entryRuleIds,
    featureSetVersion,
    firstTs,
    lastTs,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Ejecuta los plugins de variables en orden topológico.
 * Cada plugin ve las variables de los anteriores a través de `feature()`.
 */
function computeFeatures(
  plugins: readonly { manifest: { id: string }; instance: unknown; config: Record<string, unknown> }[],
  market: MarketView,
  trade: {
    id: string;
    direction: "long" | "short";
    entryTs: number;
    entryPrice: number;
    takeProfitPrice: number | null;
    stopLossPrice: number | null;
    entryRuleId: string;
  },
  verbose: boolean,
): FeatureVector {
  const computed: FeatureVector = {};
  const accessor = (key: string): number | null => computed[key] ?? null;

  for (const plugin of plugins) {
    const instance = plugin.instance as FeaturePlugin<never>;
    if (!isFeaturePlugin(instance)) continue;
    try {
      const result = instance.compute({
        config: plugin.config as never,
        market,
        trade,
        feature: accessor,
        logger: createLogger(plugin.manifest.id, verbose),
      });
      for (const [key, value] of Object.entries(result)) {
        computed[key] = Number.isFinite(value as number) ? (value as number) : null;
      }
    } catch (error) {
      // Un plugin que falla en una operación concreta no aborta la corrida:
      // se anotan sus variables como nulas y se sigue. El registro de nulos
      // deja rastro de que algo pasó.
      if (verbose) {
        console.warn(`[${plugin.manifest.id}] fallo al calcular variables:`, error);
      }
    }
  }

  return computed;
}

function toTradeRow(
  closed: ClosedTrade,
  instrument: Instrument,
  features: Map<string, FeatureVector>,
  featureSetVersion: string,
): TradeRow {
  const { position } = closed;
  const parts = calendarParts(position.entryTs, instrument.sessionTimezone);
  const vector = features.get(position.id) ?? {};

  return {
    id: position.id,
    instrumentId: instrument.id,
    entryRuleId: position.entryRuleId,
    importBatchId: null,
    source: "simulated",
    direction: position.direction,
    entryTs: position.entryTs,
    exitTs: closed.exitTs,
    entryPrice: position.entryPrice,
    exitPrice: closed.exitPrice,
    takeProfitPrice: position.takeProfitPrice,
    stopLossPrice: position.stopLossPrice,
    pnlPoints: closed.pnlPoints,
    pnlMoney: closed.pnlMoney,
    volumeLots: position.volumeLots,
    exitReason: closed.exitReason,
    durationMinutes: closed.durationMinutes,
    mae: closed.excursion.mae,
    mfe: closed.excursion.mfe,
    minutesToMae: closed.excursion.minutesToMae,
    minutesToMfe: closed.excursion.minutesToMfe,
    maxSpeedPointsPerMin: closed.excursion.maxSpeedPointsPerMin,
    slopePointsPerMin: closed.excursion.slopePointsPerMin,
    pullbackCount: closed.excursion.pullbackCount,
    efficiency: closed.excursion.efficiency,
    sessionDate: parts.sessionDate,
    year: parts.year,
    month: parts.month,
    dayOfMonth: parts.dayOfMonth,
    dayOfWeek: parts.dayOfWeek,
    hour: parts.hour,
    minute: parts.minute,
    minuteOfDay: parts.minuteOfDay,
    features: JSON.stringify(vector),
    featureSetVersion,
  };
}
