import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { apportion, splitEqual, sumShares, type Shares } from "./split";

const memberId = fc.stringMatching(/^m_[a-z0-9]{1,4}$/);

describe("splitEqual", () => {
  it("100 PLN between three people → 33.34 / 33.33 / 33.33", () => {
    expect(splitEqual(10000n, ["m_a", "m_b", "m_c"])).toEqual({ m_a: 3334n, m_b: 3333n, m_c: 3333n });
  });

  it("gives remainder units by ascending member ID regardless of input order", () => {
    const result = splitEqual(10001n, ["m_c", "m_a", "m_b"]);
    expect(result).toEqual({ m_a: 3334n, m_b: 3334n, m_c: 3333n });
    expect(Object.keys(result)).toEqual(["m_a", "m_b", "m_c"]);
  });

  it("deduplicates member IDs", () => {
    expect(splitEqual(5n, ["m_b", "m_a", "m_b"])).toEqual({ m_a: 3n, m_b: 2n });
  });

  it("handles totals smaller than the member count", () => {
    expect(splitEqual(2n, ["m_a", "m_b", "m_c"])).toEqual({ m_a: 1n, m_b: 1n, m_c: 0n });
  });

  it("splits negative totals symmetrically", () => {
    expect(splitEqual(-10000n, ["m_a", "m_b", "m_c"])).toEqual({ m_a: -3334n, m_b: -3333n, m_c: -3333n });
  });

  it("handles empty member lists", () => {
    expect(splitEqual(0n, [])).toEqual({});
    expect(() => splitEqual(1n, [])).toThrow(RangeError);
  });

  it("splits exactly with max deviation of one unit (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
        fc.uniqueArray(memberId, { minLength: 1, maxLength: 30 }),
        (total, ids) => {
          const shares = splitEqual(total, ids);
          expect(sumShares(shares)).toBe(total);
          const values = Object.values(shares);
          const min = values.reduce((a, b) => (a < b ? a : b));
          const max = values.reduce((a, b) => (a > b ? a : b));
          expect(max - min <= 1n).toBe(true);
        },
      ),
    );
  });
});

describe("apportion", () => {
  it("apportions proportionally with largest remainder and ID tie-break", () => {
    expect(apportion(10n, { m_c: 2n, m_b: 1n, m_a: 1n })).toEqual({ m_a: 3n, m_b: 2n, m_c: 5n });
  });

  it("prefers the larger remainder over a smaller ID", () => {
    // 10 × {1,2}/3 → 3.33 / 6.67: m_b has the larger remainder.
    expect(apportion(10n, { m_a: 1n, m_b: 2n })).toEqual({ m_a: 3n, m_b: 7n });
  });

  it("apportions a converted base total over original allocations", () => {
    expect(apportion(43000n, { m_alice: 5000n, m_bob: 5000n })).toEqual({ m_alice: 21500n, m_bob: 21500n });
    expect(apportion(43200n, { m_a: 3334n, m_b: 3333n, m_c: 3333n })).toEqual({ m_a: 14403n, m_b: 14399n, m_c: 14398n });
  });

  it("gives zero weights zero and keeps them as rows", () => {
    expect(apportion(5n, { m_a: 0n, m_b: 1n, m_c: 0n })).toEqual({ m_a: 0n, m_b: 5n, m_c: 0n });
    expect(apportion(1n, { m_a: 0n, m_b: 1n, m_c: 1n })).toEqual({ m_a: 0n, m_b: 1n, m_c: 0n });
  });

  it("handles all-zero weights", () => {
    expect(apportion(0n, { m_a: 0n, m_b: 0n })).toEqual({ m_a: 0n, m_b: 0n });
    expect(apportion(0n, {})).toEqual({});
    expect(() => apportion(1n, { m_a: 0n })).toThrow(RangeError);
    expect(() => apportion(1n, {})).toThrow(RangeError);
  });

  it("rejects negative weights", () => {
    expect(() => apportion(10n, { m_a: -1n, m_b: 2n })).toThrow(RangeError);
  });

  const weightsArb = fc.dictionary(
    memberId,
    fc.oneof(fc.constant(0n), fc.bigInt({ min: 0n, max: 1_000_000_000_000n }), fc.bigInt({ min: 1n, max: 10n })),
    { minKeys: 1, maxKeys: 25 },
  );
  const nonZero = (w: Shares) => Object.values(w).some((v) => v > 0n);

  it("sums exactly, stays within one unit of the exact quota, gives zero weights zero (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }), weightsArb, (total, weights) => {
        fc.pre(nonZero(weights));
        const shares = apportion(total, weights);
        expect(sumShares(shares)).toBe(total);
        expect(Object.keys(shares).sort()).toEqual(Object.keys(weights).sort());
        const W = sumShares(weights);
        for (const [id, w] of Object.entries(weights)) {
          const s = shares[id]!;
          if (w === 0n) expect(s).toBe(0n);
          // |s − total·w/W| < 1  ⇔  |s·W − total·w| < W
          const diff = s * W - total * w;
          expect((diff < 0n ? -diff : diff) < W).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("is monotone in weight and sign-symmetric (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000_000_000n }), weightsArb, (total, weights) => {
        fc.pre(nonZero(weights));
        const shares = apportion(total, weights);
        const entries = Object.entries(weights);
        for (const [i, wi] of entries) {
          for (const [j, wj] of entries) {
            if (wi > wj) expect(shares[i]! >= shares[j]!).toBe(true);
            if (wi === wj) expect(shares[i]! - shares[j]! <= 1n).toBe(true);
          }
        }
        const negated = apportion(-total, weights);
        for (const id of Object.keys(weights)) expect(negated[id]).toBe(-shares[id]!);
      }),
      { numRuns: 500 },
    );
  });

  it("does not depend on key insertion order (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), weightsArb, (total, weights) => {
        fc.pre(nonZero(weights));
        const reversed = Object.fromEntries(Object.entries(weights).reverse());
        expect(apportion(total, reversed)).toEqual(apportion(total, weights));
      }),
    );
  });
});
