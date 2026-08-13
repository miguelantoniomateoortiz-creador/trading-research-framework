import { computePnlPoints, directionSign, type Bar, type Direction, type ExitReason, type Instrument } from "@trf/shared";
import type { EntrySignal } from "@trf/plugin-sdk";

/**
 * SIMULADOR DE OPERACIONES.
 *
 * Convierte una señal de entrada en una operación cerrada recorriendo las velas
 * siguientes UNA SOLA VEZ, hacia adelante. Mientras la operación está abierta va
 * midiendo el recorrido (MAE, MFE, velocidad, retrocesos).
 *
 * TRES REGLAS QUE HACEN HONESTO EL RESULTADO
 *
 * 1. Entrada en la APERTURA de la vela siguiente a la señal. La señal se emite
 *    al cerrar una vela; entrar a ese mismo cierre sería usar un precio que en
 *    tiempo real no habrías podido tocar.
 *
 * 2. Ambigüedad intrabar resuelta EN CONTRA. Si en una misma vela el recorrido
 *    toca tanto el take profit como el stop loss, no sabemos en qué orden pasó
 *    (una vela M1 no guarda el camino). Se asume que saltó el STOP. Es la
 *    hipótesis pesimista, y es la correcta: la alternativa infla los resultados
 *    justo en las velas volátiles, que son las que más importan.
 *
 * 3. Costes explícitos. Spread y comisión se restan siempre. Un backtest sin
 *    costes de un sistema intradía no es optimista, es falso.
 */

export interface SimulationCosts {
  /** Spread en puntos aplicado a la entrada (media ida y vuelta). */
  readonly spreadPoints: number;
  /** Deslizamiento adicional en puntos, por operación. */
  readonly slippagePoints: number;
  /** Comisión en dinero, por operación (ida y vuelta). */
  readonly commissionMoney: number;
}

export const DEFAULT_COSTS: SimulationCosts = {
  spreadPoints: 1,
  slippagePoints: 0.5,
  commissionMoney: 0,
};

export interface OpenPosition {
  readonly id: string;
  /** Regla de entrada que la generó. Se propaga a la operación cerrada. */
  readonly entryRuleId: string;
  readonly direction: Direction;
  readonly entryTs: number;
  readonly entryPrice: number;
  readonly takeProfitPrice: number | null;
  readonly stopLossPrice: number | null;
  readonly maxHoldMinutes: number;
  readonly tag: string;
  readonly volumeLots: number;
}

export interface ExcursionState {
  mae: number;
  mfe: number;
  minutesToMae: number;
  minutesToMfe: number;
  maxSpeedPointsPerMin: number;
  pullbackCount: number;
  /** Máximo favorable alcanzado desde el último retroceso contabilizado. */
  lastPeak: number;
  barsHeld: number;
  sumX: number;
  sumY: number;
  sumXY: number;
  sumXX: number;
}

export interface ClosedTrade {
  readonly position: OpenPosition;
  readonly exitTs: number;
  readonly exitPrice: number;
  readonly exitReason: ExitReason;
  readonly pnlPoints: number;
  readonly pnlMoney: number;
  readonly durationMinutes: number;
  readonly excursion: {
    readonly mae: number;
    readonly mfe: number;
    readonly minutesToMae: number;
    readonly minutesToMfe: number;
    readonly maxSpeedPointsPerMin: number;
    readonly slopePointsPerMin: number;
    readonly pullbackCount: number;
    readonly efficiency: number;
  };
}

export interface SimulatorOptions {
  readonly instrument: Instrument;
  readonly costs?: SimulationCosts;
  /**
   * Un retroceso cuenta cuando el precio devuelve esta fracción del máximo
   * favorable alcanzado. 0.35 evita contar el ruido de cada vela.
   */
  readonly pullbackThreshold?: number;
}

/**
 * Gestiona las posiciones abiertas y las cierra conforme llegan velas.
 * Se usa dentro de un único recorrido cronológico del histórico.
 */
export class TradeSimulator {
  private readonly instrument: Instrument;
  private readonly costs: SimulationCosts;
  private readonly pullbackThreshold: number;
  private readonly open = new Map<string, { position: OpenPosition; excursion: ExcursionState }>();
  private sequence = 0;

  constructor(options: SimulatorOptions) {
    this.instrument = options.instrument;
    this.costs = options.costs ?? DEFAULT_COSTS;
    this.pullbackThreshold = options.pullbackThreshold ?? 0.35;
  }

  get openCount(): number {
    return this.open.size;
  }

  /**
   * Abre una posición en la apertura de `bar`.
   * El spread y el deslizamiento empeoran el precio de entrada, nunca lo mejoran.
   */
  openPosition(signal: EntrySignal, bar: Bar, entryRuleId: string): OpenPosition {
    const sign = directionSign(signal.direction);
    const cost = this.costs.spreadPoints / 2 + this.costs.slippagePoints;
    const entryPrice = bar.open + sign * cost;

    const position: OpenPosition = {
      id: `${entryRuleId}_${bar.ts}_${signal.direction}_${this.sequence++}`,
      entryRuleId,
      direction: signal.direction,
      entryTs: bar.ts,
      entryPrice,
      takeProfitPrice: signal.takeProfitPoints === null ? null : entryPrice + sign * signal.takeProfitPoints,
      stopLossPrice: signal.stopLossPoints === null ? null : entryPrice - sign * signal.stopLossPoints,
      maxHoldMinutes: signal.maxHoldMinutes,
      tag: signal.tag ?? "",
      volumeLots: 1,
    };

    this.open.set(position.id, { position, excursion: freshExcursion() });
    return position;
  }

