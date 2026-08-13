"use client";

import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

/**
 * GRÁFICO DE VELAS con marcadores de entrada/salida.
 *
 * Envoltorio fino sobre lightweight-charts (librería imperativa, no un
 * componente React): se crea una vez con `useEffect` y se actualiza con
 * `setData`/`setMarkers` cuando cambian las props. Nada de análisis aquí —
 * sólo dibuja lo que ya viene calculado de la API.
 */

export interface ChartBar {
  readonly ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface ChartMarker {
  readonly ts: number;
  readonly position: "aboveBar" | "belowBar";
  readonly color: string;
  readonly shape: "arrowUp" | "arrowDown" | "circle";
  readonly text?: string;
}

function toUtcSeconds(ts: number): UTCTimestamp {
  return Math.floor(ts / 1000) as UTCTimestamp;
}

export function CandlestickChart({
  bars,
  markers = [],
  height = 420,
}: {
  bars: readonly ChartBar[];
  markers?: readonly ChartMarker[];
  height?: number;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  // Crear el gráfico UNA vez.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#a3abbb" },
      grid: { vertLines: { color: "#1c202b" }, horzLines: { color: "#1c202b" } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2a2f3d" },
      rightPriceScale: { borderColor: "#2a2f3d" },
      crosshair: { mode: CrosshairMode.Normal },
      width: container.clientWidth,
      height,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#4ade80",
      downColor: "#f87171",
      borderVisible: false,
      wickUpColor: "#4ade80",
      wickDownColor: "#f87171",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resize = (): void => chart.applyOptions({ width: container.clientWidth });
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // Actualizar velas.
  useEffect(() => {
    const series = seriesRef.current;
    if (series === null) return;
    series.setData(
      bars.map((b) => ({ time: toUtcSeconds(b.ts) as Time, open: b.open, high: b.high, low: b.low, close: b.close })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  // Actualizar marcadores.
  useEffect(() => {
    const series = seriesRef.current;
    if (series === null) return;
    const sorted: SeriesMarker<Time>[] = [...markers]
      .sort((a, b) => a.ts - b.ts)
      .map((m) => ({
        time: toUtcSeconds(m.ts) as Time,
        position: m.position,
        color: m.color,
        shape: m.shape,
        text: m.text,
      }));
    series.setMarkers(sorted);
  }, [markers]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
