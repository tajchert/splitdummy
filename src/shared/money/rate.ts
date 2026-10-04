import type { ParseResult } from "./amount";
import {
  assertExponent,
  divRoundHalfUp,
  gcd,
  parseDecimalInput,
  pow10,
  scaledToTrimmedDecimal,
  type DecimalSeparator,
} from "./decimal";

export { divRoundHalfUp, gcd, pow10 };

/** Exact positive rational. Always normalized (gcd-reduced, den > 0). */
export interface Rational {
  num: bigint;
  den: bigint;
}

export const MAX_RATE_FRACTION_DIGITS = 12;
export const MAX_RATE = 1_000_000_000n;

export type RateParseError = "EMPTY" | "MALFORMED" | "AMBIGUOUS_SEPARATOR" | "TOO_PRECISE" | "NOT_POSITIVE" | "TOO_LARGE";

/** Build a normalized rational (gcd-reduced, den > 0). Throws on den = 0. */
export function makeRational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RangeError("rational with zero denominator");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return g > 1n ? { num: num / g, den: den / g } : { num, den };
}

/**
 * Parse "4.30" / "4,30" (no grouping) into an exact rational; up to 12 fractional digits; 0 < rate <= 1e9.
 * The opposite separator is AMBIGUOUS_SEPARATOR when it would parse under that convention ("4,30" with "."),
 * otherwise MALFORMED. Fraction digits beyond 12 are TOO_PRECISE even when zero.
 */
export function parseRate(input: string, decimalSeparator: DecimalSeparator = "."): ParseResult<Rational, RateParseError> {
  const parsed = parseDecimalInput(input, decimalSeparator, false);
  if (!parsed.ok) return parsed;
  const { negative, intDigits, fracDigits } = parsed.value;
  if (fracDigits.length > MAX_RATE_FRACTION_DIGITS) return { ok: false, error: "TOO_PRECISE" };
  const rate = makeRational(BigInt(intDigits + fracDigits), pow10(fracDigits.length));
  if (negative || rate.num === 0n) return { ok: false, error: "NOT_POSITIVE" };
  if (rate.num > MAX_RATE * rate.den) return { ok: false, error: "TOO_LARGE" };
  return { ok: true, value: rate };
}

/** Canonical decimal string for storage, e.g. {43,10} → "4.3". Throws if not a terminating decimal within 12 digits — use only for parsed rates. */
export function rateToString(rate: Rational): string {
  const { num, den } = makeRational(rate.num, rate.den);
  if (num <= 0n) throw new RangeError("rate must be positive");
  for (let digits = 0; digits <= MAX_RATE_FRACTION_DIGITS; digits++) {
    const scale = pow10(digits);
    if (scale % den === 0n) return scaledToTrimmedDecimal((num * scale) / den, digits);
  }
  throw new RangeError(`rate ${num}/${den} is not a decimal with at most ${MAX_RATE_FRACTION_DIGITS} fraction digits`);
}

const RATE_STRING = /^\d{1,10}(\.\d{1,12})?$/;

/** Parse a canonical stored rate string (always "." separator). Throws on malformed or out-of-range input. */
export function rateFromString(s: string): Rational {
  if (!RATE_STRING.test(s)) throw new Error(`invalid rate string: ${s}`);
  const parsed = parseRate(s, ".");
  if (!parsed.ok) throw new Error(`invalid rate string: ${s} (${parsed.error})`);
  return parsed.value;
}

/**
 * baseMinor = roundHalfUp(originalMinor × rate × 10^baseExp / 10^origExp), exact.
 * originalMinor must be > 0.
 */
export function convertToBase(originalMinor: bigint, rate: Rational, originalExponent: number, baseExponent: number): bigint {
  assertExponent(originalExponent);
  assertExponent(baseExponent);
  if (originalMinor <= 0n) throw new RangeError("originalMinor must be > 0");
  if (rate.num <= 0n || rate.den <= 0n) throw new RangeError("rate must be positive");
  return divRoundHalfUp(originalMinor * rate.num * pow10(baseExponent), rate.den * pow10(originalExponent));
}

/**
 * Display rate for ACTUAL_BASE_AMOUNT entries: base major per one original major,
 * rounded half-up to `fractionDigits` (default 6), trailing zeros trimmed. Display only.
 * Both amounts must be > 0. Very small rates may display as "0".
 */
export function deriveDisplayRate(
  originalMinor: bigint,
  baseMinor: bigint,
  originalExponent: number,
  baseExponent: number,
  fractionDigits = 6,
): string {
  assertExponent(originalExponent);
  assertExponent(baseExponent);
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0) throw new RangeError(`invalid fractionDigits: ${fractionDigits}`);
  if (originalMinor <= 0n || baseMinor <= 0n) throw new RangeError("amounts must be > 0");
  const scaled = divRoundHalfUp(
    baseMinor * pow10(originalExponent) * pow10(fractionDigits),
    originalMinor * pow10(baseExponent),
  );
  return scaledToTrimmedDecimal(scaled, fractionDigits);
}