  /**
   * Procesa una vela: actualiza el recorrido de todas las posiciones abiertas y
   * cierra las que toquen TP, SL o límite de tiempo.
   */
  onBar(bar: Bar): ClosedTrade[] {
    const closed: ClosedTrade[] = [];

    for (const [id, entry] of this.open) {
      const { position, excursion } = entry;
      const sign = directionSign(position.direction);
      const minutesElapsed = (bar.ts - position.entryTs) / 60_000;

      // Excursión: el mejor y el peor precio TOCADOS dentro de la vela.
      const favourableExtreme = sign > 0 ? bar.high : bar.low;
      const adverseExtreme = sign > 0 ? bar.low : bar.high;
      const favourable = (favourableExtreme - position.entryPrice) * sign;
      const adverse = (position.entryPrice - adverseExtreme) * sign;

      if (favourable > excursion.mfe) {
        excursion.mfe = favourable;
        excursion.minutesToMfe = minutesElapsed;
        const speed = minutesElapsed > 0 ? favourable / minutesElapsed : favourable;
        if (speed > excursion.maxSpeedPointsPerMin) excursion.maxSpeedPointsPerMin = speed;
      }
      if (adverse > excursion.mae) {
        excursion.mae = adverse;
        excursion.minutesToMae = minutesElapsed;
      }

      // Retrocesos: cuenta cuando se devuelve una fracción del máximo favorable.
      if (favourable > excursion.lastPeak) {
        excursion.lastPeak = favourable;
      } else if (
        excursion.lastPeak > 0 &&
        (excursion.lastPeak - (bar.close - position.entryPrice) * sign) / excursion.lastPeak > this.pullbackThreshold
      ) {
        excursion.pullbackCount++;
        excursion.lastPeak = Math.max(0, (bar.close - position.entryPrice) * sign);
      }

      // Regresión incremental del P&L flotante para la pendiente.
      const y = (bar.close - position.entryPrice) * sign;
      excursion.barsHeld++;
      const x = excursion.barsHeld;
      excursion.sumX += x;
      excursion.sumY += y;
      excursion.sumXY += x * y;
      excursion.sumXX += x * x;

      // --- Cierre --------------------------------------------------------
      const hitStop =
        position.stopLossPrice !== null &&
        (sign > 0 ? bar.low <= position.stopLossPrice : bar.high >= position.stopLossPrice);
      const hitTarget =
        position.takeProfitPrice !== null &&
        (sign > 0 ? bar.high >= position.takeProfitPrice : bar.low <= position.takeProfitPrice);

      let exitPrice: number | null = null;
      let exitReason: ExitReason = "unknown";

      if (hitStop) {
        // Prioridad al stop: hipótesis pesimista ante ambigüedad intrabar.
        exitPrice = position.stopLossPrice as number;
        exitReason = "stop_loss";
      } else if (hitTarget) {
        exitPrice = position.takeProfitPrice as number;
        exitReason = "take_profit";
      } else if (minutesElapsed >= position.maxHoldMinutes) {
        exitPrice = bar.close;
        exitReason = "time_limit";
      }

      if (exitPrice !== null) {
        closed.push(this.close(position, excursion, bar.ts, exitPrice, exitReason));
        this.open.delete(id);
      }
    }

    return closed;
  }

  /** Cierra todo lo que quede abierto (fin del histórico). */
  flush(lastBar: Bar): ClosedTrade[] {
    const closed: ClosedTrade[] = [];
    for (const [id, entry] of this.open) {
      closed.push(this.close(entry.position, entry.excursion, lastBar.ts, lastBar.close, "session_end"));
      this.open.delete(id);
    }
    return closed;
  }

  private close(
    position: OpenPosition,
    excursion: ExcursionState,
    exitTs: number,
    exitPrice: number,
    exitReason: ExitReason,
  ): ClosedTrade {
    const pnlPoints = computePnlPoints(position.direction, position.entryPrice, exitPrice);
    const pnlMoney = pnlPoints * this.instrument.pointValue * position.volumeLots - this.costs.commissionMoney;
    const durationMinutes = (exitTs - position.entryTs) / 60_000;

    const n = excursion.barsHeld;
    const denominator = n * excursion.sumXX - excursion.sumX * excursion.sumX;
    const slope = n > 1 && denominator !== 0 ? (n * excursion.sumXY - excursion.sumX * excursion.sumY) / denominator : 0;

    return {
      position,
      exitTs,
      exitPrice,
      exitReason,
      pnlPoints,
      pnlMoney,
      durationMinutes,
      excursion: {
        mae: excursion.mae,
        mfe: excursion.mfe,
        minutesToMae: excursion.minutesToMae,
        minutesToMfe: excursion.minutesToMfe,
        maxSpeedPointsPerMin: excursion.maxSpeedPointsPerMin,
        slopePointsPerMin: slope,
        pullbackCount: excursion.pullbackCount,
        // Eficiencia: qué parte del movimiento favorable disponible se capturó.
        efficiency: excursion.mfe > 0 ? pnlPoints / excursion.mfe : 0,
      },
    };
  }
}

function freshExcursion(): ExcursionState {
  return {
    mae: 0,
    mfe: 0,
    minutesToMae: 0,
    minutesToMfe: 0,
    maxSpeedPointsPerMin: 0,
    pullbackCount: 0,
    lastPeak: 0,
    barsHeld: 0,
    sumX: 0,
    sumY: 0,
    sumXY: 0,
    sumXX: 0,
  };
}
