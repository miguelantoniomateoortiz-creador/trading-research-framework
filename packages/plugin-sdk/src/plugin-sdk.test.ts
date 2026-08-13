import { describe, expect, it } from "vitest";
import type { Bar, VariableDefinition } from "@trf/shared";
import { Atr, Ema, RollingExtremes, SessionVwap, Sma, StreakCounter, trueRange } from "./indicators.js";
import { DailyAggregator, SeriesBuffer, createMarketView } from "./market-view.js";
import { PluginRegistry, stableStringify, type LoadedPlugin } from "./registry.js";
import { parseManifest, type PluginManifest } from "./manifest.js";
import { defineFeaturePlugin } from "./types.js";

const bar = (o: number, h: number, l: number, c: number, ts = 0, vol = 100): Bar => ({
  ts,
  open: o,
  high: h,
  low: l,
  close: c,
  tickVolume: vol,
  volume: 0,
  spread: 1,
});

describe("indicadores", () => {
  it("la EMA se siembra con una SMA y no devuelve valores de calentamiento", () => {
    const ema = new Ema(3);
    expect(ema.ready).toBe(false);
    ema.update(10);
    ema.update(20);
    expect(Number.isNaN(ema.value)).toBe(true);
    ema.update(30);
    expect(ema.ready).toBe(true);
    expect(ema.value).toBeCloseTo(20, 10);
    // alpha = 2/4 = 0.5
    ema.update(40);
    expect(ema.value).toBeCloseTo(30, 10);
  });

  it("la SMA usa ventana deslizante", () => {
    const sma = new Sma(3);
    [1, 2, 3, 4, 5].forEach((x) => sma.update(x));
    expect(sma.value).toBeCloseTo(4, 10);
  });

  it("trueRange considera los huecos respecto al cierre anterior", () => {
    expect(trueRange(bar(10, 12, 9, 11), null)).toBe(3);
    // Gap alcista: el cierre anterior (5) queda por debajo del mínimo.
    expect(trueRange(bar(10, 12, 9, 11), 5)).toBe(7);
  });

  it("el ATR usa suavizado de Wilder, no EMA estándar", () => {
    const atr = new Atr(2);
    atr.update(bar(10, 12, 8, 10)); // TR = 4
    expect(atr.ready).toBe(false);
    atr.update(bar(10, 12, 8, 10)); // TR = 4 -> seed = 4
    expect(atr.value).toBeCloseTo(4, 10);
    atr.update(bar(10, 20, 10, 20)); // TR = max(10, 10, 0) = 10
    // Wilder con period=2: (4*1 + 10)/2 = 7. Una EMA(2) daría 8.
    expect(atr.value).toBeCloseTo(7, 10);
  });

  it("RollingExtremes reporta máximo, mínimo y rango de la ventana", () => {
    const ext = new RollingExtremes(3);
    ext.update(10, 5);
    ext.update(12, 7);
    ext.update(11, 6);
    expect(ext.highest).toBe(12);
    expect(ext.lowest).toBe(5);
    ext.update(9, 8); // expulsa la primera
    expect(ext.highest).toBe(12);
    expect(ext.lowest).toBe(6);
    expect(ext.range).toBe(6);
  });

  it("el VWAP se reinicia al cambiar de sesión", () => {
    const vwap = new SessionVwap();
    vwap.update(bar(10, 10, 10, 10, 0, 100), "2024-01-02");
    expect(vwap.value).toBeCloseTo(10, 10);
    vwap.update(bar(20, 20, 20, 20, 0, 100), "2024-01-02");
    expect(vwap.value).toBeCloseTo(15, 10);
    vwap.update(bar(30, 30, 30, 30, 0, 100), "2024-01-03");
    expect(vwap.value).toBeCloseTo(30, 10);
  });

  it("StreakCounter cuenta rachas y las rompe con velas doji", () => {
    const streak = new StreakCounter();
    streak.update(bar(10, 11, 9, 11));
    streak.update(bar(11, 12, 10, 12));
    expect(streak.consecutiveBullish).toBe(2);
    streak.update(bar(12, 12, 11, 11));
    expect(streak.consecutiveBullish).toBe(0);
    expect(streak.consecutiveBearish).toBe(1);
    streak.update(bar(11, 12, 10, 11));
    expect(streak.consecutiveBearish).toBe(0);
  });
});

