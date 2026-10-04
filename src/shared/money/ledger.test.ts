import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_MINOR } from "./amount";
import {
  computeBalances,
  computeEntry,
  type BalanceEntry,
  type ComputedEntry,
  type EntryComputationInput,
  type MemberBalance,
} from "./ledger";
import { rateFromString } from "./rate";
import { planSettlement } from "./settlement";
import { sumShares } from "./split";

function compute(input: EntryComputationInput): ComputedEntry {
  const r = computeEntry(input);
  if (!r.ok) throw new Error(`unexpected ${r.error}`);
  return r.value;
}

function toBalanceEntry(type: "EXPENSE" | "REFUND", e: ComputedEntry): BalanceEntry {
  return { type, baseContributions: e.baseContributions, baseAllocations: e.baseAllocations };
}

const nets = (rows: MemberBalance[]) => Object.fromEntries(rows.map((r) => [r.memberId, r.net]));

const eurToPln = (rate: string, participants: EntryComputationInput["participants"] = ["m_alice", "m_bob"]): EntryComputationInput => ({
  type: "EXPENSE",
  originalAmount: 10000n,
  originalExponent: 2,
  baseExponent: 2,
  conversion: { method: "MANUAL_RATE", rate: rateFromString(rate) },
  payerMemberId: "m_alice",
  splitMode: Array.isArray(participants) ? "EQUAL" : "EXACT",
  participants,
});

describe("computeEntry — acceptance examples", () => {
  it("Alice pays 100 EUR at 4.30 split with Bob: base 430 PLN, Bob owes 215 PLN", () => {
    const e = compute(eurToPln("4.30"));
    expect(e).toEqual({
      baseAmount: 43000n,
      originalContributions: { m_alice: 10000n },
      baseContributions: { m_alice: 43000n },
      originalAllocations: { m_alice: 5000n, m_bob: 5000n },
      baseAllocations: { m_alice: 21500n, m_bob: 21500n },
      rateString: "4.3",
    });
    const balances = computeBalances([toBalanceEntry("EXPENSE", e)], ["m_alice", "m_bob"]);
    expect(nets(balances)).toEqual({ m_alice: 21500n, m_bob: -21500n });
    expect(planSettlement(nets(balances))).toEqual([{ from: "m_bob", to: "m_alice", amount: 21500n }]);
  });

  it("a later default of 4.50 does not change the saved entry or its transfer", () => {
    const saved = toBalanceEntry("EXPENSE", compute(eurToPln("4.30")));
    const later = compute(eurToPln("4.50"));
    expect(later.baseAmount).toBe(45000n);
    const balances = computeBalances([saved], ["m_alice", "m_bob"]);
    expect(planSettlement(nets(balances))).toEqual([{ from: "m_bob", to: "m_alice", amount: 21500n }]);
  });

  it("100 EUR with an actual charge of 432 PLN settles from 432 PLN", () => {
    const e = compute({ ...eurToPln("1"), conversion: { method: "ACTUAL_BASE_AMOUNT", baseAmount: 43200n } });
    expect(e.baseAmount).toBe(43200n);
    expect(e.rateString).toBe("4.32");
    expect(e.baseContributions).toEqual({ m_alice: 43200n });
    expect(e.baseAllocations).toEqual({ m_alice: 21600n, m_bob: 21600n });
    expect(planSettlement(nets(computeBalances([toBalanceEntry("EXPENSE", e)], ["m_alice", "m_bob"])))).toEqual([
      { from: "m_bob", to: "m_alice", amount: 21600n },
    ]);
  });

  it("100 PLN equally between three people allocates 33.34/33.33/33.33 and balances sum exactly", () => {
    const e = compute({
      type: "EXPENSE",
      originalAmount: 10000n,
      originalExponent: 2,
      baseExponent: 2,
      conversion: { method: "IDENTITY" },
      payerMemberId: "m_a",
      splitMode: "EQUAL",
      participants: ["m_c", "m_b", "m_a"],
    });
    expect(e.rateString).toBe("1");
    expect(e.baseAmount).toBe(10000n);
    expect(e.originalAllocations).toEqual({ m_a: 3334n, m_b: 3333n, m_c: 3333n });
    expect(e.baseAllocations).toEqual({ m_a: 3334n, m_b: 3333n, m_c: 3333n });
    const balances = computeBalances([toBalanceEntry("EXPENSE", e)], ["m_a", "m_b", "m_c"]);
    expect(nets(balances)).toEqual({ m_a: 6666n, m_b: -3333n, m_c: -3333n });
  });

  it("JPY expense in a EUR project and KWD expense in a JPY project convert across exponents", () => {
    const jpy = compute({
      type: "EXPENSE",
      originalAmount: 1500n, // ¥1500
      originalExponent: 0,
      baseExponent: 2,
      conversion: { method: "MANUAL_RATE", rate: rateFromString("0.0062") },
      payerMemberId: "m_a",
      splitMode: "EQUAL",
      participants: ["m_a", "m_b", "m_c"],
    });
    expect(jpy.baseAmount).toBe(930n); // 9.30 EUR
    expect(jpy.originalAllocations).toEqual({ m_a: 500n, m_b: 500n, m_c: 500n });
    expect(jpy.baseAllocations).toEqual({ m_a: 310n, m_b: 310n, m_c: 310n });

    const kwd = compute({
      type: "EXPENSE",
      originalAmount: 12345n, // 12.345 KWD
      originalExponent: 3,
      baseExponent: 0,
      conversion: { method: "MANUAL_RATE", rate: rateFromString("480.5") },
      payerMemberId: "m_a",
      splitMode: "EQUAL",
      participants: ["m_a", "m_b"],
    });
    expect(kwd.baseAmount).toBe(5932n); // 5931.7725 → ¥5932
    expect(kwd.originalAllocations).toEqual({ m_a: 6173n, m_b: 6172n });
    expect(kwd.baseAllocations).toEqual({ m_a: 2966n, m_b: 2966n });
  });

  it("exact foreign splits preserve both totals and zero shares get no pennies", () => {
    const e = compute({
      type: "EXPENSE",
      originalAmount: 10001n, // 100.01 EUR
      originalExponent: 2,
      baseExponent: 3,
      conversion: { method: "MANUAL_RATE", rate: rateFromString("0.338765") },
      payerMemberId: "m_z",
      splitMode: "EXACT",
      participants: { m_d: 0n, m_c: 3334n, m_b: 3333n, m_a: 3334n },
    });
    expect(e.baseAmount).toBe(33880n); // 33879.88... → 33.880 KWD
    expect(e.originalAllocations).toEqual({ m_a: 3334n, m_b: 3333n, m_c: 3334n, m_d: 0n });
    expect(sumShares(e.originalAllocations)).toBe(10001n);
    expect(sumShares(e.baseAllocations)).toBe(33880n);
    expect(e.baseAllocations.m_d).toBe(0n);
    expect(e.baseAllocations).toEqual({ m_a: 11295n, m_b: 11291n, m_c: 11294n, m_d: 0n });
    expect(e.originalContributions).toEqual({ m_z: 10001n });
    expect(e.baseContributions).toEqual({ m_z: 33880n });
  });

  it("a one-minor-unit share never steals more than its proportion", () => {
    const e = compute({
      type: "EXPENSE",
      originalAmount: 10001n,
      originalExponent: 2,
      baseExponent: 2,
      conversion: { method: "MANUAL_RATE", rate: rateFromString("0.01") },
      payerMemberId: "m_a",
      splitMode: "EXACT",
      participants: { m_a: 10000n, m_b: 1n, m_c: 0n },
    });
    expect(e.baseAmount).toBe(100n);
    expect(e.baseAllocations).toEqual({ m_a: 100n, m_b: 0n, m_c: 0n });
  });
});

