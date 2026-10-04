import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_MINOR, formatMinor, minorFromJson, minorToJson, parseAmount } from "./amount";

const ok = (value: bigint) => ({ ok: true, value });
const err = (error: string) => ({ ok: false, error });

describe("parseAmount with '.' decimal separator", () => {
  it.each([
    ["12.34", 2, 1234n],
    ["12", 2, 1200n],
    ["12.3", 2, 1230n],
    [".5", 2, 50n],
    ["0.01", 2, 1n],
    ["  7.5 ", 2, 750n],
    ["007.10", 2, 710n],
    ["1,234.56", 2, 123456n],
    ["1,234", 2, 123400n],
    ["1,234,567", 0, 1234567n],
    ["12,34,567.89", 2, 123456789n],
    ["1 234.56", 2, 123456n],
    ["1\u00A0234.56", 2, 123456n],
    ["1\u202F234.56", 2, 123456n],
    ["1'234.56", 2, 123456n],
    ["1\u2019234.56", 2, 123456n],
    ["100", 0, 100n],
    ["1.234", 3, 1234n],
    ["0.001", 3, 1n],
    ["10000000000.00", 2, MAX_MINOR],
    ["1,000,000,000,000", 0, MAX_MINOR],
  ] as const)("%j (exp %i) → %s", (input, exp, expected) => {
    expect(parseAmount(input, exp, ".")).toEqual(ok(expected));
  });

  it.each([
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    ["1,23", "AMBIGUOUS_SEPARATOR"],
    ["1,2345", "AMBIGUOUS_SEPARATOR"],
    ["0,123", "AMBIGUOUS_SEPARATOR"],
    ["1.234,56", "AMBIGUOUS_SEPARATOR"],
    ["1 234,56", "AMBIGUOUS_SEPARATOR"],
    [",5", "AMBIGUOUS_SEPARATOR"],
    ["1,23,4", "MALFORMED"],
    ["12a", "MALFORMED"],
    ["abc", "MALFORMED"],
    ["1..2", "MALFORMED"],
    ["1.2.3", "MALFORMED"],
    ["5.", "MALFORMED"],
    [".", "MALFORMED"],
    ["-", "MALFORMED"],
    ["+5", "MALFORMED"],
    ["--5", "MALFORMED"],
    ["- 5", "MALFORMED"],
    ["1e3", "MALFORMED"],
    ["1 2", "MALFORMED"],
    ["1  234", "MALFORMED"],
    ["1,234 567", "MALFORMED"],
    ["1,234.5,6", "MALFORMED"],
    ["1.2 3", "MALFORMED"],
    ["\u0661\u0662", "MALFORMED"],
    ["Infinity", "MALFORMED"],
    ["NaN", "MALFORMED"],
    ["0x10", "MALFORMED"],
    ["$5", "MALFORMED"],
    ["5 EUR", "MALFORMED"],
    ["1.234", "TOO_PRECISE"],
    ["1.000", "TOO_PRECISE"],
    ["0", "NOT_POSITIVE"],
    ["0.00", "NOT_POSITIVE"],
    ["-5", "NOT_POSITIVE"],
    ["-0", "NOT_POSITIVE"],
    ["\u22125.00", "NOT_POSITIVE"],
    ["10000000000.01", "TOO_LARGE"],
    ["99999999999999999999", "TOO_LARGE"],
  ] as const)("%j (EUR) → %s", (input, error) => {
    expect(parseAmount(input, 2, ".")).toEqual(err(error));
  });

  it("JPY accepts no fractional digits, not even zeros", () => {
    expect(parseAmount("1500", 0)).toEqual(ok(1500n));
    expect(parseAmount("1.5", 0)).toEqual(err("TOO_PRECISE"));
    expect(parseAmount("10.00", 0)).toEqual(err("TOO_PRECISE"));
    expect(parseAmount("1000000000001", 0)).toEqual(err("TOO_LARGE"));
  });

  it("KWD accepts up to three decimals", () => {
    expect(parseAmount("1.5", 3)).toEqual(ok(1500n));
    expect(parseAmount("12.345", 3)).toEqual(ok(12345n));
    expect(parseAmount("12.3456", 3)).toEqual(err("TOO_PRECISE"));
  });

  it("defaults to '.'", () => {
    expect(parseAmount("1,234.5", 2)).toEqual(ok(123450n));
  });

  it("rejects invalid exponents", () => {
    expect(() => parseAmount("1", -1)).toThrow(RangeError);
    expect(() => parseAmount("1", 1.5)).toThrow(RangeError);
  });
});