describe("SeriesBuffer", () => {
  it("mantiene memoria constante y devuelve las últimas N velas", () => {
    const buffer = new SeriesBuffer("M1", 3);
    for (let i = 0; i < 10; i++) buffer.push(bar(i, i, i, i, i * 60_000));
    expect(buffer.length).toBe(3);
    expect(buffer.at(0)?.close).toBe(9);
    expect(buffer.at(2)?.close).toBe(7);
    expect(buffer.at(3)).toBeNull();
    expect(buffer.last(3).map((b) => b.close)).toEqual([7, 8, 9]);
    expect(Array.from(buffer.closes(2))).toEqual([8, 9]);
  });
});

describe("DailyAggregator", () => {
  it("acumula el día en curso y conserva el anterior", () => {
    const agg = new DailyAggregator("America/New_York");
    // 2024-07-15 09:30 ET = 13:30 UTC
    agg.push(bar(100, 110, 95, 105, Date.UTC(2024, 6, 15, 13, 30)));
    agg.push(bar(105, 120, 100, 118, Date.UTC(2024, 6, 15, 13, 31)));
    expect(agg.getToday()).toMatchObject({ sessionDate: "2024-07-15", open: 100, high: 120, low: 95, close: 118 });
    expect(agg.getPrevious()).toBeNull();

    agg.push(bar(200, 205, 195, 202, Date.UTC(2024, 6, 16, 13, 30)));
    expect(agg.getToday()?.sessionDate).toBe("2024-07-16");
    expect(agg.getPrevious()?.high).toBe(120);
  });
});

describe("MarketView", () => {
  const instrument = {
    id: "nas100",
    symbol: "NAS100",
    description: "",
    sessionTimezone: "America/New_York",
    tickSize: 0.1,
    pointValue: 1,
    regularSessionOpenMinute: 570,
    regularSessionCloseMinute: 960,
  };

  it("expone sólo velas cerradas y lanza si detecta una del futuro", () => {
    const buffer = new SeriesBuffer("M1", 10);
    const daily = new DailyAggregator(instrument.sessionTimezone);
    const openTs = Date.UTC(2024, 6, 15, 13, 30);
    buffer.push(bar(100, 101, 99, 100, openTs));
    daily.push(bar(100, 101, 99, 100, openTs));

    const sources = { instrument, primaryTimeframe: "M1" as const, buffers: new Map([["M1" as const, buffer]]), daily };

    // La vela abre a 13:30 y cierra a 13:31: es visible desde 13:31.
    const view = createMarketView(sources, openTs + 60_000);
    expect(view.price()).toBe(100);
    expect(view.dailyOpen()).toBe(100);
    expect(view.calendar.minuteOfDay).toBe(571);

    // A las 13:30:30 esa vela AÚN NO ha cerrado -> lookahead.
    expect(() => createMarketView(sources, openTs + 30_000)).toThrow(/no ha cerrado/);
  });

  it("rechaza timeframes no declarados", () => {
    const buffer = new SeriesBuffer("M1", 4);
    const sources = {
      instrument,
      primaryTimeframe: "M1" as const,
      buffers: new Map([["M1" as const, buffer]]),
      daily: new DailyAggregator(instrument.sessionTimezone),
    };
    const view = createMarketView(sources, Date.UTC(2024, 6, 15, 13, 31));
    expect(() => view.series("H1")).toThrow(/no declaró/);
  });
});

// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<PluginManifest> & { id: string }): PluginManifest {
  return parseManifest(
    {
      name: overrides.id,
      version: "1.0.0",
      apiVersion: 1,
      kind: ["feature"],
      ...overrides,
    },
    "test",
  );
}

function makePlugin(
  id: string,
  provides: string[],
  requires: string[] = [],
): LoadedPlugin {
  const definitions: VariableDefinition[] = provides.map((key) => ({
    key,
    label: key,
    description: "",
    valueType: "continuous",
    causality: "predictor",
    unit: "",
    producedBy: id,
    producerVersion: "1.0.0",
  }));

  return {
    manifest: makeManifest({
      id,
      provides,
      requires: { timeframes: ["M1"], features: requires, warmupBars: 10 },
    }),
    directory: `/tmp/${id}`,
    instance: defineFeaturePlugin({
      manifest: makeManifest({ id }),
      provides: definitions,
      compute: () => Object.fromEntries(provides.map((k) => [k, 1])),
    }) as never,
    config: {},
    enabled: true,
  };
}