describe("computeEntry — validation", () => {
  const base: EntryComputationInput = {
    type: "EXPENSE",
    originalAmount: 1000n,
    originalExponent: 2,
    baseExponent: 2,
    conversion: { method: "IDENTITY" },
    payerMemberId: "m_a",
    splitMode: "EQUAL",
    participants: ["m_a", "m_b"],
  };
  const error = (patch: Partial<EntryComputationInput>) => {
    const r = computeEntry({ ...base, ...patch });
    return r.ok ? "OK" : r.error;
  };

  it("returns typed errors", () => {
    expect(error({ participants: [] })).toBe("NO_PARTICIPANTS");
    expect(error({ splitMode: "EXACT", participants: {} })).toBe("NO_PARTICIPANTS");
    expect(error({ splitMode: "EXACT", participants: { m_a: 500n, m_b: 499n } })).toBe("EXACT_SUM_MISMATCH");
    expect(error({ splitMode: "EXACT", participants: { m_a: 1001n, m_b: -1n } })).toBe("NEGATIVE_SHARE");
    expect(error({ originalExponent: 0 })).toBe("IDENTITY_EXPONENT_MISMATCH");
    expect(
      error({ originalExponent: 0, conversion: { method: "MANUAL_RATE", rate: rateFromString("0.001") }, originalAmount: 1n }),
    ).toBe("BASE_ROUNDS_TO_ZERO");
    expect(error({ conversion: { method: "MANUAL_RATE", rate: { num: 0n, den: 1n } } })).toBe("BASE_NOT_POSITIVE");
    expect(error({ conversion: { method: "ACTUAL_BASE_AMOUNT", baseAmount: 0n } })).toBe("BASE_NOT_POSITIVE");
    expect(error({ conversion: { method: "ACTUAL_BASE_AMOUNT", baseAmount: -5n } })).toBe("BASE_NOT_POSITIVE");
    expect(error({ originalAmount: MAX_MINOR + 1n })).toBe("TOO_LARGE");
    expect(error({ conversion: { method: "ACTUAL_BASE_AMOUNT", baseAmount: MAX_MINOR + 1n } })).toBe("TOO_LARGE");
    expect(error({ originalAmount: MAX_MINOR, conversion: { method: "MANUAL_RATE", rate: rateFromString("1.000000000001") } })).toBe(
      "TOO_LARGE",
    );
  });

  it("accepts boundary values", () => {
    expect(error({ originalAmount: MAX_MINOR })).toBe("OK");
    expect(error({ conversion: { method: "ACTUAL_BASE_AMOUNT", baseAmount: 1n } })).toBe("OK");
    expect(error({ originalExponent: 0, originalAmount: 1n, conversion: { method: "MANUAL_RATE", rate: rateFromString("0.005") } })).toBe("OK");
  });

  it("throws on violated preconditions", () => {
    expect(() => computeEntry({ ...base, originalAmount: 0n })).toThrow(RangeError);
    expect(() => computeEntry({ ...base, originalAmount: -1n })).toThrow(RangeError);
    expect(() => computeEntry({ ...base, splitMode: "EXACT" })).toThrow(TypeError);
    expect(() => computeEntry({ ...base, participants: { m_a: 1000n } })).toThrow(TypeError);
  });

  it("deduplicates EQUAL participants and allows a payer outside the split", () => {
    const e = compute({ ...base, payerMemberId: "m_x", participants: ["m_b", "m_a", "m_b"] });
    expect(e.originalAllocations).toEqual({ m_a: 500n, m_b: 500n });
    expect(nets(computeBalances([toBalanceEntry("EXPENSE", e)], ["m_a", "m_b", "m_x"]))).toEqual({
      m_a: -500n,
      m_b: -500n,
      m_x: 1000n,
    });
  });
});

