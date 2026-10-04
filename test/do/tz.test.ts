import { describe, expect, it } from "vitest";
import { canonicalTimeZone, isCalendarDate, localDate, nextDate, startOfDay } from "../../worker/do/tz";

const iso = (date: string, zone: string) => new Date(startOfDay(date, zone)).toISOString();

describe("time-zone day arithmetic", () => {
  it("finds local midnight across DST changes", () => {
    // Warsaw springs forward on 2027-03-28 and falls back on 2027-10-31.
    expect(iso("2027-03-28", "Europe/Warsaw")).toBe("2027-03-27T23:00:00.000Z");
    expect(iso("2027-03-29", "Europe/Warsaw")).toBe("2027-03-28T22:00:00.000Z");
    expect(iso("2027-10-31", "Europe/Warsaw")).toBe("2027-10-30T22:00:00.000Z");
    expect(iso("2027-11-01", "Europe/Warsaw")).toBe("2027-10-31T23:00:00.000Z");
    expect(iso("2027-03-14", "America/New_York")).toBe("2027-03-14T05:00:00.000Z");
    expect(iso("2027-03-15", "America/New_York")).toBe("2027-03-15T04:00:00.000Z");
    expect(iso("2027-01-01", "Asia/Kolkata")).toBe("2026-12-31T18:30:00.000Z");
    expect(iso("2027-01-01", "Pacific/Kiritimati")).toBe("2026-12-31T10:00:00.000Z");
    expect(iso("2027-01-01", "UTC")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("starts the day at the transition when a DST gap swallows midnight", () => {
    // Havana jumps 00:00 → 01:00; Santiago's spring change is also at midnight.
    expect(iso("2026-03-08", "America/Havana")).toBe("2026-03-08T05:00:00.000Z");
    expect(iso("2026-09-06", "America/Santiago")).toBe("2026-09-06T04:00:00.000Z");
    // Santiago falls back at midnight (00:00 → 23:00 the day before): the day starts at the later 00:00.
    expect(iso("2026-04-05", "America/Santiago")).toBe("2026-04-05T04:00:00.000Z");
    for (const [d, z] of [["2026-03-08", "America/Havana"], ["2026-09-06", "America/Santiago"]] as const) {
      const t = startOfDay(d, z);
      expect(localDate(t, z)).toBe(d);
      expect(localDate(t - 1000, z)).not.toBe(d);
    }
  });

  it("validates dates and zones", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    expect(isCalendarDate("2027-13-01")).toBe(false);
    expect(nextDate("2026-12-31")).toBe("2027-01-01");
    expect(nextDate("2028-02-28")).toBe("2028-02-29");
    expect(canonicalTimeZone("europe/warsaw")).toBe("Europe/Warsaw");
    expect(canonicalTimeZone("Mars/Olympus_Mons")).toBeNull();
  });
});