describe("PluginRegistry", () => {
  it("ordena los plugins según sus dependencias de variables", () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin("z-consumer", ["z.out"], ["a.atr"]));
    registry.register(makePlugin("a-producer", ["a.atr"]));

    expect(registry.resolveOrder()).toEqual(["a-producer", "z-consumer"]);
  });

  it("el orden es determinista con dependencias empatadas", () => {
    const build = () => {
      const registry = new PluginRegistry();
      registry.register(makePlugin("m-one", ["m.a"]));
      registry.register(makePlugin("b-two", ["b.a"]));
      registry.register(makePlugin("x-three", ["x.a"]));
      return registry.resolveOrder();
    };
    expect(build()).toEqual(["b-two", "m-one", "x-three"]);
    expect(build()).toEqual(build());
  });

  it("detecta ciclos", () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin("uno", ["uno.a"], ["dos.b"]));
    registry.register(makePlugin("dos", ["dos.b"], ["uno.a"]));
    expect(() => registry.resolveOrder()).toThrow(/Ciclo/);
  });

  it("detecta dependencias inexistentes", () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin("solo", ["solo.a"], ["fantasma.x"]));
    expect(() => registry.resolveOrder()).toThrow(/no la produce ningún plugin/);
  });

  it("detecta dependencias sobre plugins desactivados", () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin("productor", ["p.a"]));
    registry.register(makePlugin("consumidor", ["c.a"], ["p.a"]));
    registry.setEnabled("productor", false);
    expect(() => registry.resolveOrder()).toThrow(/desactivado/);
  });

  it("rechaza dos plugins que producen la misma variable", () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin("uno", ["comun.key"]));
    expect(() => registry.register(makePlugin("dos", ["comun.key"]))).toThrow(/Colisión/);
  });

  it("rechaza claves sin namespace", () => {
    const registry = new PluginRegistry();
    expect(() => registry.register(makePlugin("malo", ["sinpunto"]))).toThrow(/inválida/);
  });

  it("quitar un plugin libera sus variables y no afecta al resto", () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin("uno", ["uno.a"]));
    registry.register(makePlugin("dos", ["dos.a"]));
    expect(registry.unregister("uno")).toBe(true);
    expect(registry.resolveOrder()).toEqual(["dos"]);
    // La clave queda libre para otro plugin.
    expect(() => registry.register(makePlugin("tres", ["uno.a"]))).not.toThrow();
  });

  it("la huella del conjunto de features cambia con la configuración", () => {
    const registry = new PluginRegistry();
    const plugin = makePlugin("uno", ["uno.a"]);
    registry.register(plugin);
    const before = registry.featureSetVersion();

    const other = new PluginRegistry();
    other.register({ ...makePlugin("uno", ["uno.a"]), config: { periodo: 20 } });
    expect(other.featureSetVersion()).not.toBe(before);
  });

  it("calcula el calentamiento máximo y los timeframes necesarios", () => {
    const registry = new PluginRegistry();
    registry.register(makePlugin("uno", ["uno.a"]));
    expect(registry.maxWarmupBars()).toBe(10);
    expect(registry.requiredTimeframes()).toEqual(["M1"]);
  });
});

describe("manifiesto", () => {
  it("rechaza versiones que no son semver", () => {
    expect(() => parseManifest({ id: "x", name: "X", version: "1.0", apiVersion: 1, kind: ["feature"] }, "t")).toThrow();
  });

  it("rechaza una apiVersion desconocida", () => {
    // El id debe tener al menos 2 caracteres para superar la validación de
    // formato ANTES de llegar a la comprobación de apiVersion.
    expect(() =>
      parseManifest({ id: "xx", name: "X", version: "1.0.0", apiVersion: 99, kind: ["feature"] }, "t"),
    ).toThrow(/apiVersion/);
  });

  it("stableStringify es independiente del orden de las claves", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
});
