/** Read-model builders: storage rows → api.ts DTOs. Pure reads; never mutate. */
import type {
  AmountSplitDTO,
  AuditEventDTO,
  BalanceDTO,
  CurrencySubtotalDTO,
  EntryDTO,
  InstructionDTO,
  InvitationDTO,
  MemberDTO,
  ProjectDTO,
  ProjectViewDTO,
  RateDefaultDTO,
  ReadinessDTO,
  ReviewDTO,
  RoundDTO,
  RoundViewDTO,
} from "@shared/api";
import { computeBalances, planSettlement, type BalanceEntry, type MemberBalance, type Shares } from "@shared/money";
import type {
  AuditRow,
  InstructionRow,
  InvitationRow,
  LoadedEntry,
  MemberRow,
  ProjectRow,
  RateRow,
  RoundRow,
  Store,
} from "./store";

/** Frozen at freeze time; the authoritative record of what was settled. */
export interface SnapshotData {
  algorithmVersion: string;
  ledgerVersion: number;
  reviewVersion: number;
  cutoffAt: string;
  frozenByMemberId: string;
  members: { id: string; displayName: string; isOwner: boolean; status: string }[];
  readiness: ReadinessDTO[];
  acknowledgedNotReady: string[];
  earlyFreezeReason: string | null;
  rates: RateDefaultDTO[];
  entries: EntryDTO[];
  balances: { memberId: string; paid: string; share: string; adjustments: string; net: string }[];
  instructions: { id: string; fromMemberId: string; toMemberId: string; amount: string }[];
}

export function projectDto(p: ProjectRow): ProjectDTO {
  return {
    id: p.id,
    name: p.name,
    ownerMemberId: p.owner_member_id,
    pendingOwnerMemberId: p.pending_owner_member_id,
    baseCurrency: p.base_currency,
    baseExponent: p.base_exponent,
    multiCurrencyEnabled: p.multi_currency_enabled === 1,
    membersCanRename: p.members_can_rename === 1,
    baseCurrencyLocked: p.base_currency_locked === 1,
    activeRoundId: p.active_round_id,
    version: p.version,
    createdAt: p.created_at,
  };
}

export function memberDto(m: MemberRow, p: ProjectRow, referenced: boolean, viewerIsOwner = false, now = new Date().toISOString()): MemberDTO {
  const placeholder = m.kind === "PLACEHOLDER";
  const invited = placeholder && m.invited_email !== null && m.invite_expires_at !== null;
  return {
    id: m.id,
    displayName: m.display_name,
    isOwner: p.owner_member_id === m.id,
    isGuest: m.is_guest === 1,
    hasRecoverableAccount: m.has_recoverable_account === 1,
    joinedAt: m.joined_at,
    status: m.status,
    referenced,
    accountDeleted: m.account_deleted === 1,
    kind: m.kind,
    inviteState: invited ? (Date.parse(m.invite_expires_at!) > Date.parse(now) ? "INVITED" : "INVITE_EXPIRED") : null,
    inviteExpiresAt: invited ? m.invite_expires_at : null,
    ...(viewerIsOwner ? { invitedEmail: placeholder ? m.invited_email : null } : {}),
  };
}

export function roundDto(r: RoundRow): RoundDTO {
  return {
    id: r.id,
    sequence: r.sequence,
    status: r.status,
    ledgerVersion: r.ledger_version,
    reviewVersion: r.review_version,
    createdAt: r.created_at,
    frozenAt: r.frozen_at,
    settledAt: r.settled_at,
    earlyFreezeReason: r.early_freeze_reason,
    frozenByMemberId: r.frozen_by_member_id,
    scheduledFreezeDate: r.scheduled_freeze_date,
    scheduledFreezeTimeZone: r.scheduled_freeze_time_zone,
    scheduledFreezeAt: r.scheduled_freeze_at,
    frozenBySchedule: r.frozen_by_schedule === 1,
  };
}

export function rateDto(r: RateRow): RateDefaultDTO {
  return { currency: r.currency, rate: r.rate, setByMemberId: r.set_by_member_id, setAt: r.set_at, revision: r.revision };
}

export function invitationDto(i: InvitationRow): InvitationDTO {
  return { id: i.id, createdAt: i.created_at, expiresAt: i.expires_at, revokedAt: i.revoked_at };
}

export function instructionDto(i: InstructionRow): InstructionDTO {
  return {
    id: i.id,
    roundId: i.round_id,
    fromMemberId: i.from_member_id,
    toMemberId: i.to_member_id,
    amount: i.amount,
    currency: i.currency,
    exponent: i.exponent,
    state: i.state,
    sentAt: i.sent_at,
    confirmedAt: i.confirmed_at,
    disputedAt: i.disputed_at,
    disputeNote: i.dispute_note,
    revision: i.revision,
  };
}

