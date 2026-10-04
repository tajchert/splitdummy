import { MAX_MINOR } from "./amount";
import { assertExponent } from "./decimal";
import { convertToBase, deriveDisplayRate, rateToString, type Rational } from "./rate";
import { apportion, compareMemberIds, splitEqual, sumShares, type Shares } from "./split";

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

/**
 * Compute the full stored effect of an expense/refund per spec §5 (Stored conversion and rounding).
 *
 * - Original allocations: EQUAL → splitEqual over the (deduplicated) participants;
 *   EXACT → the given shares (zeros kept as explicit 0 rows).
 * - Base total: IDENTITY → same amount, rate "1"; MANUAL_RATE → convertToBase, canonical rate string;
 *   ACTUAL_BASE_AMOUNT → the given base amount, derived 6-digit display rate.
 * - Base allocations: base total apportioned (largest remainder, ascending ID) over the
 *   original allocations, so zero original shares get zero base and both totals are exact.
 * - Contributions: the payer contributes the full original and base amount.
 *
 * Preconditions (thrown, not returned — the API schemas already enforce them):
 * originalAmount > 0, valid exponents, `participants` is an array for EQUAL and a Shares map for EXACT.
 * A MANUAL_RATE rate must be a positive terminating decimal (as produced by parseRate);
 * a nonpositive rate is reported as BASE_NOT_POSITIVE.
 */
export function computeEntry(
  input: EntryComputationInput,
): { ok: true; value: ComputedEntry } | { ok: false; error: EntryComputationError } {
  const { originalAmount, originalExponent, baseExponent, conversion, payerMemberId, splitMode, participants } = input;
  assertExponent(originalExponent);
  assertExponent(baseExponent);
  if (originalAmount <= 0n) throw new RangeError("originalAmount must be > 0");
  if (originalAmount > MAX_MINOR) return { ok: false, error: "TOO_LARGE" };

  let originalAllocations: Shares;
  if (splitMode === "EQUAL") {
    if (!Array.isArray(participants)) throw new TypeError("EQUAL split requires a participant ID list");
    const ids = participants as readonly string[];
    if (ids.length === 0) return { ok: false, error: "NO_PARTICIPANTS" };
    originalAllocations = splitEqual(originalAmount, ids);
  } else {
    if (Array.isArray(participants)) throw new TypeError("EXACT split requires a member → amount map");
    const shares = participants as Shares;
    const ids = Object.keys(shares).sort(compareMemberIds);
    if (ids.length === 0) return { ok: false, error: "NO_PARTICIPANTS" };
    originalAllocations = {};
    for (const id of ids) {
      const v = shares[id]!;
      if (v < 0n) return { ok: false, error: "NEGATIVE_SHARE" };
      originalAllocations[id] = v;
    }
    if (sumShares(originalAllocations) !== originalAmount) return { ok: false, error: "EXACT_SUM_MISMATCH" };
  }

  let baseAmount: bigint;
  let rateString: string;
  switch (conversion.method) {
    case "IDENTITY":
      if (originalExponent !== baseExponent) return { ok: false, error: "IDENTITY_EXPONENT_MISMATCH" };
      baseAmount = originalAmount;
      rateString = "1";
      break;
    case "MANUAL_RATE":
      if (conversion.rate.num <= 0n || conversion.rate.den <= 0n) return { ok: false, error: "BASE_NOT_POSITIVE" };
      baseAmount = convertToBase(originalAmount, conversion.rate, originalExponent, baseExponent);
      if (baseAmount === 0n) return { ok: false, error: "BASE_ROUNDS_TO_ZERO" };
      rateString = rateToString(conversion.rate);
      break;
    case "ACTUAL_BASE_AMOUNT":
      baseAmount = conversion.baseAmount;
      if (baseAmount <= 0n) return { ok: false, error: "BASE_NOT_POSITIVE" };
      if (baseAmount > MAX_MINOR) return { ok: false, error: "TOO_LARGE" };
      rateString = deriveDisplayRate(originalAmount, baseAmount, originalExponent, baseExponent);
      break;
  }
  if (baseAmount > MAX_MINOR) return { ok: false, error: "TOO_LARGE" };

  return {
    ok: true,
    value: {
      baseAmount,
      originalContributions: { [payerMemberId]: originalAmount },
      baseContributions: { [payerMemberId]: baseAmount },
      originalAllocations,
      baseAllocations: apportion(baseAmount, originalAllocations),
      rateString,
    },
  };
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
 *
 * Rows follow `memberIds` order; members referenced by entries but missing from
 * `memberIds` are appended in ascending ID order (money never disappears).
 * ADJUSTMENT entries contribute only `adjustmentEffects`. Each entry must balance
 * on its own (contributions == allocations, effects sum to 0), otherwise this throws.
 */
export function computeBalances(entries: readonly BalanceEntry[], memberIds: readonly string[]): MemberBalance[] {
  const rows = new Map<string, MemberBalance>();
  const row = (memberId: string): MemberBalance => {
    let r = rows.get(memberId);
    if (!r) {
      r = { memberId, paid: 0n, share: 0n, adjustments: 0n, net: 0n };
      rows.set(memberId, r);
    }
    return r;
  };
  for (const id of memberIds) row(id);
  const known = new Set(rows.keys());

  entries.forEach((entry, index) => {
    if (entry.type === "ADJUSTMENT") {
      const effects = entry.adjustmentEffects ?? {};
      if (sumShares(effects) !== 0n) throw new Error(`adjustment entry #${index} does not sum to zero`);
      for (const [id, v] of Object.entries(effects)) row(id).adjustments += v;
      return;
    }
    if (sumShares(entry.baseContributions) !== sumShares(entry.baseAllocations)) {
      throw new Error(`entry #${index} contributions and allocations differ`);
    }
    const sign = entry.type === "REFUND" ? -1n : 1n;
    for (const [id, v] of Object.entries(entry.baseContributions)) row(id).paid += sign * v;
    for (const [id, v] of Object.entries(entry.baseAllocations)) row(id).share += sign * v;
  });

  const extra = [...rows.keys()].filter((id) => !known.has(id)).sort(compareMemberIds);
  const ordered = [...known, ...extra].map((id) => rows.get(id)!);
  let total = 0n;
  for (const r of ordered) {
    r.net = r.paid - r.share + r.adjustments;
    total += r.net;
  }
  if (total !== 0n) throw new Error(`balances do not sum to zero (${total})`);
  return ordered;
}
