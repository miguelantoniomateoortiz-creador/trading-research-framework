import { describe, expect, it } from "vitest";
import type { Bar } from "@trf/shared";
import { OpeningSessionTracker } from "./calculator.js";

const SESSION = "2024-07-15";
const OPEN_MINUTE = 570;

function bar(open: number, high: number, low: number, close: number): Bar {
  return { ts: 0, open, high, low, close, tickVolume: 100, volume: 0, spread: 1 };
}

/** Reproduce una sesión: impulso alcista de 15 min y luego reversión. */
function feed(tracker: OpeningSessionTracker, prices: readonly number[], startMinute = OPEN_MINUTE): void {
  let previous = prices[0] as number;
  prices.forEach((price, i) => {
    const high = Math.max(previous, price);
    const low = Math.min(previous, price);
    tracker.update(bar(previous, high, low, price), SESSION, startMinute + i);
    previous = price;
  });
}

describe("OpeningSessionTracker", () => {
  it("ignora el premercado al construir el rango de apertura", () => {
    const tracker = new OpeningSessionTracker(15, OPEN_MINUTE);
    // Vela de premercado con un extremo absurdo: no debe entrar en el rango.
    tracker.update(bar(100, 9999, 1, 100), SESSION, 500);
    expect(tracker.hasOpened).toBe(false);

    feed(tracker, [100, 101, 102]);
    expect(tracker.hasOpened).toBe(true);
    expect(tracker.openingRange?.high).toBe(102);
    expect(tracker.openingRange?.low).toBe(100);
  });

  it("cierra el rango tras N minutos y fija la dirección del impulso", () => {
    const tracker = new OpeningSessionTracker(15, OPEN_MINUTE);
    const subida = Array.from({ length: 15 }, (_, i) => 100 + i); // 100 -> 114
    feed(tracker, subida);

    expect(tracker.isRangeComplete).toBe(true);
    expect(tracker.impulseDirection).toBe(1);
    expect(tracker.impulseSize).toBeCloseTo(14, 10);
    expect(tracker.openingRange?.size).toBeCloseTo(14, 10);
    expect(tracker.minutesSinceOpen).toBe(14);
  });

  it("mide el recorrido a favor y en contra del impulso", () => {
    const tracker = new OpeningSessionTracker(15, OPEN_MINUTE);
    const subida = Array.from({ length: 15 }, (_, i) => 100 + i); // impulso alcista
    feed(tracker, subida);
    // Sigue subiendo a 120, luego cae a 95 (por debajo de la apertura, 100).
    feed(tracker, [114, 120, 110, 95], OPEN_MINUTE + 15);

    expect(tracker.excursionWithImpulse).toBeCloseTo(20, 10); // 120 - 100
    expect(tracker.excursionAgainstImpulse).toBeCloseTo(5, 10); // 100 - 95
    expect(tracker.pullbackFromExtreme).toBeCloseTo(25, 10); // 120 - 95
    expect(tracker.pullbackFraction).toBeCloseTo(25 / 20, 10);
  });

  it("detecta la ruptura del rango y cuándo ocurrió", () => {
    const tracker = new OpeningSessionTracker(15, OPEN_MINUTE);
    feed(tracker, Array.from({ length: 15 }, () => 100)); // rango plano en 100
    expect(tracker.breakout.side).toBe(0);

    feed(tracker, [100, 105], OPEN_MINUTE + 15);
    expect(tracker.breakout.side).toBe(1);
    expect(tracker.breakout.minutesSince).toBe(0);

    feed(tracker, [105, 106], OPEN_MINUTE + 17);
    expect(tracker.breakout.minutesSince).toBe(2);
  });

  it("registra la reversión sobre la apertura y su tiempo", () => {
    const tracker = new OpeningSessionTracker(15, OPEN_MINUTE);
    feed(tracker, Array.from({ length: 15 }, (_, i) => 100 + i)); // impulso alcista, apertura = 100
    expect(tracker.hasCrossedBackOpen).toBe(false);

    feed(tracker, [114, 112, 105, 99], OPEN_MINUTE + 15);
    expect(tracker.hasCrossedBackOpen).toBe(true);
    // La vela que toca 100 o menos es la del minuto 588 -> 18 minutos tras abrir.
    expect(tracker.minutesToOpenCross).toBe(18);
  });

  it("no marca reversión si el precio nunca vuelve a la apertura", () => {
    const tracker = new OpeningSessionTracker(15, OPEN_MINUTE);
    feed(tracker, Array.from({ length: 15 }, (_, i) => 100 + i));
    feed(tracker, [114, 118, 122, 130], OPEN_MINUTE + 15);
    expect(tracker.hasCrossedBackOpen).toBe(false);
    expect(tracker.minutesToOpenCross).toBeNull();
  });

  it("reinicia el estado al cambiar de sesión", () => {
    const tracker = new OpeningSessionTracker(15, OPEN_MINUTE);
    feed(tracker, Array.from({ length: 15 }, (_, i) => 100 + i));
    expect(tracker.isRangeComplete).toBe(true);

    tracker.update(bar(200, 201, 199, 200), "2024-07-16", OPEN_MINUTE);
    expect(tracker.isRangeComplete).toBe(false);
    expect(tracker.dailyOpen).toBe(200);
    expect(tracker.hasCrossedBackOpen).toBe(false);
  });
});
