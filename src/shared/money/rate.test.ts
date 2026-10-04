import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_RATE,
  convertToBase,
  deriveDisplayRate,
  divRoundHalfUp,
  makeRational,
  parseRate,
  rateFromString,
  rateToString,
  type Rational,
} from "./rate";

const r = (num: bigint, den: bigint): Rational => ({ num, den });

describe("parseRate", () => {
  it.each([
    ["4.30", ".", r(43n, 10n)],
    ["4,30", ",", r(43n, 10n)],
    ["4", ".", r(4n, 1n)],
    [".5", ".", r(1n, 2n)],
    [" 0.25 ", ".", r(1n, 4n)],
    ["1000000000", ".", r(MAX_RATE, 1n)],
    ["0.000000000001", ".", r(1n, 1_000_000_000_000n)],
    ["161.234567890123", ".", makeRational(161234567890123n, 1_000_000_000_000n)],
  ] as const)("%j (%s) → exact rational", (input, sep, expected) => {
    expect(parseRate(input, sep)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["", ".", "EMPTY"],
    ["4,30", ".", "AMBIGUOUS_SEPARATOR"],
    ["4.30", ",", "AMBIGUOUS_SEPARATOR"],
    ["1,234.5", ".", "MALFORMED"],
    ["1,234", ".", "AMBIGUOUS_SEPARATOR"],
    ["1 234", ".", "MALFORMED"],
    ["abc", ".", "MALFORMED"],
    ["5.", ".", "MALFORMED"],
    ["4.3.0", ".", "MALFORMED"],
    ["+4.3", ".", "MALFORMED"],
    ["1e3", ".", "MALFORMED"],
    ["0.0000000000001", ".", "TOO_PRECISE"],
    ["1.0000000000000", ".", "TOO_PRECISE"],
    ["0", ".", "NOT_POSITIVE"],
    ["0.000", ".", "NOT_POSITIVE"],
    ["-4.3", ".", "NOT_POSITIVE"],
    ["1000000000.000000000001", ".", "TOO_LARGE"],
    ["1000000001", ".", "TOO_LARGE"],
  ] as const)("%j (%s) → %s", (input, sep, error) => {
    expect(parseRate(input, sep)).toEqual({ ok: false, error });
  });

  it("defaults to '.'", () => {
    expect(parseRate("4.3")).toEqual({ ok: true, value: r(43n, 10n) });
  });
});

describe("rateToString / rateFromString", () => {
  it.each([
    [r(43n, 10n), "4.3"],
    [r(86n, 20n), "4.3"],
    [r(1n, 1n), "1"],
    [r(1n, 4096n), "0.000244140625"],
    [r(1n, 1_000_000_000_000n), "0.000000000001"],
    [r(MAX_RATE, 1n), "1000000000"],
  ] as const)("%o → %j", (rate, s) => {
    expect(rateToString(rate)).toBe(s);
  });

  it("throws for non-terminating, too precise or nonpositive rationals", () => {
    expect(() => rateToString(r(1n, 3n))).toThrow();
    expect(() => rateToString(r(1n, 8192n))).toThrow(); // 13 fraction digits
    expect(() => rateToString(r(0n, 1n))).toThrow();
    expect(() => rateToString(r(-1n, 2n))).toThrow();
  });

  it("parses canonical strings and rejects anything else", () => {
    expect(rateFromString("4.3")).toEqual(r(43n, 10n));
    expect(rateFromString("4.30")).toEqual(r(43n, 10n));
    expect(rateFromString("1")).toEqual(r(1n, 1n));
    for (const bad of ["", "4,3", ".5", "5.", " 4.3", "-1", "0", "1e3", "1000000001", "1.0000000000001"]) {
      expect(() => rateFromString(bad), bad).toThrow();
    }
  });

  it("round-trips every parseable rate exactly (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: MAX_RATE - 1n }),
        fc.stringMatching(/^\d{0,12}$/),
        (int, frac) => {
          const text = frac ? `${int}.${frac}` : `${int}`;
          const parsed = parseRate(text);
          if (!parsed.ok) {
            expect(parsed.error).toBe("NOT_POSITIVE");
            return;
          }
          const canonical = rateToString(parsed.value);
          expect(canonical).toMatch(/^\d{1,10}(\.\d{0,11}[1-9])?$/);
          expect(rateFromString(canonical)).toEqual(parsed.value);
          expect(parseRate(text.replace(".", ","), ",")).toEqual(parsed);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("divRoundHalfUp", () => {
  it.each([
    [5n, 2n, 3n],
    [4n, 2n, 2n],
    [1n, 3n, 0n],
    [2n, 3n, 1n],
    [0n, 7n, 0n],
    [-5n, 2n, -3n],
    [-1n, 3n, 0n],
    [-2n, 3n, -1n],
    [5n, -2n, -3n],
  ])("%s / %s → %s", (n, d, q) => {
    expect(divRoundHalfUp(n, d)).toBe(q);
  });

  it("throws on division by zero", () => {
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(RangeError);
  });
});

describe("convertToBase", () => {
  it.each([
    ["100.00 EUR @4.30 → PLN", 10000n, "4.30", 2, 2, 43000n],
    ["1000 JPY @0.0062 → EUR", 1000n, "0.0062", 0, 2, 620n],
    ["100.00 EUR @161.2345 → JPY (down)", 10000n, "161.2345", 2, 0, 16123n],
    ["100.00 EUR @161.235 → JPY (half up)", 10000n, "161.235", 2, 0, 16124n],
    ["1.000 KWD @2.95 → EUR", 1000n, "2.95", 3, 2, 295n],
    ["100.00 EUR @0.338765 → KWD (half up)", 10000n, "0.338765", 2, 3, 33877n],
    ["100.00 EUR @0.338764 → KWD (down)", 10000n, "0.338764", 2, 3, 33876n],
    ["1000 JPY @0.002083 → KWD", 1000n, "0.002083", 0, 3, 2083n],
    ["1.000 KWD @480.5 → JPY", 1000n, "480.5", 3, 0, 481n],
    ["0.001 KWD @480.5 → JPY rounds to 0", 1n, "480.5", 3, 0, 0n],
    ["0.001 KWD @500 → JPY exactly half", 1n, "500", 3, 0, 1n],
    ["max amount @max rate", 1_000_000_000_000n, "1000000000", 2, 2, 1_000_000_000_000_000_000_000n],
  ] as const)("%s", (_label, minor, rate, from, to, expected) => {
    expect(convertToBase(minor, rateFromString(rate), from, to)).toBe(expected);
  });

  it("rejects nonpositive amounts and rates", () => {
    expect(() => convertToBase(0n, r(1n, 1n), 2, 2)).toThrow(RangeError);
    expect(() => convertToBase(-1n, r(1n, 1n), 2, 2)).toThrow(RangeError);
    expect(() => convertToBase(1n, r(0n, 1n), 2, 2)).toThrow(RangeError);
  });

  it("is the exact half-up rounding of the true value (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000_000_000_000_000n }),
        fc.constantFrom(1n, 10n, 1000n, 1_000_000_000_000n),
        fc.constantFrom(0, 2, 3),
        fc.constantFrom(0, 2, 3),
        (minor, rateNum, rateDen, from, to) => {
          const rate = makeRational(rateNum, rateDen);
          const q = convertToBase(minor, rate, from, to);
          // exact value x = num/den; half-up q satisfies q - 1/2 <= x < q + 1/2
          const num = minor * rate.num * 10n ** BigInt(to);
          const den = rate.den * 10n ** BigInt(from);
          expect(2n * q * den - den <= 2n * num).toBe(true);
          expect(2n * num < 2n * q * den + den).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("round-trips across exponents when the rate is a power of ten", () => {
    // 1 JPY = 0.01 EUR-major (toy rate) ⇒ JPY minor == EUR minor; and back with rate 100.
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000_000n }), (yen) => {
        const eurCents = convertToBase(yen, r(1n, 100n), 0, 2);
        expect(eurCents).toBe(yen);
        expect(convertToBase(eurCents, r(100n, 1n), 2, 0)).toBe(yen);
        const fils = convertToBase(yen, r(1n, 1n), 0, 3);
        expect(fils).toBe(yen * 1000n);
        expect(convertToBase(fils, r(1n, 1n), 3, 0)).toBe(yen);
      }),
    );
  });
});

describe("deriveDisplayRate", () => {
  it.each([
    ["432 PLN for 100 EUR", 10000n, 43200n, 2, 2, undefined, "4.32"],
    ["430 PLN for 100 EUR", 10000n, 43000n, 2, 2, undefined, "4.3"],
    ["1 for 3", 300n, 100n, 2, 2, undefined, "0.333333"],
    ["2 for 3 (half up)", 300n, 200n, 2, 2, undefined, "0.666667"],
    ["2 for 3 at 2 digits", 300n, 200n, 2, 2, 2, "0.67"],
    ["6.20 EUR for 1000 JPY", 1000n, 620n, 0, 2, undefined, "0.0062"],
    ["2.95 EUR for 1.000 KWD", 1000n, 295n, 3, 2, undefined, "2.95"],
    ["481 JPY for 1.000 KWD", 1000n, 481n, 3, 0, undefined, "481"],
    ["0 digits", 10000n, 43200n, 2, 2, 0, "4"],
    ["tiny rate", 1_000_000_000_000n, 1n, 0, 0, undefined, "0"],
  ] as const)("%s", (_label, orig, base, oe, be, digits, expected) => {
    expect(deriveDisplayRate(orig, base, oe, be, digits)).toBe(expected);
  });

  it("rejects nonpositive amounts", () => {
    expect(() => deriveDisplayRate(0n, 1n, 2, 2)).toThrow(RangeError);
    expect(() => deriveDisplayRate(1n, 0n, 2, 2)).toThrow(RangeError);
  });
});
