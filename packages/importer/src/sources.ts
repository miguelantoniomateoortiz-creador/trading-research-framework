import { ConfigError, type Bar, type Timeframe } from "@trf/shared";
import { parseMt5Bars, type Mt5BarParseOptions } from "./mt5-bars.js";
import { generateNas100Bars, type SyntheticOptions } from "./synthetic.js";

/**
 * ABSTRACCIÓN DE FUENTE DE DATOS.
 *
 * Hoy los datos llegan por fichero exportado de MT5. Mañana pueden llegar por
 * una conexión directa (Expert Advisor + socket, un servicio HTTP local, o la
 * librería MetaTrader5 de Python). Todo el framework consume `MarketDataSource`,
 * así que añadir esa conexión no toca ni el importador, ni la base, ni el
 * analizador: sólo se implementa una clase más.
 *
 * Ésta es la razón de que el nivel 4 exista antes de tener el puente: el coste
 * de la abstracción hoy es una interfaz de tres métodos; el coste de añadirla
 * después, cuando media plataforma asume ficheros, es una refactorización.
 */

export interface BarRequest {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** Epoch ms inclusivo. */
  readonly fromTs?: number;
  /** Epoch ms exclusivo. */
  readonly toTs?: number;
}

export interface MarketDataSource {
  readonly id: string;
  readonly description: string;
  /** ¿Puede servir datos en vivo o sólo histórico? */
  readonly supportsStreaming: boolean;
  fetchBars(request: BarRequest): AsyncIterable<Bar>;
  close?(): Promise<void>;
}

/** Fuente actual: fichero CSV/TSV exportado desde el terminal. */
export class Mt5FileSource implements MarketDataSource {
  readonly id = "mt5-file";
  readonly description = "Fichero CSV/TSV exportado desde MetaTrader 5";
  readonly supportsStreaming = false;

  private readonly filePath: string;
  private readonly options: Mt5BarParseOptions;

  constructor(filePath: string, options: Mt5BarParseOptions) {
    this.filePath = filePath;
    this.options = options;
  }

  async *fetchBars(request: BarRequest): AsyncIterable<Bar> {
    const options: Mt5BarParseOptions = {
      ...this.options,
      ...(request.fromTs !== undefined ? { fromTs: request.fromTs } : {}),
      ...(request.toTs !== undefined ? { toTs: request.toTs } : {}),
    };
    for await (const row of parseMt5Bars(this.filePath, options)) yield row.bar;
  }
}

/** Fuente sintética: útil para tests, demos y calibración del motor. */
export class SyntheticSource implements MarketDataSource {
  readonly id = "synthetic";
  readonly description = "Generador determinista de velas NAS100";
  readonly supportsStreaming = false;

  private readonly options: SyntheticOptions;

  constructor(options: SyntheticOptions) {
    this.options = options;
  }

  async *fetchBars(request: BarRequest): AsyncIterable<Bar> {
    for (const bar of generateNas100Bars(this.options)) {
      if (request.fromTs !== undefined && bar.ts < request.fromTs) continue;
      if (request.toTs !== undefined && bar.ts >= request.toTs) continue;
      yield bar;
    }
  }
}

/**
 * HUECO RESERVADO: conexión directa con MT5.
 *
 * Plan previsto cuando toque implementarlo (nivel 9 del roadmap):
 *
 *   Opción A — Expert Advisor + socket local. Un EA en MQL5 publica velas y
 *   ticks por un socket TCP en localhost; esta clase se suscribe. Ventaja:
 *   tiempo real de verdad. Inconveniente: hay que mantener código MQL5.
 *
 *   Opción B — Servicio Python con la librería oficial `MetaTrader5`, expuesto
 *   por HTTP local. Ventaja: `copy_rates_range` da histórico completo en una
 *   llamada y no hay que escribir MQL5. Inconveniente: sólo Windows y el
 *   terminal debe estar abierto.
 *
 *   Opción C — Vigilar una carpeta donde un EA vuelca CSV periódicamente. Es
 *   la más simple y reutiliza `Mt5FileSource` tal cual.
 *
 * La recomendación es empezar por C (cero código nuevo, sólo un vigilante de
 * carpeta) y pasar a B cuando haga falta histórico bajo demanda.
 */
export class Mt5BridgeSource implements MarketDataSource {
  readonly id = "mt5-bridge";
  readonly description = "Conexión directa con MetaTrader 5 (pendiente de implementar)";
  readonly supportsStreaming = true;

  // eslint-disable-next-line @typescript-eslint/require-await
  async *fetchBars(): AsyncIterable<Bar> {
    throw new ConfigError(
      "La conexión directa con MT5 aún no está implementada. Usa Mt5FileSource con un CSV exportado; " +
        "ver packages/importer/src/sources.ts para el plan de implementación.",
      { source: "mt5-bridge" },
    );
  }
}
