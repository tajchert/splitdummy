import { afterEach, describe, expect, it, vi } from "vitest";

// The formatters are built at import time, so each case sets the zone and imports a fresh copy.
async function loadIn(zone: string) {
  vi.stubEnv("TZ", zone);
  vi.resetModules();
  return import("./format");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const zones = ["Pacific/Kiritimati", "Pacific/Auckland", "Europe/Warsaw", "America/Los_Angeles", "Pacific/Pago_Pago"];

describe.each(zones)("date-only values in %s", (zone) => {
  it("fmtDay keeps the calendar day", async () => {
    const { fmtDay } = await loadIn(zone);
    const out = fmtDay("2026-09-13");
    expect(out).toMatch(/\b13\b/);
    expect(out).toMatch(/\b2026\b/);
    expect(out).not.toMatch(/\b(12|14)\b/);
  });

  it("fmtDay short keeps the calendar day", async () => {
    const { fmtDay } = await loadIn(zone);
    expect(fmtDay("2026-09-13", true)).toMatch(/\b13\b/);
  });

  it("fmtWeekday keeps the calendar day and weekday", async () => {
    const { fmtWeekday } = await loadIn(zone);
    const out = fmtWeekday("2026-09-13");
    expect(out).toMatch(/\bSun\b/);
    expect(out).toMatch(/\b13\b/);
  });

  it("fmtDay does not roll into the next year", async () => {
    const { fmtDay } = await loadIn(zone);
    const out = fmtDay("2026-12-31");
    expect(out).toMatch(/\b31\b/);
    expect(out).toMatch(/\b2026\b/);
  });
});

describe("instants stay in the viewer's zone", () => {
  it("fmtDate rolls to the next day east of UTC", async () => {
    const { fmtDate } = await loadIn("Pacific/Kiritimati");
    expect(fmtDate("2026-09-13T23:30:00Z")).toMatch(/\b14\b/);
  });

  it("fmtDate stays on the same day west of UTC", async () => {
    const { fmtDate } = await loadIn("America/Los_Angeles");
    expect(fmtDate("2026-09-13T23:30:00Z")).toMatch(/\b13\b/);
  });
});
