/**
 * Internal exact-arithmetic and decimal-input helpers shared by amount.ts and
 * rate.ts. Public helpers are re-exported from rate.ts.
 */

export function assertExponent(exponent: number): void {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 18) {
    throw new RangeError(`invalid minor-unit exponent: ${exponent}`);
  }
}

/** 10^n as bigint (n: non-negative integer). */
export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`invalid power of ten: ${n}`);
  return 10n ** BigInt(n);
}

export function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * Exact integer division of n/d rounded half up. For negative quotients the
 * rounding is symmetric (half away from zero), i.e. divRoundHalfUp(-n, d) ===
 * -divRoundHalfUp(n, d), so sign never biases a result. d must be nonzero.
 */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n < 0n) return -((-n * 2n + d) / (2n * d));
  return (n * 2n + d) / (2n * d);
}

/** Render a non-negative scaled integer (value / 10^digits) as "123.45", trailing fraction zeros trimmed. */
export function scaledToTrimmedDecimal(scaled: bigint, digits: number): string {
  if (scaled < 0n) throw new RangeError("expected non-negative value");
  const s = scaled.toString().padStart(digits + 1, "0");
  const intPart = s.slice(0, s.length - digits);
  const frac = s.slice(s.length - digits).replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

export type DecimalSeparator = "." | ",";

export interface ParsedDecimal {
  negative: boolean;
  /** Digits only, never empty ("0" for ".5"). */
  intDigits: string;
  /** Digits only, possibly empty. */
  fracDigits: string;
}

export type DecimalParseError = "EMPTY" | "MALFORMED" | "AMBIGUOUS_SEPARATOR";

/**
 * Grouping characters accepted besides the opposite separator: space, NBSP,
 * narrow NBSP (fr), thin space, ASCII apostrophe (de-CH) and right single quote.
 */
const EXTRA_GROUP_CHARS = new Set([" ", " ", " ", " ", "'", "’"]);

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Interpret an unsigned body under one decimal separator. Returns null when the
 * body is not a valid number in that convention.
 *
 * Integer part: plain digits, or (if grouping allowed) groups separated by ONE
 * kind of grouping character in a strict Western (1,234,567) or Indian
 * (12,34,567) layout whose leading group does not start with 0.
 * Fraction part: one or more plain digits; no grouping. ".5" is accepted, "5." is not.
 */
function interpret(body: string, dec: DecimalSeparator, allowGrouping: boolean): { intDigits: string; fracDigits: string } | null {
  const parts = body.split(dec);
  if (parts.length > 2) return null;
  const intRaw = parts[0] ?? "";
  const fracRaw = parts[1];
  if (fracRaw !== undefined && !/^\d+$/.test(fracRaw)) return null;

  let intDigits: string;
  if (/^\d*$/.test(intRaw)) {
    intDigits = intRaw;
  } else {
    if (!allowGrouping) return null;
    const g = intRaw.match(/\D/)?.[0];
    if (g === undefined) return null;
    const other = dec === "." ? "," : ".";
    if (g !== other && !EXTRA_GROUP_CHARS.has(g)) return null;
    const e = escapeRegExp(g);
    const western = new RegExp(`^[1-9]\\d{0,2}(?:${e}\\d{3})+$`);
    const indian = new RegExp(`^[1-9]\\d?(?:${e}\\d{2})+${e}\\d{3}$`);
    if (!western.test(intRaw) && !indian.test(intRaw)) return null;
    intDigits = intRaw.split(g).join("");
  }
  if (intDigits === "" && fracRaw === undefined) return null;
  return { intDigits: intDigits === "" ? "0" : intDigits, fracDigits: fracRaw ?? "" };
}

/**
 * Tokenize user decimal input. Leading/trailing whitespace is ignored; a single
 * leading "-" (or U+2212) marks a negative value (callers reject it as
 * NOT_POSITIVE); "+" and anything else non-numeric is MALFORMED.
 * Input that is invalid under `dec` but valid under the other separator is
 * AMBIGUOUS_SEPARATOR — we never guess which convention the user meant.
 */
export function parseDecimalInput(
  input: string,
  dec: DecimalSeparator,
  allowGrouping: boolean,
): { ok: true; value: ParsedDecimal } | { ok: false; error: DecimalParseError } {
  const s = input.trim();
  if (s === "") return { ok: false, error: "EMPTY" };
  let negative = false;
  let body = s;
  if (body.startsWith("-") || body.startsWith("−")) {
    negative = true;
    body = body.slice(1);
  }
  const r = interpret(body, dec, allowGrouping);
  if (r) return { ok: true, value: { negative, ...r } };
  const other: DecimalSeparator = dec === "." ? "," : ".";
  if (interpret(body, other, allowGrouping)) return { ok: false, error: "AMBIGUOUS_SEPARATOR" };
  return { ok: false, error: "MALFORMED" };
}
