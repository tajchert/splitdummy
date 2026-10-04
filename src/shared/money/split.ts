/** Map of memberId → minor amount. Keys are member IDs. */
export type Shares = Record<string, bigint>;

/**
 * Equal split of `total` minor units among memberIds (deduplicated).
 * Remainder units go one each to members in ascending member-ID order.
 * 10000n among [a,b,c] → {a:3334n, b:3333n, c:3333n}.
 */
export function splitEqual(total: bigint, memberIds: readonly string[]): Shares {
  throw new Error("not implemented");
}

/**
 * Apportion `total` proportionally to non-negative integer `weights`
 * using largest remainder; ties broken by ascending member ID.
 * Zero weights always receive 0. Sum of result === total exactly.
 * Throws if all weights are zero while total != 0.
 */
export function apportion(total: bigint, weights: Shares): Shares {
  throw new Error("not implemented");
}
