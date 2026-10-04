/** First-release hard limit for any single amount and cumulative absolute round total. */
export const MAX_MINOR = 1_000_000_000_000n;

export type AmountParseError =
  | "EMPTY"
  | "MALFORMED"
  | "AMBIGUOUS_SEPARATOR"
  | "TOO_PRECISE"
  | "NOT_POSITIVE"
  | "TOO_LARGE";

export type ParseResult<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Parse user input in MAJOR units into minor units.
 * decimalSeparator is the input locale's decimal mark. Grouping separators
 * are allowed only when unambiguous (e.g. "1,234.56" with ".", "1.234,56" with ",").
 * "1,234" with decimalSeparator "." is accepted as 1234; "1,23" with "." is AMBIGUOUS_SEPARATOR.
 * Rejects more fractional digits than the currency exponent (TOO_PRECISE),
 * zero/negative (NOT_POSITIVE), and values > MAX_MINOR (TOO_LARGE).
 */
export function parseAmount(
  input: string,
  exponent: number,
  decimalSeparator: "." | "," = ".",
): ParseResult<bigint, AmountParseError> {
  throw new Error("not implemented");
}

/** Format minor units as a plain grouped number string, e.g. 112455n,2 → "1,124.55" (en). Sign-preserving. No currency code. */
export function formatMinor(minor: bigint, exponent: number, locale = "en-US"): string {
  throw new Error("not implemented");
}

/** Convert minor bigint to a canonical JSON decimal string and back. */
export function minorToJson(minor: bigint): string {
  return minor.toString();
}
export function minorFromJson(s: string): bigint {
  if (!/^-?\d{1,16}$/.test(s)) throw new Error(`invalid minor amount: ${s}`);
  return BigInt(s);
}
