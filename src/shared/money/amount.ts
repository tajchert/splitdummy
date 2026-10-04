import { assertExponent, parseDecimalInput, pow10, type DecimalSeparator } from "./decimal";

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
 *
 * Detailed rules (symmetric for "," as decimal mark):
 * - Surrounding whitespace is ignored. Grouping uses ONE kind of character: the
 *   opposite separator, space, NBSP, narrow NBSP, thin space, ' or ’; groups must
 *   follow a strict 3-digit (or Indian 2+3) layout and cannot start with 0.
 *   So with ".": "1,234" → 1234, "1 234.5" → 1234.50, "12,34,567" → 1234567.
 * - Input that only makes sense under the other decimal convention is
 *   AMBIGUOUS_SEPARATOR: with ".", "1,23", "1,2345", "0,123", "1.234,56".
 *   With ",", "1.234" is grouping (1234), mirroring the "1,234" rule above.
 * - Fraction digits beyond the exponent are TOO_PRECISE even when zero
 *   ("10.00" JPY, "1.000" EUR): accepting them would mean guessing.
 * - ".5" is accepted; "5." , "+5", "1e3", "1..2", "1.2.3", inner spaces outside
 *   valid groups, and non-ASCII digits are MALFORMED.
 * - A leading "-" yields NOT_POSITIVE (after structure/precision checks).
 */
export function parseAmount(
  input: string,
  exponent: number,
  decimalSeparator: DecimalSeparator = ".",
): ParseResult<bigint, AmountParseError> {
  assertExponent(exponent);
  const parsed = parseDecimalInput(input, decimalSeparator, true);
  if (!parsed.ok) return parsed;
  const { negative, intDigits, fracDigits } = parsed.value;
  if (fracDigits.length > exponent) return { ok: false, error: "TOO_PRECISE" };
  const minor = BigInt(intDigits + fracDigits.padEnd(exponent, "0"));
  if (negative || minor === 0n) return { ok: false, error: "NOT_POSITIVE" };
  if (minor > MAX_MINOR) return { ok: false, error: "TOO_LARGE" };
  return { ok: true, value: minor };
}

interface LocaleNumberParts {
  integer: Intl.NumberFormat;
  decimal: string;
  /** Parts of formatting -1 / 1, used as sign/bidi templates around the number. */
  negativeTemplate: Intl.NumberFormatPart[];
  positiveTemplate: Intl.NumberFormatPart[];
}

const localeCache = new Map<string, LocaleNumberParts>();

function localeParts(locale: string): LocaleNumberParts {
  let p = localeCache.get(locale);
  if (!p) {
    // Latin digits keep output parseable by parseAmount; Intl only supplies symbols and grouping layout.
    const integer = new Intl.NumberFormat(locale, { numberingSystem: "latn", maximumFractionDigits: 0 });
    const withFraction = new Intl.NumberFormat(locale, { numberingSystem: "latn", minimumFractionDigits: 1 });
    const decimal = withFraction.formatToParts(1.5).find((x) => x.type === "decimal")?.value ?? ".";
    p = {
      integer,
      decimal,
      negativeTemplate: integer.formatToParts(-1n),
      positiveTemplate: integer.formatToParts(1n),
    };
    localeCache.set(locale, p);
  }
  return p;
}

/**
 * Format minor units as a plain grouped number string, e.g. 112455n,2 → "1,124.55" (en). Sign-preserving. No currency code.
 * The value is split with BigInt string math; Intl formats only the (bigint, exact) integer part
 * for locale grouping, and supplies the decimal and minus symbols. Digits are always Latin.
 */
export function formatMinor(minor: bigint, exponent: number, locale = "en-US"): string {
  assertExponent(exponent);
  const p = localeParts(locale);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const scale = pow10(exponent);
  const intPart = abs / scale;
  const fraction = exponent > 0 ? p.decimal + (abs % scale).toString().padStart(exponent, "0") : "";
  const number = p.integer.format(intPart) + fraction;
  const template = negative ? p.negativeTemplate : p.positiveTemplate;
  return template.map((part) => (part.type === "integer" ? number : part.value)).join("");
}

/** Convert minor bigint to a canonical JSON decimal string and back. */
export function minorToJson(minor: bigint): string {
  return minor.toString();
}
export function minorFromJson(s: string): bigint {
  if (!/^-?\d{1,16}$/.test(s)) throw new Error(`invalid minor amount: ${s}`);
  return BigInt(s);
}
