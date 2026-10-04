export const SETTLEMENT_ALGORITHM_VERSION = "greedy-largest-v1";

export interface PlannedTransfer {
  from: string; // debtor member ID
  to: string; // creditor member ID
  amount: bigint; // > 0, base minor units
}

/**
 * Greedy largest-debtor/largest-creditor matching (spec §9).
 * Ties: ascending member ID. At most n-1 transfers for n nonzero members.
 * Input nets must sum to zero (throws otherwise). Deterministic order of output.
 */
export function planSettlement(nets: Record<string, bigint>): PlannedTransfer[] {
  throw new Error("not implemented");
}
