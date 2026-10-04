import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SETTLEMENT_ALGORITHM_VERSION, planSettlement } from "./settlement";

describe("planSettlement", () => {
  it("exposes the algorithm version", () => {
    expect(SETTLEMENT_ALGORITHM_VERSION).toBe("greedy-largest-v1");
  });

  it("settles a single debt", () => {
    expect(planSettlement({ m_alice: 21500n, m_bob: -21500n })).toEqual([{ from: "m_bob", to: "m_alice", amount: 21500n }]);
  });

  it("matches largest debtor with largest creditor", () => {
    expect(planSettlement({ m_a: 100n, m_b: 50n, m_c: -70n, m_d: -80n })).toEqual([
      { from: "m_d", to: "m_a", amount: 80n },
      { from: "m_c", to: "m_b", amount: 50n },
      { from: "m_c", to: "m_a", amount: 20n },
    ]);
  });

  it("breaks ties by ascending member ID on both sides", () => {
    expect(planSettlement({ m_d: -50n, m_b: 50n, m_c: -50n, m_a: 50n })).toEqual([
      { from: "m_c", to: "m_a", amount: 50n },
      { from: "m_d", to: "m_b", amount: 50n },
    ]);
  });

  it("returns no transfers for a zero-balance group", () => {
    expect(planSettlement({})).toEqual([]);
    expect(planSettlement({ m_a: 0n, m_b: 0n })).toEqual([]);
  });

  it("ignores zero members", () => {
    expect(planSettlement({ m_a: 0n, m_b: 10n, m_c: -10n })).toEqual([{ from: "m_c", to: "m_b", amount: 10n }]);
  });

  it("throws when nets do not sum to zero", () => {
    expect(() => planSettlement({ m_a: 10n, m_b: -9n })).toThrow();
  });

  const netsArb = fc
    .array(fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }), { minLength: 1, maxLength: 25 })
    .chain((values) =>
      fc.constantFrom(0n, 1n, -1n).map((zeroBias) => {
        const nets: Record<string, bigint> = {};
        let sum = 0n;
        values.forEach((v, i) => {
          const value = zeroBias !== 0n && i % 3 === 0 ? 0n : v;
          nets[`m_${String(i).padStart(2, "0")}`] = value;
          sum += value;
        });
        nets["m_last"] = -sum;
        return nets;
      }),
    );

  it("settles every net with at most n−1 positive transfers; members only send or only receive (property)", () => {
    fc.assert(
      fc.property(netsArb, (nets) => {
        const transfers = planSettlement(nets);
        const remaining = { ...nets };
        const senders = new Set<string>();
        const receivers = new Set<string>();
        for (const t of transfers) {
          expect(t.amount > 0n).toBe(true);
          expect(nets[t.from]! < 0n && nets[t.to]! > 0n).toBe(true);
          remaining[t.from]! += t.amount;
          remaining[t.to]! -= t.amount;
          senders.add(t.from);
          receivers.add(t.to);
        }
        for (const v of Object.values(remaining)) expect(v).toBe(0n);
        for (const s of senders) expect(receivers.has(s)).toBe(false);
        const nonzero = Object.values(nets).filter((v) => v !== 0n).length;
        expect(transfers.length).toBeLessThanOrEqual(Math.max(0, nonzero - 1));
      }),
      { numRuns: 1000 },
    );
  });

  it("is deterministic regardless of key order (property)", () => {
    fc.assert(
      fc.property(netsArb, fc.integer(), (nets, seed) => {
        const entries = Object.entries(nets);
        // deterministic shuffle from seed
        const shuffled = entries
          .map((e, i) => ({ e, k: (Math.imul(i + 1, 2654435761) ^ seed) >>> 0 }))
          .sort((a, b) => a.k - b.k)
          .map((x) => x.e);
        expect(planSettlement(Object.fromEntries(shuffled))).toEqual(planSettlement(nets));
      }),
      { numRuns: 300 },
    );
  });
});
