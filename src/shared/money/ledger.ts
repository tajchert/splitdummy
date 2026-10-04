import type { Rational } from "./rate";
import type { Shares } from "./split";

export type EntryType = "EXPENSE" | "REFUND" | "ADJUSTMENT";
export type SplitMode = "EQUAL" | "EXACT";
export type ConversionMethod = "IDENTITY" | "MANUAL_RATE" | "ACTUAL_BASE_AMOUNT";

export type ConversionInput =
  | { method: "IDENTITY" }
  | { method: "MANUAL_RATE"; rate: Rational }
  | { method: "ACTUAL_BASE_AMOUNT"; baseAmount: bigint };

export interface EntryComputationInput {
  type: "EXPENSE" | "REFUND";
  originalAmount: bigint; // > 0
  originalExponent: number;
  baseExponent: number;
  /** IDENTITY requires original currency == base currency (caller checks codes); exponents must match. */
  conversion: ConversionInput;
  /** EXPENSE: who paid. REFUND: who received the refunded money. */
  payerMemberId: string;
  splitMode: SplitMode;
  /** EQUAL: memberIds share equally. EXACT: per-member original minor amounts (must sum to originalAmount; zeros allowed). */
  participants: readonly string[] | Shares;
}

export type EntryComputationError =
  | "NO_PARTICIPANTS"
  | "EXACT_SUM_MISMATCH"
  | "NEGATIVE_SHARE"
  | "IDENTITY_EXPONENT_MISMATCH"
  | "BASE_ROUNDS_TO_ZERO"
  | "BASE_NOT_POSITIVE"
  | "TOO_LARGE";

export interface ComputedEntry {
  baseAmount: bigint;
  /** Contributions (payer). Original + base. */
  originalContributions: Shares;
  baseContributions: Shares;
  /** Allocations (beneficiaries). Original + base; base apportioned from original allocations. */
  originalAllocations: Shares;
  baseAllocations: Shares;
  /** For MANUAL_RATE/IDENTITY the stored rate string; for ACTUAL_BASE_AMOUNT a derived display rate. */
  rateString: string;
}

/** Compute the full stored effect of an expense/refund per spec §5 (Stored conversion and rounding). */
export function computeEntry(
  input: EntryComputationInput,
): { ok: true; value: ComputedEntry } | { ok: false; error: EntryComputationError } {
  throw new Error("not implemented");
}

/** Minimal stored shape needed to compute balances. */
export interface BalanceEntry {
  type: EntryType;
  baseContributions: Shares; // EXPENSE/REFUND: payer → baseAmount
  baseAllocations: Shares;
  /** ADJUSTMENT only: explicit signed effects that sum to zero. */
  adjustmentEffects?: Shares;
}

export interface MemberBalance {
  memberId: string;
  /** Sum of base contributions on expenses minus refunds received (signed). */
  paid: bigint;
  /** Sum of base allocations on expenses minus refund credits (signed). */
  share: bigint;
  /** Adjustment effects (signed). */
  adjustments: bigint;
  /** net = paid - share + adjustments. Positive: receives money. */
  net: bigint;
}

/**
 * balance[m] += contribution - allocation for EXPENSE; reversed for REFUND;
 * ADJUSTMENT adds adjustmentEffects. Includes every member in `memberIds`
 * (zero rows allowed). Throws if the net sum is not exactly zero.
 */
export function computeBalances(entries: readonly BalanceEntry[], memberIds: readonly string[]): MemberBalance[] {
  throw new Error("not implemented");
}