export function auditDto(a: AuditRow): AuditEventDTO {
  return {
    id: a.id,
    at: a.at,
    actorMemberId: a.actor_member_id,
    action: a.action,
    roundId: a.round_id,
    entityId: a.entity_id,
    summary: a.summary,
    details: a.details_json ? (JSON.parse(a.details_json) as Record<string, unknown>) : null,
  };
}

export function entryDto(e: LoadedEntry): EntryDTO {
  const r = e.row;
  const split = (s: { member_id: string; original_amount: string; base_amount: string }): AmountSplitDTO => ({
    memberId: s.member_id,
    originalAmount: s.original_amount,
    baseAmount: s.base_amount,
  });
  return {
    id: r.id,
    roundId: r.round_id,
    type: r.type,
    creatorMemberId: r.creator_member_id,
    lastEditedByMemberId: r.last_edited_by_member_id,
    occurredAt: r.occurred_at,
    description: r.description,
    originalAmount: r.original_amount,
    originalCurrency: r.original_currency,
    originalExponent: r.original_exponent,
    baseAmount: r.base_amount,
    baseCurrency: r.base_currency,
    baseExponent: r.base_exponent,
    conversion: {
      method: r.conversion_method,
      rate: r.rate,
      rateSource: r.rate_source,
      rateSetByMemberId: r.rate_set_by_member_id,
      rateSetAt: r.rate_set_at,
      note: r.conversion_note,
    },
    payerMemberId: r.payer_member_id,
    splitMode: r.split_mode,
    contributions: e.contributions.map(split),
    allocations: e.allocations.map(split),
    adjustmentEffects:
      r.type === "ADJUSTMENT"
        ? e.effects.map((x) => ({ memberId: x.member_id, originalAmount: x.base_amount, baseAmount: x.base_amount }))
        : null,
    correctedEntryId: r.corrected_entry_id,
    correctedRoundId: r.corrected_round_id,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function shares(list: AmountSplitDTO[]): Shares {
  const out: Shares = {};
  for (const s of list) out[s.memberId] = BigInt(s.baseAmount);
  return out;
}

export function balanceEntry(e: EntryDTO): BalanceEntry {
  return e.type === "ADJUSTMENT"
    ? { type: "ADJUSTMENT", baseContributions: {}, baseAllocations: {}, adjustmentEffects: shares(e.adjustmentEffects ?? []) }
    : { type: e.type, baseContributions: shares(e.contributions), baseAllocations: shares(e.allocations) };
}

/** Every member who can hold a balance: non-removed members plus anyone an entry mentions. */
export function balanceMemberIds(members: MemberRow[], entries: EntryDTO[]): string[] {
  const ids = new Set(members.filter((m) => m.status !== "REMOVED").map((m) => m.id));
  for (const e of entries) {
    for (const s of [...e.contributions, ...e.allocations, ...(e.adjustmentEffects ?? [])]) ids.add(s.memberId);
  }
  return [...ids].sort();
}

export function computeRoundBalances(members: MemberRow[], entries: EntryDTO[]): MemberBalance[] {
  return computeBalances(entries.map(balanceEntry), balanceMemberIds(members, entries));
}

function totals(entries: EntryDTO[]): RoundViewDTO["totals"] {
  let expenses = 0n;
  let refunds = 0n;
  let adjustments = 0n;
  for (const e of entries) {
    if (e.type === "EXPENSE") expenses += BigInt(e.baseAmount);
    else if (e.type === "REFUND") refunds += BigInt(e.baseAmount);
    else adjustments += BigInt(e.baseAmount);
  }
  return { expenses: expenses.toString(), refunds: refunds.toString(), adjustments: adjustments.toString() };
}

function currencySubtotals(entries: EntryDTO[]): CurrencySubtotalDTO[] {
  const map = new Map<string, { exponent: number; expenses: bigint; refunds: bigint; base: bigint }>();
  for (const e of entries) {
    if (e.type === "ADJUSTMENT") continue;
    const s = map.get(e.originalCurrency) ?? { exponent: e.originalExponent, expenses: 0n, refunds: 0n, base: 0n };
    if (e.type === "EXPENSE") {
      s.expenses += BigInt(e.originalAmount);
      s.base += BigInt(e.baseAmount);
    } else {
      s.refunds += BigInt(e.originalAmount);
      s.base -= BigInt(e.baseAmount);
    }
    map.set(e.originalCurrency, s);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, s]) => ({
      currency,
      exponent: s.exponent,
      expenses: s.expenses.toString(),
      refunds: s.refunds.toString(),
      baseEquivalent: s.base.toString(),
    }));
}

