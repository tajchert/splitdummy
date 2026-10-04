export interface CurrencyInfo {
  /** ISO 4217 alphabetic code, e.g. "EUR". */
  code: string;
  /** Minor-unit exponent: JPY 0, EUR 2, KWD 3. */
  exponent: number;
  /** English name; UI may localize via Intl.DisplayNames. */
  name: string;
}

/** Maintained ISO 4217 active fiat list (no metals, funds, or testing codes). */
export const CURRENCIES: readonly CurrencyInfo[] = [];

export function getCurrency(code: string): CurrencyInfo | undefined {
  throw new Error("not implemented");
}

/** Common picks surfaced first in selectors. */
export const COMMON_CURRENCIES: readonly string[] = ["EUR", "USD", "GBP", "PLN", "CHF", "JPY"];
