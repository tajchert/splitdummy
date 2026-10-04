/**
 * Calendar-day arithmetic in IANA time zones using only Intl (no tz database of our own).
 * Dates are plain "YYYY-MM-DD" strings; instants are epoch milliseconds.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Canonical zone name (e.g. "europe/warsaw" → "Europe/Warsaw"), or null when Intl doesn't know it. */
export function canonicalTimeZone(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(instant: number, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour!,
    minute: out.minute!,
    second: out.second!,
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The calendar date ("YYYY-MM-DD") that `instant` falls on in `timeZone`. */
export function localDate(instant: number, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local wall-clock minus UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

function parseDate(date: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return [y, mo, d];
}

/** True for a real calendar date in "YYYY-MM-DD" form (rejects 2026-02-30). */
export const isCalendarDate = (date: string) => parseDate(date) !== null;

/** The following calendar date. */
export function nextDate(date: string): string {
  const parsed = parseDate(date);
  if (!parsed) throw new Error(`invalid date ${date}`);
  const t = new Date(Date.UTC(parsed[0], parsed[1] - 1, parsed[2] + 1));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * First instant of `date` in `timeZone`. Usually local 00:00; when a DST gap swallows midnight
 * (e.g. America/Havana, America/Santiago) the day starts at the transition instead.
 */
export function startOfDay(date: string, timeZone: string): number {
  const parsed = parseDate(date);
  if (!parsed) throw new Error(`invalid date ${date}`);
  const guess = Date.UTC(parsed[0], parsed[1] - 1, parsed[2]);
  const HOUR = 60 * 60 * 1000;
  // Every offset in effect around that local midnight (real offsets are within ±14h).
  const offsets = new Set([offsetAt(guess - 14 * HOUR, timeZone), offsetAt(guess, timeZone), offsetAt(guess + 14 * HOUR, timeZone)]);
  const candidates = [...offsets].map((o) => guess - o).filter((t) => localDate(t, timeZone) === date);
  if (candidates.length === 0) throw new Error(`no instant on ${date} in ${timeZone}`);
  const midnights = candidates.filter((t) => {
    const p = localParts(t, timeZone);
    return p.hour === 0 && p.minute === 0 && p.second === 0;
  });
  // Ambiguous midnight (clocks fall back across it): the earlier occurrence starts the day.
  if (midnights.length > 0) return Math.min(...midnights);

  // Midnight doesn't exist: find the transition, the earliest instant whose local date is `date`.
  let hi = Math.min(...candidates);
  let lo = hi - 3 * HOUR;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (localDate(mid, timeZone) >= date) hi = mid;
    else lo = mid;
  }
  return hi;
}