function balanceDto(b: { memberId: string; paid: string; share: string; adjustments: string; net: string }): BalanceDTO {
  return { ...b, confirmedProgress: null, remaining: null };
}

function memberBalanceJson(b: MemberBalance) {
  return {
    memberId: b.memberId,
    paid: b.paid.toString(),
    share: b.share.toString(),
    adjustments: b.adjustments.toString(),
    net: b.net.toString(),
  };
}

export function snapshotBalances(balances: MemberBalance[]): SnapshotData["balances"] {
  return balances.map(memberBalanceJson);
}

/** Members expected to mark readiness: currently ACTIVE members whose account still exists. */
export function readinessList(store: Store, roundId: string): ReadinessDTO[] {
  const rows = new Map(store.readiness(roundId).map((r) => [r.member_id, r]));
  return store
    .members()
    .filter((m) => m.status === "ACTIVE" && m.account_deleted !== 1)
    .map((m) => {
      const r = rows.get(m.id);
      return { memberId: m.id, ready: r?.ready === 1, markedAt: r?.marked_at ?? null };
    });
}

export function snapshotOf(store: Store, roundId: string): SnapshotData | undefined {
  const row = store.snapshot(roundId);
  return row ? (JSON.parse(row.snapshot_json) as SnapshotData) : undefined;
}

export function roundView(store: Store, round: RoundRow): RoundViewDTO {
  if (round.status === "COLLECTING") {
    const entries = store.roundEntries(round.id).map(entryDto);
    const balances = computeRoundBalances(store.members(), entries).map((b) => balanceDto(memberBalanceJson(b)));
    return {
      round: roundDto(round),
      entries,
      readiness: readinessList(store, round.id),
      balances,
      instructions: [],
      totals: totals(entries),
      currencySubtotals: currencySubtotals(entries),
    };
  }
  const snap = snapshotOf(store, round.id);
  if (!snap) throw new Error(`missing snapshot for frozen round ${round.id}`);
  const instructions = store.instructions(round.id);
  const progress = new Map<string, bigint>();
  for (const i of instructions) {
    if (i.state !== "CONFIRMED") continue;
    const amount = BigInt(i.amount);
    progress.set(i.to_member_id, (progress.get(i.to_member_id) ?? 0n) + amount);
    progress.set(i.from_member_id, (progress.get(i.from_member_id) ?? 0n) - amount);
  }
  return {
    round: roundDto(round),
    entries: snap.entries,
    readiness: snap.readiness,
    balances: snap.balances.map((b) => {
      const p = progress.get(b.memberId) ?? 0n;
      return { ...b, confirmedProgress: p.toString(), remaining: (BigInt(b.net) - p).toString() };
    }),
    instructions: instructions.map(instructionDto),
    totals: totals(snap.entries),
    currencySubtotals: currencySubtotals(snap.entries),
  };
}

export function reviewView(store: Store, round: RoundRow): ReviewDTO {
  const view = roundView(store, round);
  const nets: Record<string, bigint> = {};
  for (const b of view.balances) nets[b.memberId] = BigInt(b.net);
  return {
    roundId: round.id,
    reviewVersion: round.review_version,
    ledgerVersion: round.ledger_version,
    notReadyMemberIds: view.readiness.filter((r) => !r.ready).map((r) => r.memberId),
    view,
    proposedTransfers: planSettlement(nets).map((t) => ({
      fromMemberId: t.from,
      toMemberId: t.to,
      amount: t.amount.toString(),
    })),
  };
}

export function projectView(store: Store, me: MemberRow): ProjectViewDTO {
  const project = store.project()!;
  const isOwner = project.owner_member_id === me.id;
  const referenced = store.referencedMemberIds();
  const rounds = store.rounds();
  const current = rounds.find((r) => r.id === project.active_round_id) ?? rounds[0]!;
  return {
    project: projectDto(project),
    me: { memberId: me.id, isOwner },
    members: store.members().map((m) => memberDto(m, project, referenced.has(m.id), isOwner)),
    rates: store.rates().map(rateDto),
    current: roundView(store, current),
    rounds: rounds.map(roundDto),
    invitations: isOwner
      ? store.all<InvitationRow>("SELECT * FROM invitations ORDER BY created_at DESC, id").map(invitationDto)
      : null,
  };
}