describe("parseAmount with ',' decimal separator", () => {
  it.each([
    ["12,34", 2, 1234n],
    ["1,23", 2, 123n],
    [",5", 2, 50n],
    ["1.234,56", 2, 123456n],
    ["1.234", 2, 123400n],
    ["1.234.567,8", 2, 123456780n],
    ["1 234,56", 2, 123456n],
    ["1\u00A0234,56", 2, 123456n],
    ["1,234", 3, 1234n],
  ] as const)("%j (exp %i) → %s", (input, exp, expected) => {
    expect(parseAmount(input, exp, ",")).toEqual(ok(expected));
  });

  it.each([
    ["1.23", 2, "AMBIGUOUS_SEPARATOR"],
    ["1.2345", 2, "AMBIGUOUS_SEPARATOR"],
    ["1,234.56", 2, "AMBIGUOUS_SEPARATOR"],
    ["0.5", 2, "AMBIGUOUS_SEPARATOR"],
    ["1,234", 2, "TOO_PRECISE"],
    ["1,5", 0, "TOO_PRECISE"],
    ["1,,2", 2, "MALFORMED"],
    ["5,", 2, "MALFORMED"],
    ["-1,5", 2, "NOT_POSITIVE"],
  ] as const)("%j (exp %i) → %s", (input, exp, error) => {
    expect(parseAmount(input, exp, ",")).toEqual(err(error));
  });
});

describe("formatMinor", () => {
  it.each([
    [112455n, 2, "en-US", "1,124.55"],
    [0n, 2, "en-US", "0.00"],
    [5n, 2, "en-US", "0.05"],
    [-5n, 2, "en-US", "-0.05"],
    [-112455n, 2, "en-US", "-1,124.55"],
    [1234n, 0, "en-US", "1,234"],
    [1234567n, 3, "en-US", "1,234.567"],
    [1n, 3, "en-US", "0.001"],
    [MAX_MINOR, 2, "en-US", "10,000,000,000.00"],
    [MAX_MINOR, 0, "en-US", "1,000,000,000,000"],
    [9007199254740993n, 0, "en-US", "9,007,199,254,740,993"],
    [112455n, 2, "de-DE", "1.124,55"],
    [123456n, 2, "pl-PL", "1234,56"],
    [1234567n, 2, "pl-PL", "12\u00A0345,67"],
    [1234567n, 2, "fr-FR", "12\u202F345,67"],
    [123456789n, 2, "en-IN", "12,34,567.89"],
    [123456n, 2, "de-CH", "1'234.56"],
    [-150n, 2, "sv-SE", "\u22121,50"],
    [123456n, 2, "ar-EG", "1,234.56"],
    [-123456n, 2, "ar-EG", "\u200E-1,234.56"],
  ] as const)("%s (exp %i, %s) → %j", (minor, exp, locale, expected) => {
    expect(formatMinor(minor, exp, locale)).toBe(expected);
  });

  it("defaults to en-US", () => {
    expect(formatMinor(112455n, 2)).toBe("1,124.55");
  });
});

describe("minor JSON", () => {
  it("round-trips and validates", () => {
    expect(minorFromJson(minorToJson(-500n))).toBe(-500n);
    expect(() => minorFromJson("1.5")).toThrow();
    expect(() => minorFromJson("")).toThrow();
  });
});

describe("parse/format round-trip (property)", () => {
  const locales = [
    ["en-US", "."],
    ["de-DE", ","],
    ["pl-PL", ","],
    ["fr-FR", ","],
    ["de-CH", "."],
    ["en-IN", "."],
    ["es-ES", ","],
  ] as const;

  for (const exponent of [0, 2, 3]) {
    it(`exponent ${exponent}: parseAmount(formatMinor(m)) === m`, () => {
      fc.assert(
        fc.property(fc.bigInt({ min: 1n, max: MAX_MINOR }), fc.constantFrom(...locales), (minor, [locale, sep]) => {
          const text = formatMinor(minor, exponent, locale);
          expect(parseAmount(text, exponent, sep)).toEqual(ok(minor));
        }),
        { numRuns: 500 },
      );
    });
  }

  it("small amounts round-trip too", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 100_000n }), fc.constantFrom(0, 2, 3), fc.constantFrom(...locales), (minor, exponent, [locale, sep]) => {
        expect(parseAmount(formatMinor(minor, exponent, locale), exponent, sep)).toEqual(ok(minor));
      }),
      { numRuns: 500 },
    );
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.constantFrom(0, 2, 3), fc.constantFrom(".", ","), (s, exponent, sep) => {
        const r = parseAmount(s, exponent, sep);
        if (r.ok) {
          expect(r.value > 0n && r.value <= MAX_MINOR).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("parses plain digit strings exactly", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 9_999_999_999n }), fc.integer({ min: 0, max: 99 }), (int, frac) => {
        const text = `${int}.${String(frac).padStart(2, "0")}`;
        expect(parseAmount(text, 2)).toEqual(ok(int * 100n + BigInt(frac)));
      }),
    );
  });
});
