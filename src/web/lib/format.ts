import { formatMinor, getCurrency } from "@shared/money";

export const locale: string = (typeof navigator !== "undefined" && navigator.language) || "en-US";

/** The input locale's decimal mark; parseAmount/parseRate take it explicitly. */
export function decimalSeparator(loc = locale): "." | "," {
  const part = new Intl.NumberFormat(loc).formatToParts(1.5).find((p) => p.type === "decimal");
  return part?.value === "," ? "," : ".";
}

export function exponentOf(code: string): number {
  return getCurrency(code)?.exponent ?? 2;
}

const MINUS = "−";

/** "1,124.55" — no code. `signed` adds "+" for positives; negatives always use a true minus. */
export function fmtNumber(minor: string | bigint, exponent: number, signed = false): string {
  const v = typeof minor === "bigint" ? minor : BigInt(minor);
  const abs = formatMinor(v < 0n ? -v : v, exponent, locale);
  if (v < 0n) return MINUS + abs;
  if (signed && v > 0n) return "+" + abs;
  return abs;
}

/** "1,124.55 EUR" as plain text (for aria-labels, toasts, sentences). */
export function fmtMoney(minor: string | bigint, code: string, exponent = exponentOf(code), signed = false): string {
  return `${fmtNumber(minor, exponent, signed)} ${code}`;
}

/** Plain input-style rendering of a minor amount using the locale decimal mark, no grouping: "120.00". */
export function minorToInput(minor: string | bigint, exponent: number): string {
  const v = typeof minor === "bigint" ? minor : BigInt(minor);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(exponent + 1, "0");
  const int = exponent ? s.slice(0, -exponent) : s;
  const frac = exponent ? s.slice(-exponent) : "";
  return (neg ? "-" : "") + int + (frac ? decimalSeparator() + frac : "");
}

/** Rates are stored with "."; show them with the locale decimal mark. */
export function fmtRate(rate: string): string {
  return decimalSeparator() === "," ? rate.replace(".", ",") : rate;
}

const dateFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
const shortDateFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
const dateTimeFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const shortDateTimeFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** "YYYY-MM-DD" occurredAt → "13 Sep 2026" (calendar date, no timezone shift). */
export function fmtDay(ymd: string, short = false): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12));
  return (short ? shortDateFmt : dateFmt).format(dt);
}

export function fmtDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}
export function fmtShortDate(iso: string): string {
  return shortDateFmt.format(new Date(iso));
}
export function fmtDateTime(iso: string, short = false): string {
  return (short ? shortDateTimeFmt : dateTimeFmt).format(new Date(iso));
}

export function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let names: Intl.DisplayNames | null = null;
/** Localized currency name, falling back to the English name from CURRENCIES. */
export function currencyName(code: string): string {
  try {
    names ??= new Intl.DisplayNames([locale], { type: "currency" });
    const n = names.of(code);
    if (n && n !== code) return n;
  } catch {
    /* older engines */
  }
  return getCurrency(code)?.name ?? code;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
