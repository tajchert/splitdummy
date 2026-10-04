import type { ParseResult } from "./amount";

/** Exact positive rational. Always normalized (gcd-reduced, den > 0). */
export interface Rational {
  num: bigint;
  den: bigint;
}

export const MAX_RATE_FRACTION_DIGITS = 12;
export const MAX_RATE = 1_000_000_000n;

export type RateParseError = "EMPTY" | "MALFORMED" | "AMBIGUOUS_SEPARATOR" | "TOO_PRECISE" | "NOT_POSITIVE" | "TOO_LARGE";

/** Parse "4.30" / "4,30" (no grouping) into an exact rational; up to 12 fractional digits; 0 < rate <= 1e9. */
export function parseRate(input: string, decimalSeparator: "." | "," = "."): ParseResult<Rational, RateParseError> {
  throw new Error("not implemented");
}

/** Canonical decimal string for storage, e.g. {43,10} → "4.3". Throws if not a terminating decimal within 12 digits — use only for parsed rates. */
export function rateToString(rate: Rational): string {
  throw new Error("not implemented");
}

/** Parse a canonical stored rate string (always "." separator). */
export function rateFromString(s: string): Rational {
  throw new Error("not implemented");
}

/**
 * baseMinor = roundHalfUp(originalMinor × rate × 10^baseExp / 10^origExp), exact.
 * originalMinor must be > 0.
 */
export function convertToBase(originalMinor: bigint, rate: Rational, originalExponent: number, baseExponent: number): bigint {
  throw new Error("not implemented");
}

/**
 * Display rate for ACTUAL_BASE_AMOUNT entries: base major per one original major,
 * rounded half-up to `fractionDigits` (default 6), trailing zeros trimmed. Display only.
 */
export function deriveDisplayRate(
  originalMinor: bigint,
  baseMinor: bigint,
  originalExponent: number,
  baseExponent: number,
  fractionDigits?: number,
): string {
  throw new Error("not implemented");
}