describe("computeBalances", () => {
  const expense = compute(eurToPln("4.30"));

  it("refunds reverse the expense effects", () => {
    const refund = compute({ ...eurToPln("4.30"), type: "REFUND", originalAmount: 2000n });
    const balances = computeBalances(
      [toBalanceEntry("EXPENSE", expense), toBalanceEntry("REFUND", refund)],
      ["m_alice", "m_bob"],
    );
    expect(balances).toEqual([
      { memberId: "m_alice", paid: 43000n - 8600n, share: 21500n - 4300n, adjustments: 0n, net: 17200n },
      { memberId: "m_bob", paid: 0n, share: 21500n - 4300n, adjustments: 0n, net: -17200n },
    ]);
  });

  it("a full refund with the original conversion cancels the expense exactly", () => {
    const full = toBalanceEntry("REFUND", expense);
    const balances = computeBalances([toBalanceEntry("EXPENSE", expense), full], ["m_alice", "m_bob"]);
    expect(nets(balances)).toEqual({ m_alice: 0n, m_bob: 0n });
    expect(planSettlement(nets(balances))).toEqual([]);
  });

  it("adjustments add their signed effects", () => {
    const balances = computeBalances(
      [
        toBalanceEntry("EXPENSE", expense),
        { type: "ADJUSTMENT", baseContributions: {}, baseAllocations: {}, adjustmentEffects: { m_bob: 1500n, m_alice: -1500n } },
      ],
      ["m_alice", "m_bob"],
    );
    expect(balances).toEqual([
      { memberId: "m_alice", paid: 43000n, share: 21500n, adjustments: -1500n, net: 20000n },
      { memberId: "m_bob", paid: 0n, share: 21500n, adjustments: 1500n, net: -20000n },
    ]);
  });

  it("includes zero rows in memberIds order and appends unlisted referenced members", () => {
    const balances = computeBalances([toBalanceEntry("EXPENSE", expense)], ["m_zed", "m_bob"]);
    expect(balances.map((b) => [b.memberId, b.net])).toEqual([
      ["m_zed", 0n],
      ["m_bob", -21500n],
      ["m_alice", 21500n],
    ]);
    expect(computeBalances([], ["m_a"])).toEqual([{ memberId: "m_a", paid: 0n, share: 0n, adjustments: 0n, net: 0n }]);
  });

  it("throws on unbalanced entries", () => {
    expect(() =>
      computeBalances([{ type: "EXPENSE", baseContributions: { m_a: 100n }, baseAllocations: { m_a: 50n, m_b: 49n } }], []),
    ).toThrow();
    expect(() =>
      computeBalances([{ type: "ADJUSTMENT", baseContributions: {}, baseAllocations: {}, adjustmentEffects: { m_a: 1n } }], []),
    ).toThrow();
  });
});

