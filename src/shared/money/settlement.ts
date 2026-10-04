import { compareMemberIds } from "./split";

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
  const positions: { id: string; amount: bigint }[] = [];
  let total = 0n;
  for (const [id, amount] of Object.entries(nets)) {
    total += amount;
    if (amount !== 0n) positions.push({ id, amount });
  }
  if (total !== 0n) throw new Error(`settlement nets do not sum to zero (${total})`);
  positions.sort((a, b) => compareMemberIds(a.id, b.id));

  // Largest |balance| on the given side; first (= lowest ID) wins ties.
  const pick = (side: 1n | -1n) => {
    let best: { id: string; amount: bigint } | undefined;
    for (const p of positions) {
      if (p.amount * side > 0n && (!best || p.amount * side > best.amount * side)) best = p;
    }
    return best;
  };

  const transfers: PlannedTransfer[] = [];
  for (;;) {
    const debtor = pick(-1n);
    const creditor = pick(1n);
    if (!debtor || !creditor) break;
    const amount = -debtor.amount < creditor.amount ? -debtor.amount : creditor.amount;
    transfers.push({ from: debtor.id, to: creditor.id, amount });
    debtor.amount += amount;
    creditor.amount -= amount;
  }
  return transfers;
}
