/** Map of memberId → minor amount. Keys are member IDs. */
export type Shares = Record<string, bigint>;

/** Ascending lexicographic (code-unit) member-ID order, independent of locale. */
export function compareMemberIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sum of all values in a Shares map. */
export function sumShares(shares: Shares): bigint {
  let total = 0n;
  for (const v of Object.values(shares)) total += v;
  return total;
}

/**
 * Equal split of `total` minor units among memberIds (deduplicated).
 * Remainder units go one each to members in ascending member-ID order.
 * 10000n among [a,b,c] → {a:3334n, b:3333n, c:3333n}.
 * Result keys are in ascending member-ID order. Negative totals split symmetrically
 * (see apportion). Throws if memberIds is empty while total != 0.
 */
export function splitEqual(total: bigint, memberIds: readonly string[]): Shares {
  const weights: Shares = {};
  for (const id of memberIds) weights[id] = 1n;
  return apportion(total, weights);
}

/**
 * Apportion `total` proportionally to non-negative integer `weights`
 * using largest remainder; ties broken by ascending member ID.
 * Zero weights always receive 0. Sum of result === total exactly.
 * Throws if all weights are zero while total != 0.
 *
 * Every weight key appears in the result, in ascending member-ID order.
 * A negative total is apportioned as -apportion(-total), so magnitudes (and
 * which members get the extra unit) do not depend on sign. Throws on negative weights.
 */
export function apportion(total: bigint, weights: Shares): Shares {
  const ids = Object.keys(weights).sort(compareMemberIds);
  let weightSum = 0n;
  for (const id of ids) {
    const w = weights[id]!;
    if (w < 0n) throw new RangeError(`negative weight for ${id}`);
    weightSum += w;
  }
  const result: Shares = {};
  if (weightSum === 0n) {
    if (total !== 0n) throw new RangeError("cannot apportion a nonzero total over zero weights");
    for (const id of ids) result[id] = 0n;
    return result;
  }

  const sign = total < 0n ? -1n : 1n;
  const magnitude = total * sign;
  const remainders: { id: string; rem: bigint }[] = [];
  let assigned = 0n;
  for (const id of ids) {
    const product = magnitude * weights[id]!;
    const quota = product / weightSum;
    result[id] = quota;
    assigned += quota;
    if (weights[id]! > 0n) remainders.push({ id, rem: product % weightSum });
  }
  // Largest remainder first; equal remainders keep ascending ID order (ids are pre-sorted, sort is stable).
  remainders.sort((a, b) => (a.rem === b.rem ? 0 : a.rem > b.rem ? -1 : 1));
  let leftover = magnitude - assigned;
  for (const { id } of remainders) {
    if (leftover === 0n) break;
    result[id]! += 1n;
    leftover -= 1n;
  }
  if (sign < 0n) for (const id of ids) result[id] = -result[id]!;
  return result;
}
