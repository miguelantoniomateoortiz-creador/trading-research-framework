import { describe, expect, it } from "vitest";
import { calendarParts, parseIsoDateUtc, sessionDateTimeToUtc, sessionOf, startOfSessionDay, timezoneOffsetMs } from "./calendar.js";

const NY = "America/New_York";

describe("timezoneOffsetMs", () => {
  it("aplica EST en invierno (UTC-5)", () => {
    const ts = Date.UTC(2024, 0, 15, 12, 0, 0);
    expect(timezoneOffsetMs(ts, NY)).toBe(-5 * 3_600_000);
  });

  it("aplica EDT en verano (UTC-4)", () => {
    const ts = Date.UTC(2024, 6, 15, 12, 0, 0);
    expect(timezoneOffsetMs(ts, NY)).toBe(-4 * 3_600_000);
  });

  it("cambia de offset exactamente en el salto de DST de 2024", () => {
    // 10 de marzo de 2024, 07:00 UTC = 02:00 EST -> pasa a 03:00 EDT
    const before = Date.UTC(2024, 2, 10, 6, 30, 0);
    const after = Date.UTC(2024, 2, 10, 7, 30, 0);
    expect(timezoneOffsetMs(before, NY)).toBe(-5 * 3_600_000);
    expect(timezoneOffsetMs(after, NY)).toBe(-4 * 3_600_000);
  });
});

describe("calendarParts", () => {
  it("deriva la apertura del NAS100 en hora de Nueva York", () => {
    // 09:30 ET en verano = 13:30 UTC
    const parts = calendarParts(Date.UTC(2024, 6, 15, 13, 30, 0), NY);
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(30);
    expect(parts.minuteOfDay).toBe(570);
    expect(parts.sessionDate).toBe("2024-07-15");
    expect(parts.dayOfWeek).toBe(1); // lunes
  });

  it("deriva la apertura correctamente en invierno (14:30 UTC)", () => {
    const parts = calendarParts(Date.UTC(2024, 0, 16, 14, 30, 0), NY);
    expect(parts.minuteOfDay).toBe(570);
    expect(parts.sessionDate).toBe("2024-01-16");
  });

  it("asigna el día de mercado correcto a una vela nocturna", () => {
    // 02:00 UTC del día 16 = 21:00 ET del día 15
    const parts = calendarParts(Date.UTC(2024, 6, 16, 2, 0, 0), NY);
    expect(parts.sessionDate).toBe("2024-07-15");
    expect(parts.hour).toBe(22);
  });

  it("usa numeración ISO para el día de la semana", () => {
    // 2024-07-14 es domingo
    expect(calendarParts(Date.UTC(2024, 6, 14, 16, 0, 0), NY).dayOfWeek).toBe(7);
  });
});

describe("conversiones", () => {
  it("startOfSessionDay devuelve la medianoche local", () => {
    const ts = Date.UTC(2024, 6, 15, 13, 30, 0);
    const start = startOfSessionDay(ts, NY);
    expect(calendarParts(start, NY).minuteOfDay).toBe(0);
    expect(calendarParts(start, NY).sessionDate).toBe("2024-07-15");
  });

  it("sessionDateTimeToUtc es inversa de calendarParts", () => {
    for (const date of ["2024-01-16", "2024-07-15", "2024-03-10", "2024-11-03"]) {
      const ts = sessionDateTimeToUtc(date, 570, NY);
      const parts = calendarParts(ts, NY);
      expect(parts.sessionDate).toBe(date);
      expect(parts.minuteOfDay).toBe(570);
    }
  });

  it("parseIsoDateUtc rechaza basura", () => {
    expect(() => parseIsoDateUtc("no-es-fecha")).toThrow();
  });
});

describe("sessionOf", () => {
  it("clasifica los minutos del día en sesiones US", () => {
    expect(sessionOf(300)).toBe("premarket");
    expect(sessionOf(570)).toBe("openingHour");
    expect(sessionOf(700)).toBe("lunch");
    expect(sessionOf(930)).toBe("powerHour");
    // 10:45 ET cae dentro de la sesión regular pero fuera de las ventanas
    // específicas, así que se etiqueta como "regular".
    expect(sessionOf(645)).toBe("regular");
    expect(sessionOf(60)).toBeNull();
  });
});