describe("ledger properties", () => {
  const memberIds = ["m_a", "m_b", "m_c", "m_d", "m_e"];
  const member = fc.constantFrom(...memberIds);
  const exponent = fc.constantFrom(0, 2, 3);

  const conversionArb = fc.oneof(
    fc.constant({ method: "IDENTITY" as const }),
    fc
      .tuple(fc.bigInt({ min: 1n, max: 1_000_000_000n }), fc.integer({ min: 0, max: 6 }))
      .map(([digits, scale]) => ({ method: "MANUAL_RATE" as const, rate: rateFromString(scaleString(digits, scale)) })),
    fc.bigInt({ min: 1n, max: 10_000_000n }).map((baseAmount) => ({ method: "ACTUAL_BASE_AMOUNT" as const, baseAmount })),
  );

  const inputArb: fc.Arbitrary<EntryComputationInput> = fc
    .record({
      type: fc.constantFrom("EXPENSE" as const, "REFUND" as const),
      originalAmount: fc.bigInt({ min: 1n, max: 100_000_000n }),
      originalExponent: exponent,
      baseExponent: exponent,
      conversion: conversionArb,
      payerMemberId: member,
      equal: fc.boolean(),
      ids: fc.uniqueArray(member, { minLength: 1, maxLength: 5 }),
      weights: fc.array(fc.nat({ max: 5 }), { minLength: 5, maxLength: 5 }),
    })
    .map(({ equal, ids, weights, ...rest }) => {
      if (rest.conversion.method === "IDENTITY") rest.baseExponent = rest.originalExponent;
      if (equal) return { ...rest, splitMode: "EQUAL" as const, participants: ids };
      // EXACT: distribute originalAmount by weights (first id absorbs remainder); zeros allowed.
      const w = ids.map((_, i) => BigInt(weights[i]!));
      const W = w.reduce((a, b) => a + b, 0n) || 1n;
      const shares: Record<string, bigint> = {};
      let assigned = 0n;
      ids.forEach((id, i) => {
        const share = (rest.originalAmount * w[i]!) / W;
        shares[id] = share;
        assigned += share;
      });
      shares[ids[0]!]! += rest.originalAmount - assigned;
      return { ...rest, splitMode: "EXACT" as const, participants: shares };
    });

  it("computed entries preserve both totals and zero shares stay zero", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const r = computeEntry(input);
        if (!r.ok) {
          expect(["BASE_ROUNDS_TO_ZERO", "TOO_LARGE"]).toContain(r.error);
          return;
        }
        const e = r.value;
        expect(sumShares(e.originalAllocations)).toBe(input.originalAmount);
        expect(sumShares(e.baseAllocations)).toBe(e.baseAmount);
        expect(e.originalContributions).toEqual({ [input.payerMemberId]: input.originalAmount });
        expect(e.baseContributions).toEqual({ [input.payerMemberId]: e.baseAmount });
        expect(Object.keys(e.baseAllocations)).toEqual(Object.keys(e.originalAllocations));
        for (const [id, v] of Object.entries(e.originalAllocations)) {
          if (v === 0n) expect(e.baseAllocations[id]).toBe(0n);
          expect(e.baseAllocations[id]! >= 0n).toBe(true);
        }
        expect(e.baseAmount > 0n && e.baseAmount <= MAX_MINOR).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("balances always sum to zero and net = paid − share + adjustments", () => {
    const adjustmentArb = fc
      .tuple(member, member, fc.bigInt({ min: 1n, max: 1_000_000n }))
      .filter(([a, b]) => a !== b)
      .map(([a, b, v]): BalanceEntry => ({ type: "ADJUSTMENT", baseContributions: {}, baseAllocations: {}, adjustmentEffects: { [a]: v, [b]: -v } }));
    const entryArb = fc.oneof(
      inputArb.chain((input) => {
        const r = computeEntry(input);
        return r.ok ? fc.constant(toBalanceEntry(input.type, r.value)) : adjustmentArb;
      }),
      adjustmentArb,
    );
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 30 }), (entries) => {
        const balances = computeBalances(entries, memberIds);
        expect(balances.map((b) => b.memberId)).toEqual(memberIds);
        expect(balances.reduce((s, b) => s + b.net, 0n)).toBe(0n);
        for (const b of balances) expect(b.net).toBe(b.paid - b.share + b.adjustments);
        const transfers = planSettlement(nets(balances));
        const nonzero = balances.filter((b) => b.net !== 0n).length;
        expect(transfers.length).toBeLessThanOrEqual(Math.max(0, nonzero - 1));
      }),
      { numRuns: 300 },
    );
  });
});

function scaleString(digits: bigint, scale: number): string {
  const s = digits.toString().padStart(scale + 1, "0");
  return scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}
