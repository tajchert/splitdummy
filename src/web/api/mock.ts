/**
 * In-memory implementation of the Api for `VITE_MOCK=1 npm run dev`.
 * Never imported by production builds (main.tsx imports it behind a static env check).
 * Seeded with the design's "Lisbon trip" demo; you are Maya, the owner.
 */
import type {
  AuditEventDTO,
  BalanceDTO,
  CurrencySubtotalDTO,
  DeletionPreviewDTO,
  EntryDTO,
  InstructionDTO,
  InvitationDTO,
  InvitationPreviewDTO,
  MeDTO,
  MemberDTO,
  ProjectDTO,
  ProjectSummaryDTO,
  ProjectViewDTO,
  RateDefaultDTO,
  ReviewDTO,
  RoundDTO,
  RoundViewDTO,
} from "@shared/api";
import {
  AdjustmentInputSchema,
  CreateProjectSchema,
  DeleteAccountSchema,
  EntryInputSchema,
  FreezeScheduleSchema,
  FreezeSchema,
  JoinSchema,
  RenameMemberSchema,
  UpdateMeSchema,
  UpdateSettingsSchema,
} from "@shared/api";
import { computeBalances, computeEntry, getCurrency, planSettlement, rateFromString, type BalanceEntry, type Shares } from "@shared/money";
import { createElement, useState, type ComponentType } from "react";
import { ApiError } from "./errors";
import type { Api, EntryBody, LiveHandlers, MutationOptions } from "./types";

// ---------- state ----------

interface MockRound {
  round: RoundDTO;
  entries: EntryDTO[];
  deleted: string[];
  readiness: Record<string, { ready: boolean; markedAt: string | null }>;
  instructions: InstructionDTO[];
}

interface MockProject {
  project: ProjectDTO;
  members: MemberDTO[];
  principals: Record<string, string>; // memberId → principalId
  rates: RateDefaultDTO[];
  rounds: MockRound[]; // oldest first
  invitations: (InvitationDTO & { token: string })[];
  events: AuditEventDTO[];
  pendingOwnership: string | null;
}

interface Principal {
  id: string;
  kind: "ACCOUNT" | "GUEST";
  email: string | null;
  displayName: string | null;
}

interface State {
  me: string | null; // principal id
  principals: Record<string, Principal>;
  projects: Record<string, MockProject>;
}

const STORAGE = "splitdummy-mock-v2";
const now = () => new Date().toISOString();
const uid = (p: string) => `${p}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
const exp = (code: string) => getCurrency(code)?.exponent ?? 2;

function blankRound(sequence: number, createdAt: string): RoundDTO {
  return {
    id: uid("r_"),
    sequence,
    status: "COLLECTING",
    ledgerVersion: 0,
    reviewVersion: 0,
    createdAt,
    frozenAt: null,
    settledAt: null,
    earlyFreezeReason: null,
    frozenByMemberId: null,
    scheduledFreezeDate: null,
    scheduledFreezeTimeZone: null,
    scheduledFreezeAt: null,
    frozenBySchedule: false,
  };
}

/** "YYYY-MM-DD" as the calendar date in `timeZone` right now. */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** The instant the day after `ymd` starts in `timeZone` (i.e. the end of `ymd` there). */
function endOfDayIn(ymd: string, timeZone: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y!, m! - 1, d! + 1);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(guess))
      .map((x) => [x.type, Number(x.value)]),
  );
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return new Date(guess - (asUtc - guess)).toISOString();
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function fail(status: number, code: ApiError["code"], message: string, field?: string, details?: Record<string, unknown>): never {
  throw new ApiError(status, code, message, field, details);
}

// ---------- accounting helpers (shared core does the math) ----------

const toShares = (rows: { memberId: string; baseAmount: string }[]): Shares => Object.fromEntries(rows.map((r) => [r.memberId, BigInt(r.baseAmount)]));

function balanceEntries(r: MockRound): BalanceEntry[] {
  return r.entries.map((e) => ({
    type: e.type,
    baseContributions: toShares(e.contributions),
    baseAllocations: toShares(e.allocations),
    adjustmentEffects: e.adjustmentEffects ? toShares(e.adjustmentEffects) : undefined,
  }));
}

function memberIdsFor(p: MockProject, r: MockRound): string[] {
  const ids = new Set(p.members.filter((m) => m.status === "ACTIVE").map((m) => m.id));
  for (const e of r.entries) for (const x of [...e.contributions, ...e.allocations, ...(e.adjustmentEffects ?? [])]) ids.add(x.memberId);
  for (const i of r.instructions) (ids.add(i.fromMemberId), ids.add(i.toMemberId));
  return [...ids].sort();
}

function roundView(p: MockProject, r: MockRound): RoundViewDTO {
  const ids = memberIdsFor(p, r);
  const bal = computeBalances(balanceEntries(r), ids);
  const settling = r.round.status !== "COLLECTING";
  const balances: BalanceDTO[] = bal.map((b) => {
    let progress = 0n;
    if (settling)
      for (const i of r.instructions) {
        if (i.state !== "CONFIRMED") continue;
        if (i.toMemberId === b.memberId) progress += BigInt(i.amount);
        if (i.fromMemberId === b.memberId) progress -= BigInt(i.amount);
      }
    return {
      memberId: b.memberId,
      paid: b.paid.toString(),
      share: b.share.toString(),
      adjustments: b.adjustments.toString(),
      net: b.net.toString(),
      confirmedProgress: settling ? progress.toString() : null,
      remaining: settling ? (b.net - progress).toString() : null,
    };
  });
  let expenses = 0n,
    refunds = 0n,
    adjustments = 0n;
  const subs = new Map<string, CurrencySubtotalDTO>();
  for (const e of r.entries) {
    if (e.type === "ADJUSTMENT") {
      for (const x of e.adjustmentEffects ?? []) if (BigInt(x.baseAmount) > 0n) adjustments += BigInt(x.baseAmount);
      continue;
    }
    const s = subs.get(e.originalCurrency) ?? { currency: e.originalCurrency, exponent: e.originalExponent, expenses: "0", refunds: "0", baseEquivalent: "0" };
    if (e.type === "EXPENSE") {
      expenses += BigInt(e.baseAmount);
      s.expenses = (BigInt(s.expenses) + BigInt(e.originalAmount)).toString();
      s.baseEquivalent = (BigInt(s.baseEquivalent) + BigInt(e.baseAmount)).toString();
    } else {
      refunds += BigInt(e.baseAmount);
      s.refunds = (BigInt(s.refunds) + BigInt(e.originalAmount)).toString();
      s.baseEquivalent = (BigInt(s.baseEquivalent) - BigInt(e.baseAmount)).toString();
    }
    subs.set(e.originalCurrency, s);
  }
  const active = p.members.filter((m) => m.status === "ACTIVE");
  return {
    round: { ...r.round },
    entries: r.entries.map((e) => ({ ...e })),
    readiness: active.map((m) => ({ memberId: m.id, ready: r.readiness[m.id]?.ready ?? false, markedAt: r.readiness[m.id]?.markedAt ?? null })),
    balances,
    instructions: r.instructions.map((i) => ({ ...i })),
    totals: { expenses: expenses.toString(), refunds: refunds.toString(), adjustments: adjustments.toString() },
    currencySubtotals: [...subs.values()].sort((a, b) => (a.currency === p.project.baseCurrency ? -1 : b.currency === p.project.baseCurrency ? 1 : a.currency.localeCompare(b.currency))),
  };
}

function buildEntry(p: MockProject, roundId: string, body: EntryBody, actor: string, prev?: EntryDTO): EntryDTO {
  const base = p.project.baseCurrency;
  const oExp = exp(body.originalCurrency);
  const bExp = p.project.baseExponent;
  if (body.originalCurrency !== base && !p.project.multiCurrencyEnabled) fail(409, "MULTI_CURRENCY_DISABLED", `This group only takes ${base}.`, "originalCurrency");
  if (!getCurrency(body.originalCurrency)) fail(422, "VALIDATION", "Unsupported currency", "originalCurrency");
  const c = body.conversion;
  if (body.originalCurrency === base && c.method !== "IDENTITY") fail(422, "VALIDATION", "Same-currency entries need no conversion", "conversion");
  if (body.originalCurrency !== base && c.method === "IDENTITY") fail(422, "VALIDATION", "Enter a rate or the amount charged", "conversion.rate");
  const conversion =
    c.method === "IDENTITY"
      ? ({ method: "IDENTITY" } as const)
      : c.method === "MANUAL_RATE"
        ? ({ method: "MANUAL_RATE", rate: rateFromString(c.rate) } as const)
        : ({ method: "ACTUAL_BASE_AMOUNT", baseAmount: BigInt(c.baseAmount) } as const);
  const participants =
    body.splitMode === "EQUAL" ? body.participants.map((x) => x.memberId) : Object.fromEntries(body.participants.map((x) => [x.memberId, BigInt(x.amount ?? "0")]));
  const res = computeEntry({
    type: body.type,
    originalAmount: BigInt(body.originalAmount),
    originalExponent: oExp,
    baseExponent: bExp,
    conversion,
    payerMemberId: body.payerMemberId,
    splitMode: body.splitMode,
    participants,
  });
  if (!res.ok) {
    const map: Record<string, [string, string]> = {
      EXACT_SUM_MISMATCH: ["participants", "The exact amounts must add up to the total"],
      BASE_ROUNDS_TO_ZERO: ["conversion.rate", "That converts to zero. Check the rate."],
      TOO_LARGE: ["originalAmount", "That amount is too large"],
    };
    const [field, msg] = map[res.error] ?? ["_form", "These values can't be saved"];
    fail(422, "VALIDATION", msg, field);
  }
  const v = res.value;
  const rows = (o: Shares, b: Shares) => Object.keys(o).sort().map((m) => ({ memberId: m, originalAmount: o[m]!.toString(), baseAmount: (b[m] ?? 0n).toString() }));
  const saved = p.rates.find((r) => r.currency === body.originalCurrency);
  const t = now();
  const rateSource =
    c.method === "IDENTITY" ? "IDENTITY" : c.method === "ACTUAL_BASE_AMOUNT" ? "ACTUAL_CHARGE" : saved && saved.rate === v.rateString ? "OWNER_DEFAULT" : "ENTRY_OVERRIDE";
  return {
    id: prev?.id ?? uid("e_"),
    roundId,
    type: body.type,
    creatorMemberId: prev?.creatorMemberId ?? actor,
    lastEditedByMemberId: prev ? actor : null,
    occurredAt: body.occurredAt,
    description: body.description,
    originalAmount: body.originalAmount,
    originalCurrency: body.originalCurrency,
    originalExponent: oExp,
    baseAmount: v.baseAmount.toString(),
    baseCurrency: base,
    baseExponent: bExp,
    conversion: {
      method: c.method,
      rate: v.rateString,
      rateSource,
      rateSetByMemberId: rateSource === "OWNER_DEFAULT" ? saved!.setByMemberId : rateSource === "IDENTITY" ? null : actor,
      rateSetAt: rateSource === "OWNER_DEFAULT" ? saved!.setAt : rateSource === "IDENTITY" ? null : t,
      note: c.method !== "IDENTITY" ? (c.note ?? null) : null,
    },
    payerMemberId: body.payerMemberId,
    splitMode: body.splitMode,
    contributions: rows(v.originalContributions, v.baseContributions),
    allocations: rows(v.originalAllocations, v.baseAllocations),
    adjustmentEffects: null,
    correctedEntryId: null,
    correctedRoundId: null,
    revision: (prev?.revision ?? 0) + 1,
    createdAt: prev?.createdAt ?? t,
    updatedAt: t,
  };
}

function bumpLedger(r: MockRound) {
  r.round.ledgerVersion++;
  r.round.reviewVersion++;
}

function clearReady(r: MockRound, ids: string[] | "all") {
  for (const [m, st] of Object.entries(r.readiness)) if (ids === "all" || ids.includes(m)) r.readiness[m] = { ...st, ready: false };
}

function freezeRound(p: MockProject, r: MockRound, actor: string | null, reason: string | null, at = now()) {
  const view = roundView(p, r);
  const nets: Record<string, bigint> = {};
  for (const b of view.balances) if (BigInt(b.net) !== 0n) nets[b.memberId] = BigInt(b.net);
  const plan = planSettlement(nets);
  r.instructions = plan.map((t) => ({
    id: uid("i_"),
    roundId: r.round.id,
    fromMemberId: t.from,
    toMemberId: t.to,
    amount: t.amount.toString(),
    currency: p.project.baseCurrency,
    exponent: p.project.baseExponent,
    state: "PROPOSED",
    sentAt: null,
    confirmedAt: null,
    disputedAt: null,
    disputeNote: null,
    revision: 1,
  }));
  r.round.status = plan.length ? "SETTLING" : "SETTLED";
  r.round.frozenAt = at;
  r.round.frozenByMemberId = actor;
  r.round.earlyFreezeReason = reason;
  if (!plan.length) r.round.settledAt = at;
}

/** The DO's alarm: freeze the collecting round once its scheduled instant has passed. */
function runSchedule(p: MockProject): boolean {
  const r = p.rounds[p.rounds.length - 1];
  if (!r || r.round.status !== "COLLECTING" || !r.round.scheduledFreezeAt) return false;
  const at = r.round.scheduledFreezeAt;
  if (new Date(at).getTime() > Date.now()) return false;
  const active = p.members.filter((m) => m.status === "ACTIVE");
  const notReady = active.filter((m) => !r.readiness[m.id]?.ready);
  freezeRound(p, r, null, notReady.length ? "Scheduled freeze date reached" : null, at);
  r.round.frozenBySchedule = true;
  p.project.version++;
  p.events.push({
    id: uid("ev_"),
    at,
    actorMemberId: null,
    action: "ROUND_FROZEN",
    roundId: r.round.id,
    entityId: null,
    summary: `Round ${r.round.sequence} froze automatically on the scheduled date${notReady.length ? ` before ${notReady.map((m) => m.displayName).join(", ")} finished` : ""}`,
    details: { scheduled: true, notReady: notReady.map((m) => m.id) },
  });
  if (r.instructions.length === 0)
    p.events.push({ id: uid("ev_"), at, actorMemberId: null, action: "ROUND_SETTLED", roundId: r.round.id, entityId: null, summary: `Round ${r.round.sequence} settled: no repayments needed`, details: null });
  return true;
}

// ---------- seed ----------

type Seed = "collecting" | "settling" | "settled" | "autofrozen";

function seed(kind: Seed = "collecting"): State {
  const principals: Record<string, Principal> = {
    pr_maya: { id: "pr_maya", kind: "ACCOUNT", email: "maya@example.com", displayName: "Maya" },
    pr_tom: { id: "pr_tom", kind: "ACCOUNT", email: "tom@example.com", displayName: "Tom" },
    pr_ines: { id: "pr_ines", kind: "GUEST", email: null, displayName: "Ines" },
    pr_kai: { id: "pr_kai", kind: "ACCOUNT", email: "kai@example.com", displayName: "Kai" },
    pr_ana: { id: "pr_ana", kind: "GUEST", email: null, displayName: "Ana" },
    pr_ola: { id: "pr_ola", kind: "ACCOUNT", email: "ola@example.com", displayName: "Ola" },
    pr_piotr: { id: "pr_piotr", kind: "GUEST", email: null, displayName: "Piotr" },
    pr_omar: { id: "pr_omar", kind: "ACCOUNT", email: "omar@example.com", displayName: "Omar" },
    pr_lea: { id: "pr_lea", kind: "ACCOUNT", email: "lea@example.com", displayName: "Lea" },
  };
  const projects: Record<string, MockProject> = {};

  const mkProject = (id: string, name: string, baseCurrency: string, multi: boolean, people: [string, string, string?][], created: string): MockProject => {
    const members: MemberDTO[] = people.map(([mid, pid, joined], i) => ({
      id: mid,
      displayName: principals[pid]!.displayName!,
      isOwner: i === 0,
      isGuest: principals[pid]!.kind === "GUEST",
      hasRecoverableAccount: principals[pid]!.kind === "ACCOUNT" || !!principals[pid]!.email,
      joinedAt: joined ?? new Date(new Date(created).getTime() + i * 3600_000).toISOString(),
      status: "ACTIVE",
      referenced: false,
      accountDeleted: false,
    }));
    const p: MockProject = {
      project: {
        id,
        name,
        ownerMemberId: members[0]!.id,
        baseCurrency,
        baseExponent: exp(baseCurrency),
        multiCurrencyEnabled: multi,
        baseCurrencyLocked: false,
        activeRoundId: null,
        version: 1,
        createdAt: created,
      },
      members,
      principals: Object.fromEntries(people.map(([m, pid]) => [m, pid])),
      rates: [],
      rounds: [],
      invitations: [],
      events: [],
      pendingOwnership: null,
    };
    projects[id] = p;
    return p;
  };
  const newRound = (p: MockProject, seq: number, created: string): MockRound => {
    const r: MockRound = {
      round: blankRound(seq, created),
      entries: [],
      deleted: [],
      readiness: Object.fromEntries(p.members.map((m) => [m.id, { ready: false, markedAt: null }])),
      instructions: [],
    };
    p.rounds.push(r);
    p.project.activeRoundId = r.round.id;
    return r;
  };
  const add = (p: MockProject, r: MockRound, actor: string, b: Omit<EntryBody, "conversion"> & { conversion?: EntryBody["conversion"] }, at: string) => {
    const e = buildEntry(p, r.round.id, { conversion: { method: "IDENTITY" }, ...b } as EntryBody, actor);
    e.createdAt = e.updatedAt = at;
    if (e.conversion.rateSetAt) e.conversion.rateSetAt = at;
    r.entries.push(e);
    bumpLedger(r);
    p.project.baseCurrencyLocked = true;
    p.events.push({ id: uid("ev_"), at, actorMemberId: actor, action: e.type === "REFUND" ? "ENTRY_CREATED" : "ENTRY_CREATED", roundId: r.round.id, entityId: e.id, summary: `${p.members.find((m) => m.id === actor)?.displayName} added “${e.description}”`, details: null });
    return e;
  };
  const ready = (p: MockProject, r: MockRound, mid: string, at: string) => {
    r.readiness[mid] = { ready: true, markedAt: at };
    r.round.reviewVersion++;
    p.events.push({ id: uid("ev_"), at, actorMemberId: mid, action: "READY_SET", roundId: r.round.id, entityId: null, summary: `${p.members.find((m) => m.id === mid)?.displayName} finished adding`, details: null });
  };
  const all = (p: MockProject) => p.members.filter((m) => m.status === "ACTIVE").map((m) => ({ memberId: m.id }));

  // Lisbon trip — the design's demo.
  const lis = mkProject(
    "p_lisbon",
    "Lisbon trip",
    "EUR",
    true,
    [
      ["m_maya", "pr_maya"],
      ["m_tom", "pr_tom"],
      ["m_ines", "pr_ines"],
      ["m_kai", "pr_kai"],
      ["m_ana", "pr_ana"],
    ],
    "2026-08-01T09:00:00.000Z",
  );
  lis.rates.push({ currency: "GBP", rate: "1.17", setByMemberId: "m_maya", setAt: "2026-09-03T10:12:00.000Z", revision: 1 });
  // Round 1 (flights and deposit) was settled in August; Sam took part and later deleted their account.
  lis.members.push({ id: "m_sam", displayName: "Deleted account", isOwner: false, isGuest: false, hasRecoverableAccount: false, joinedAt: "2026-08-01T15:00:00.000Z", status: "LEFT", referenced: true, accountDeleted: true });
  lis.principals.m_sam = "pr_sam_deleted";
  const l1 = newRound(lis, 1, "2026-08-01T09:00:00.000Z");
  const withSam = [...all(lis), { memberId: "m_sam" }];
  add(lis, l1, "m_maya", { type: "EXPENSE", description: "Flights to Lisbon", occurredAt: "2026-08-03", originalAmount: "102000", originalCurrency: "EUR", payerMemberId: "m_maya", splitMode: "EQUAL", participants: withSam }, "2026-08-03T18:00:00.000Z");
  add(lis, l1, "m_tom", { type: "EXPENSE", description: "Apartment deposit", occurredAt: "2026-08-05", originalAmount: "30000", originalCurrency: "EUR", payerMemberId: "m_tom", splitMode: "EQUAL", participants: withSam }, "2026-08-05T10:00:00.000Z");
  for (const m of lis.members) l1.readiness[m.id] = { ready: true, markedAt: "2026-08-10T10:00:00.000Z" };
  freezeRound(lis, l1, "m_maya", null, "2026-08-11T09:00:00.000Z");
  lis.events.push({ id: uid("ev_"), at: "2026-08-11T09:00:00.000Z", actorMemberId: "m_maya", action: "ROUND_FROZEN", roundId: l1.round.id, entityId: null, summary: "Maya froze round 1", details: null });
  for (const i of l1.instructions) Object.assign(i, { state: "CONFIRMED", sentAt: "2026-08-12T09:00:00.000Z", confirmedAt: "2026-08-14T09:00:00.000Z", revision: 3 });
  l1.round.status = "SETTLED";
  l1.round.settledAt = "2026-08-14T09:00:00.000Z";
  lis.events.push({ id: uid("ev_"), at: "2026-08-14T09:00:00.000Z", actorMemberId: null, action: "ROUND_SETTLED", roundId: l1.round.id, entityId: null, summary: "Round 1 is all settled", details: null });
  lis.events.push({ id: uid("ev_"), at: "2026-08-20T09:00:00.000Z", actorMemberId: "m_sam", action: "MEMBER_ACCOUNT_DELETED", roundId: null, entityId: "m_sam", summary: "A member deleted their account; they now show as “Deleted account”", details: null });
  const lr = newRound(lis, 2, "2026-09-02T09:00:00.000Z");
  lis.events.push({ id: uid("ev_"), at: "2026-09-02T09:00:00.000Z", actorMemberId: "m_maya", action: "ROUND_STARTED", roundId: lr.round.id, entityId: null, summary: "Maya started round 2", details: null });
  add(lis, lr, "m_maya", { type: "EXPENSE", description: "Apartment, 4 nights", occurredAt: "2026-09-12", originalAmount: "64000", originalCurrency: "EUR", payerMemberId: "m_maya", splitMode: "EQUAL", participants: all(lis) }, "2026-09-12T18:20:00.000Z");
  add(
    lis,
    lr,
    "m_kai",
    {
      type: "EXPENSE",
      description: "Surf lesson",
      occurredAt: "2026-09-13",
      originalAmount: "12000",
      originalCurrency: "USD",
      conversion: { method: "MANUAL_RATE", rate: "0.92" },
      payerMemberId: "m_kai",
      splitMode: "EQUAL",
      participants: [{ memberId: "m_maya" }, { memberId: "m_kai" }, { memberId: "m_ana" }],
    },
    "2026-09-13T12:05:00.000Z",
  );
  add(lis, lr, "m_tom", { type: "EXPENSE", description: "Groceries, Pingo Doce", occurredAt: "2026-09-13", originalAmount: "8635", originalCurrency: "EUR", payerMemberId: "m_tom", splitMode: "EQUAL", participants: all(lis) }, "2026-09-13T19:40:00.000Z");
  add(lis, lr, "m_kai", { type: "REFUND", description: "Museum tickets", occurredAt: "2026-09-14", originalAmount: "2400", originalCurrency: "EUR", payerMemberId: "m_kai", splitMode: "EQUAL", participants: all(lis) }, "2026-09-14T10:00:00.000Z");
  add(
    lis,
    lr,
    "m_ines",
    { type: "EXPENSE", description: "Tuk-tuk tour", occurredAt: "2026-09-14", originalAmount: "7500", originalCurrency: "EUR", payerMemberId: "m_ines", splitMode: "EQUAL", participants: [{ memberId: "m_maya" }, { memberId: "m_tom" }, { memberId: "m_ines" }] },
    "2026-09-14T16:30:00.000Z",
  );
  add(lis, lr, "m_kai", { type: "EXPENSE", description: "Dinner at Taberna", occurredAt: "2026-09-15", originalAmount: "21280", originalCurrency: "EUR", payerMemberId: "m_kai", splitMode: "EQUAL", participants: all(lis) }, "2026-09-15T22:10:00.000Z");
  ready(lis, lr, "m_maya", "2026-09-16T08:00:00.000Z");
  ready(lis, lr, "m_tom", "2026-09-16T09:30:00.000Z");
  ready(lis, lr, "m_ines", "2026-09-16T11:00:00.000Z");
  if (kind === "collecting") {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const date = addDays(todayIn(tz), 5);
    Object.assign(lr.round, { scheduledFreezeDate: date, scheduledFreezeTimeZone: tz, scheduledFreezeAt: endOfDayIn(date, tz) });
    lis.events.push({ id: uid("ev_"), at: "2026-09-16T12:00:00.000Z", actorMemberId: "m_maya", action: "FREEZE_SCHEDULED", roundId: lr.round.id, entityId: null, summary: `Maya set the freeze date to ${date}`, details: { date, timeZone: tz } });
  } else if (kind === "autofrozen") {
    Object.assign(lr.round, { scheduledFreezeDate: "2026-09-27", scheduledFreezeTimeZone: "Europe/Lisbon", scheduledFreezeAt: endOfDayIn("2026-09-27", "Europe/Lisbon") });
  }
  if (kind === "autofrozen") {
    runSchedule(lis);
  } else if (kind !== "collecting") {
    freezeRound(lis, lr, "m_maya", "Kai and Ana confirmed in chat that they have nothing else to add.", "2026-09-28T16:40:00.000Z");
    lis.events.push({ id: uid("ev_"), at: "2026-09-28T16:40:00.000Z", actorMemberId: "m_maya", action: "ROUND_FROZEN", roundId: lr.round.id, entityId: null, summary: "Maya froze round 2 before Kai and Ana finished", details: null });
    const [a, b, c, d] = lr.instructions;
    const conf = (i: InstructionDTO | undefined, sent: string, confd: string) => i && Object.assign(i, { state: "CONFIRMED", sentAt: sent, confirmedAt: confd, revision: 3 });
    if (kind === "settling") {
      // Ana → Maya sent (Maya's task), Ines → Maya confirmed, Tom → Kai disputed, Tom → Maya to send.
      if (a) Object.assign(a, { state: "SENT", sentAt: "2026-09-30T09:15:00.000Z", revision: 2 });
      conf(b, "2026-09-29T08:00:00.000Z", "2026-09-29T12:30:00.000Z");
      if (c) Object.assign(c, { state: "DISPUTED", sentAt: "2026-09-30T10:00:00.000Z", disputedAt: "2026-10-01T07:45:00.000Z", disputeNote: "Nothing on my account yet", revision: 3 });
      void d;
    } else {
      conf(a, "2026-09-30T09:15:00.000Z", "2026-09-30T18:00:00.000Z");
      conf(b, "2026-09-29T08:00:00.000Z", "2026-09-29T12:30:00.000Z");
      conf(c, "2026-09-30T10:00:00.000Z", "2026-10-01T19:20:00.000Z");
      conf(d, "2026-10-01T20:00:00.000Z", "2026-10-02T09:12:00.000Z");
      lr.round.status = "SETTLED";
      lr.round.settledAt = "2026-10-02T09:12:00.000Z";
    }
  }

  // Flat bills — settling, round 9, Maya has to send.
  const flat = mkProject(
    "p_flat",
    "Flat bills · September",
    "PLN",
    false,
    [
      ["m_ola", "pr_ola"],
      ["m_maya2", "pr_maya"],
      ["m_piotr", "pr_piotr"],
    ],
    "2026-01-03T09:00:00.000Z",
  );
  for (let s = 1; s <= 8; s++) {
    const r = newRound(flat, s, `2026-0${Math.min(s, 9)}-01T09:00:00.000Z`);
    r.round.status = "SETTLED";
    r.round.frozenAt = r.round.settledAt = `2026-0${Math.min(s, 9)}-28T20:00:00.000Z`;
    r.round.frozenByMemberId = "m_ola";
  }
  const fr = newRound(flat, 9, "2026-09-01T09:00:00.000Z");
  add(flat, fr, "m_ola", { type: "EXPENSE", description: "Rent and utilities", occurredAt: "2026-09-01", originalAmount: "93720", originalCurrency: "PLN", payerMemberId: "m_ola", splitMode: "EQUAL", participants: all(flat) }, "2026-09-01T10:00:00.000Z");
  for (const m of flat.members) fr.readiness[m.id] = { ready: true, markedAt: "2026-09-29T10:00:00.000Z" };
  freezeRound(flat, fr, "m_ola", null, "2026-09-30T20:00:00.000Z");

  // Kuwait offsite — settling, Maya sent and waits for Omar.
  const kw = mkProject(
    "p_kuwait",
    "Kuwait offsite",
    "KWD",
    false,
    [
      ["m_omar", "pr_omar"],
      ["m_maya3", "pr_maya"],
      ["m_k1", "pr_tom"],
      ["m_k2", "pr_kai"],
      ["m_k3", "pr_ines"],
      ["m_k4", "pr_ana"],
    ],
    "2026-09-20T09:00:00.000Z",
  );
  const kr = newRound(kw, 1, "2026-09-20T09:00:00.000Z");
  add(kw, kr, "m_omar", { type: "EXPENSE", description: "Team dinner", occurredAt: "2026-09-22", originalAmount: "76500", originalCurrency: "KWD", payerMemberId: "m_omar", splitMode: "EQUAL", participants: all(kw) }, "2026-09-22T21:00:00.000Z");
  for (const m of kw.members) kr.readiness[m.id] = { ready: true, markedAt: "2026-09-25T10:00:00.000Z" };
  freezeRound(kw, kr, "m_omar", null, "2026-09-26T09:00:00.000Z");
  for (const i of kr.instructions) if (i.fromMemberId === "m_maya3") Object.assign(i, { state: "SENT", sentAt: "2026-10-01T10:00:00.000Z", revision: 2 });

  // Tokyo 2025 — settled, JPY.
  const tk = mkProject(
    "p_tokyo",
    "Tokyo 2025",
    "JPY",
    false,
    [
      ["m_maya4", "pr_maya"],
      ["m_t1", "pr_tom"],
      ["m_t2", "pr_kai"],
      ["m_t3", "pr_ana"],
    ],
    "2025-04-01T09:00:00.000Z",
  );
  const tr = newRound(tk, 1, "2025-04-01T09:00:00.000Z");
  add(tk, tr, "m_maya4", { type: "EXPENSE", description: "Ryokan", occurredAt: "2025-04-10", originalAmount: "120000", originalCurrency: "JPY", payerMemberId: "m_maya4", splitMode: "EQUAL", participants: all(tk) }, "2025-04-10T10:00:00.000Z");
  add(tk, tr, "m_t1", { type: "EXPENSE", description: "Shinkansen", occurredAt: "2025-04-12", originalAmount: "64500", originalCurrency: "JPY", payerMemberId: "m_t1", splitMode: "EQUAL", participants: all(tk) }, "2025-04-12T10:00:00.000Z");
  for (const m of tk.members) tr.readiness[m.id] = { ready: true, markedAt: "2025-04-15T10:00:00.000Z" };
  freezeRound(tk, tr, "m_maya4", null, "2025-04-16T09:00:00.000Z");
  for (const i of tr.instructions) Object.assign(i, { state: "CONFIRMED", sentAt: "2025-04-17T09:00:00.000Z", confirmedAt: "2025-04-18T09:00:00.000Z", revision: 3 });
  tr.round.status = "SETTLED";
  tr.round.settledAt = "2025-04-18T09:00:00.000Z";

  // Porto weekend — Maya isn't a member; open the demo invitation to join it.
  const po = mkProject("p_porto", "Porto weekend", "EUR", false, [["m_lea", "pr_lea"]], "2026-10-01T09:00:00.000Z");
  newRound(po, 1, "2026-10-01T09:00:00.000Z");
  po.invitations.push(
    { id: "inv_demo", token: "p_porto.demo-invite-token-0001", createdAt: "2026-10-01T09:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", revokedAt: null },
    { id: "inv_exp", token: "p_porto.demo-expired-token-01", createdAt: "2026-08-01T09:00:00.000Z", expiresAt: "2026-08-15T00:00:00.000Z", revokedAt: null },
    { id: "inv_rev", token: "p_porto.demo-revoked-token-01", createdAt: "2026-09-01T09:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", revokedAt: "2026-09-02T09:00:00.000Z" },
  );
  kw.invitations.push({ id: "inv_kw", token: "p_kuwait.demo-frozen-token-001", createdAt: "2026-09-20T09:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", revokedAt: null });

  for (const p of Object.values(projects)) refreshReferenced(p);
  return { me: "pr_maya", principals, projects };
}

function refreshReferenced(p: MockProject) {
  const refs = new Set<string>();
  for (const r of p.rounds) {
    for (const e of r.entries) for (const x of [...e.contributions, ...e.allocations, ...(e.adjustmentEffects ?? [])]) refs.add(x.memberId);
    for (const i of r.instructions) (refs.add(i.fromMemberId), refs.add(i.toMemberId));
  }
  for (const m of p.members) m.referenced = refs.has(m.id);
}

// ---------- persistence ----------

function load(): State {
  const params = new URLSearchParams(location.search);
  const want = params.get("mock");
  if (want === "reset" || want === "collecting" || want === "settling" || want === "settled" || want === "autofrozen") {
    const s = seed(want === "reset" ? "collecting" : want);
    save(s);
    params.delete("mock");
    const q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash);
    return s;
  }
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) return JSON.parse(raw) as State;
  } catch {
    /* fall through to a fresh seed */
  }
  const s = seed();
  save(s);
  return s;
}

function save(s: State) {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(s));
  } catch {
    /* memory only */
  }
}

// ---------- the Api ----------

export interface MockApi extends Api {
  DevPanel: ComponentType;
}

export function createMockApi(): MockApi {
  let state = load();
  const listeners = new Map<string, Set<LiveHandlers>>();
  const idem = new Map<string, Promise<unknown>>();
  const latency = Number(new URLSearchParams(location.search).get("latency") ?? 150);
  const delay = <T,>(v: () => T): Promise<T> =>
    new Promise((res, rej) =>
      setTimeout(() => {
        try {
          res(structuredClone(v()));
        } catch (e) {
          rej(e);
        }
      }, latency),
    );

  const emit = (projectId: string, reason: string) => {
    const p = state.projects[projectId];
    for (const h of listeners.get(projectId) ?? []) setTimeout(() => h.onChange(reason), 20);
    void p;
  };

  const me = (): Principal => {
    const p = state.me ? state.principals[state.me] : null;
    if (!p) fail(401, "UNAUTHENTICATED", "Sign in to continue.");
    return p;
  };
  const proj = (id: string): MockProject => {
    const p = state.projects[id];
    if (!p) fail(404, "NOT_FOUND", "This group isn't available.");
    if (runSchedule(p)) save(state);
    return p;
  };
  const memberOf = (p: MockProject): MemberDTO => {
    const pid = me().id;
    const m = p.members.find((x) => p.principals[x.id] === pid && x.status === "ACTIVE");
    if (!m) fail(404, "NOT_FOUND", "This group isn't available.");
    return m;
  };
  const ownerOnly = (p: MockProject) => {
    const m = memberOf(p);
    if (!m.isOwner) fail(403, "FORBIDDEN", "Only the owner can do that.");
    return m;
  };
  const roundOf = (p: MockProject, roundId: string) => {
    const r = p.rounds.find((x) => x.round.id === roundId);
    if (!r) fail(404, "NOT_FOUND", "That round isn't available.");
    return r;
  };
  const active = (p: MockProject) => p.rounds[p.rounds.length - 1]!;
  const collecting = (p: MockProject, roundId: string) => {
    const r = roundOf(p, roundId);
    if (r.round.status !== "COLLECTING") fail(409, "ROUND_NOT_COLLECTING", "Expenses are frozen for this round. Add it to the next round instead.");
    return r;
  };
  const log = (p: MockProject, actor: string | null, action: string, roundId: string | null, entityId: string | null, summary: string, details: Record<string, unknown> | null = null) =>
    p.events.push({ id: uid("ev_"), at: now(), actorMemberId: actor, action, roundId, entityId, summary, details });
  const nameOf = (p: MockProject, id: string) => p.members.find((m) => m.id === id)?.displayName ?? "Someone";

  const view = (p: MockProject): ProjectViewDTO => {
    const m = memberOf(p);
    const cur = active(p);
    return {
      project: { ...p.project, pendingOwnerMemberId: p.pendingOwnership },
      me: { memberId: m.id, isOwner: m.isOwner },
      members: p.members.map((x) => ({ ...x })),
      rates: p.rates.map((x) => ({ ...x })),
      current: roundView(p, cur),
      rounds: [...p.rounds].reverse().map((r) => ({ ...r.round })),
      invitations: m.isOwner ? p.invitations.map(({ token: _t, ...i }) => ({ ...i })) : null,
    };
  };

  /** Mutation wrapper: idempotency replay, persistence, live notification. */
  function mutate<T>(o: MutationOptions, projectId: string | null, reason: string, fn: () => T): Promise<T> {
    const k = `${state.me}:${o.idempotencyKey}`;
    const hit = idem.get(k);
    if (hit) return hit as Promise<T>;
    const p = delay(() => {
      const r = fn();
      save(state);
      if (projectId) {
        const pr = state.projects[projectId];
        if (pr) pr.project.version++;
        save(state);
        emit(projectId, reason);
      }
      return r;
    });
    idem.set(k, p);
    p.catch(() => idem.delete(k));
    return p;
  }

  const zodFail = (issues: { path: PropertyKey[]; message: string }[]): never =>
    fail(422, "VALIDATION", issues[0]?.message ?? "Invalid input", issues[0]?.path.map(String).join("."));

  const summary = (p: MockProject): ProjectSummaryDTO => {
    if (runSchedule(p)) save(state);
    const m = memberOf(p);
    const r = active(p);
    const rv = roundView(p, r);
    let nextAction: ProjectSummaryDTO["nextAction"] = "WAITING";
    if (r.round.status === "SETTLED") nextAction = "DONE";
    else if (r.round.status === "SETTLING") {
      if (r.instructions.some((i) => i.toMemberId === m.id && i.state === "SENT")) nextAction = "CONFIRM_RECEIPT";
      else if (r.instructions.some((i) => i.fromMemberId === m.id && (i.state === "PROPOSED" || i.state === "DISPUTED"))) nextAction = "SEND_MONEY";
    } else if (m.isOwner && rv.readiness.every((x) => x.ready)) nextAction = "REVIEW_FREEZE";
    else if (!r.readiness[m.id]?.ready) nextAction = r.entries.some((e) => e.creatorMemberId === m.id) ? "MARK_READY" : "ADD_EXPENSES";
    else if (m.isOwner) nextAction = "REVIEW_FREEZE";
    return {
      id: p.project.id,
      name: p.project.name,
      baseCurrency: p.project.baseCurrency,
      roundStatus: r.round.status,
      roundSequence: r.round.sequence,
      isOwner: m.isOwner,
      nextAction,
      updatedAt: r.round.settledAt ?? r.round.frozenAt ?? r.entries[r.entries.length - 1]?.updatedAt ?? r.round.createdAt,
    };
  };

  const meDto = (p: Principal): MeDTO => ({ principalId: p.id, kind: p.kind, email: p.email, displayName: p.displayName });
  const myProjects = (pid: string) => Object.values(state.projects).filter((p) => p.members.some((m) => p.principals[m.id] === pid && m.status === "ACTIVE"));
  const deletionPreview = (pid: string): DeletionPreviewDTO => {
    const out: DeletionPreviewDTO = { ownedProjects: [], memberProjects: [], blockingProjects: [] };
    for (const p of myProjects(pid)) {
      const m = p.members.find((x) => p.principals[x.id] === pid && x.status === "ACTIVE")!;
      if (m.isOwner) {
        out.ownedProjects.push({ id: p.project.id, name: p.project.name, memberCount: p.members.filter((x) => x.status === "ACTIVE").length });
        continue;
      }
      out.memberProjects.push({ id: p.project.id, name: p.project.name });
      const open = p.rounds.some((r) => r.round.status === "SETTLING" && r.instructions.some((i) => i.state !== "CONFIRMED" && (i.fromMemberId === m.id || i.toMemberId === m.id)));
      if (open) out.blockingProjects.push({ id: p.project.id, name: p.project.name });
    }
    return out;
  };

  const api: MockApi = {
    getConfig: () => delay(() => ({ turnstileSiteKey: null, environment: "development" as const })),
    getMe: () =>
      delay((): MeDTO | null => {
        const p = state.me ? state.principals[state.me] : null;
        return p ? meDto(p) : null;
      }),
    requestSignIn: (body, o) =>
      mutate(o, null, "", () => {
        const email = body.email.trim().toLowerCase();
        let p = Object.values(state.principals).find((x) => x.email === email);
        if (!p) {
          p = { id: uid("pr_"), kind: "ACCOUNT", email, displayName: null };
          state.principals[p.id] = p;
        }
        const target = p.id;
        // The mock "link" signs in when opened.
        // Mock tokens just encode who signs in and where to go; the page reloads before use.
        const token = `tok.${target}.${encodeURIComponent(body.next ?? "/groups")}`;
        return { sent: true as const, devLink: `${location.origin}/auth/confirm#token=${encodeURIComponent(token)}` };
      }),
    verifySignIn: (token, o) =>
      mutate(o, null, "", () => {
        const [tag, principal, next] = token.split(".");
        if (tag !== "tok" || !principal || !state.principals[principal]) fail(410, "SIGNIN_LINK_INVALID", "This sign-in link has expired or was already used. Request a new one.");
        state.me = principal;
        return { next: decodeURIComponent(next ?? "/groups") };
      }),
    signOut: (o) =>
      mutate(o, null, "", () => {
        state.me = null;
      }),
    attachEmail: (body, o) =>
      mutate(o, null, "", () => {
        const p = me();
        p.email = body.email.trim().toLowerCase();
        p.kind = "ACCOUNT";
        for (const pr of Object.values(state.projects))
          for (const m of pr.members) if (pr.principals[m.id] === p.id) m.hasRecoverableAccount = true;
        return { sent: true as const };
      }),
    updateMe: (body, o) =>
      mutate(o, null, "", () => {
        const d = UpdateMeSchema.safeParse(body);
        if (!d.success) zodFail(d.error.issues);
        const p = me();
        p.displayName = d.data!.displayName;
        return meDto(p);
      }),
    getDeletionPreview: () => delay(() => deletionPreview(me().id)),
    deleteAccount: (body, o) =>
      mutate(o, null, "", () => {
        if (!DeleteAccountSchema.safeParse(body).success) fail(422, "VALIDATION", "Type DELETE to confirm.", "confirm");
        const pid = me().id;
        const preview = deletionPreview(pid);
        if (preview.blockingProjects.length)
          fail(409, "ACCOUNT_HAS_OPEN_TRANSFERS", "Some of your transfers aren't confirmed yet. Finish them before deleting your account.", undefined, { projects: preview.blockingProjects.map((x) => x.id) });
        for (const x of preview.ownedProjects) delete state.projects[x.id];
        for (const x of preview.memberProjects) {
          const p = state.projects[x.id]!;
          const m = p.members.find((y) => p.principals[y.id] === pid && y.status === "ACTIVE")!;
          Object.assign(m, { displayName: "Deleted account", accountDeleted: true, hasRecoverableAccount: false, status: "LEFT" });
          const r = active(p);
          if (r.round.status === "COLLECTING") {
            delete r.readiness[m.id];
            r.round.reviewVersion++;
          }
          log(p, m.id, "MEMBER_ACCOUNT_DELETED", null, m.id, "A member deleted their account; they now show as “Deleted account”");
          p.project.version++;
          emit(p.project.id, "MEMBER_ACCOUNT_DELETED");
        }
        delete state.principals[pid];
        state.me = null;
      }),

    listProjects: () => delay(() => myProjects(me().id).map(summary)),
    createProject: (body, o) =>
      mutate(o, null, "", () => {
        const parsed = CreateProjectSchema.safeParse(body);
        if (!parsed.success) zodFail(parsed.error.issues);
        const d = parsed.data!;
        const pr = me();
        if (pr.kind !== "ACCOUNT") fail(401, "UNAUTHENTICATED", "Creating a group needs a verified email.");
        const id = uid("p_");
        const mid = uid("m_");
        const t = now();
        const p: MockProject = {
          project: { id, name: d.name, ownerMemberId: mid, baseCurrency: d.baseCurrency, baseExponent: exp(d.baseCurrency), multiCurrencyEnabled: d.multiCurrencyEnabled, baseCurrencyLocked: false, activeRoundId: null, version: 1, createdAt: t },
          members: [{ id: mid, displayName: d.ownerDisplayName, isOwner: true, isGuest: false, hasRecoverableAccount: true, joinedAt: t, status: "ACTIVE", referenced: false, accountDeleted: false }],
          principals: { [mid]: pr.id },
          rates: [],
          rounds: [],
          invitations: [],
          events: [],
          pendingOwnership: null,
        };
        const r: MockRound = {
          round: blankRound(1, t),
          entries: [],
          deleted: [],
          readiness: { [mid]: { ready: false, markedAt: null } },
          instructions: [],
        };
        p.rounds.push(r);
        p.project.activeRoundId = r.round.id;
        state.projects[id] = p;
        log(p, mid, "PROJECT_CREATED", r.round.id, null, `${d.ownerDisplayName} created the group`);
        return view(p);
      }),
    getProject: (id) => delay(() => view(proj(id))),
    updateSettings: (id, body, o) =>
      mutate(o, id, "SETTINGS_UPDATED", () => {
        const p = proj(id);
        const m = ownerOnly(p);
        const d = UpdateSettingsSchema.parse(body);
        if (d.expectedVersion !== p.project.version) fail(409, "STALE_VERSION", "Settings changed in the meantime. Check them and try again.");
        const r = active(p);
        if (d.name) p.project.name = d.name;
        if (d.baseCurrency && d.baseCurrency !== p.project.baseCurrency) {
          if (p.project.baseCurrencyLocked) fail(409, "CURRENCY_LOCKED", "The settlement currency is fixed after the first entry.");
          p.project.baseCurrency = d.baseCurrency;
          p.project.baseExponent = exp(d.baseCurrency);
        }
        if (d.multiCurrencyEnabled !== undefined && d.multiCurrencyEnabled !== p.project.multiCurrencyEnabled) {
          if (r.round.status === "SETTLING") fail(409, "CURRENCY_LOCKED", "Currency settings are locked while settling.");
          if (!d.multiCurrencyEnabled && r.round.status === "COLLECTING" && r.entries.some((e) => e.originalCurrency !== p.project.baseCurrency))
            fail(409, "FOREIGN_ENTRIES_EXIST", "Some entries in this round use another currency. Change or delete them first.");
          p.project.multiCurrencyEnabled = d.multiCurrencyEnabled;
          if (r.round.status === "COLLECTING") {
            clearReady(r, "all");
            r.round.reviewVersion++;
          }
        }
        log(p, m.id, "SETTINGS_UPDATED", r.round.id, null, `${m.displayName} changed the group settings`);
      }),
    putRate: (id, cur, body, o) =>
      mutate(o, id, "RATE_DEFAULT_SET", () => {
        const p = proj(id);
        const m = ownerOnly(p);
        const ex = p.rates.find((r) => r.currency === cur);
        if (ex && body.expectedRevision !== undefined && body.expectedRevision !== ex.revision) fail(409, "STALE_VERSION", "Someone changed this rate. Check it and try again.");
        if (ex) Object.assign(ex, { rate: body.rate, setByMemberId: m.id, setAt: now(), revision: ex.revision + 1 });
        else p.rates.push({ currency: cur, rate: body.rate, setByMemberId: m.id, setAt: now(), revision: 1 });
        log(p, m.id, "RATE_DEFAULT_SET", null, null, `${m.displayName} saved 1 ${cur} = ${body.rate} ${p.project.baseCurrency}`);
      }),
    deleteRate: (id, cur, o) =>
      mutate(o, id, "RATE_DELETED", () => {
        const p = proj(id);
        ownerOnly(p);
        p.rates = p.rates.filter((r) => r.currency !== cur);
      }),

    createInvite: (id, o) =>
      mutate(o, id, "INVITE_CREATED", () => {
        const p = proj(id);
        ownerOnly(p);
        const token = `${id}.${crypto.randomUUID().replace(/-/g, "")}`;
        const inv = { id: uid("inv_"), token, createdAt: now(), expiresAt: new Date(Date.now() + 14 * 86400_000).toISOString(), revokedAt: null };
        p.invitations.push(inv);
        return { id: inv.id, createdAt: inv.createdAt, expiresAt: inv.expiresAt, revokedAt: null, url: `${location.origin}/join#${token}` };
      }),
    revokeInvite: (id, inviteId, o) =>
      mutate(o, id, "INVITE_REVOKED", () => {
        const p = proj(id);
        ownerOnly(p);
        const inv = p.invitations.find((i) => i.id === inviteId);
        if (inv) inv.revokedAt ??= now();
      }),
    previewInvite: (token) =>
      delay((): InvitationPreviewDTO => {
        const p = state.projects[token.split(".")[0] ?? ""];
        const inv = p?.invitations.find((i) => i.token === token);
        if (!p || !inv) fail(404, "NOT_FOUND", "This invitation isn't available.");
        const pid = state.me;
        const already = p.members.find((m) => p.principals[m.id] === pid && m.status === "ACTIVE");
        const status: InvitationPreviewDTO["status"] = inv.revokedAt
          ? "REVOKED"
          : new Date(inv.expiresAt).getTime() < Date.now()
            ? "EXPIRED"
            : active(p).round.status === "SETTLING"
              ? "MEMBERSHIP_FROZEN"
              : "OPEN";
        return { projectName: p.project.name, baseCurrency: p.project.baseCurrency, status, alreadyMemberProjectId: already ? p.project.id : null };
      }),
    join: (body, o) => {
      const projectId = body.token.split(".")[0] ?? "";
      return mutate(o, projectId, "MEMBER_JOINED", () => {
        const d = JoinSchema.safeParse(body);
        if (!d.success) zodFail(d.error.issues);
        const p = state.projects[projectId];
        const inv = p?.invitations.find((i) => i.token === body.token);
        if (!p || !inv || inv.revokedAt || new Date(inv.expiresAt).getTime() < Date.now()) fail(409, "INVITE_INVALID", "This invitation no longer works. Ask the owner for a new link.");
        const r = active(p);
        if (r.round.status === "SETTLING") fail(409, "INVITE_INVALID", "This group isn't taking new members while settling.");
        if (!state.me) {
          const g: Principal = { id: uid("pr_"), kind: "GUEST", email: null, displayName: d.data!.displayName };
          state.principals[g.id] = g;
          state.me = g.id;
        }
        const pr = me();
        const existing = p.members.find((m) => p.principals[m.id] === pr.id && m.status === "ACTIVE");
        if (existing) return { projectId };
        const mid = uid("m_");
        p.members.push({ id: mid, displayName: d.data!.displayName, isOwner: false, isGuest: pr.kind === "GUEST", hasRecoverableAccount: pr.kind === "ACCOUNT" || !!pr.email, joinedAt: now(), status: "ACTIVE", referenced: false, accountDeleted: false });
        p.principals[mid] = pr.id;
        if (r.round.status === "COLLECTING") {
          clearReady(r, "all");
          r.readiness[mid] = { ready: false, markedAt: null };
          r.round.reviewVersion++;
        }
        log(p, mid, "MEMBER_JOINED", r.round.id, mid, `${d.data!.displayName} joined`);
        return { projectId };
      });
    },

    removeMember: (id, memberId, o) =>
      mutate(o, id, "MEMBER_REMOVED", () => {
        const p = proj(id);
        const owner = ownerOnly(p);
        const r = active(p);
        if (r.round.status !== "COLLECTING") fail(409, "ROUND_NOT_COLLECTING", "Members are locked while settling.");
        const m = p.members.find((x) => x.id === memberId);
        if (!m || m.isOwner) fail(403, "FORBIDDEN", "That member can't be removed.");
        if (m.referenced) fail(409, "MEMBER_REFERENCED", `${m.displayName} is part of entries, so they can't be removed.`);
        m.status = "REMOVED";
        delete r.readiness[m.id];
        clearReady(r, "all");
        r.round.reviewVersion++;
        log(p, owner.id, "MEMBER_REMOVED", r.round.id, m.id, `${owner.displayName} removed ${m.displayName}`);
      }),
    leave: (id, o) =>
      mutate(o, id, "MEMBER_LEFT", () => {
        const p = proj(id);
        const m = memberOf(p);
        if (m.isOwner) fail(409, "INVALID_TRANSITION", "Transfer ownership before leaving.");
        m.status = "LEFT";
        log(p, m.id, "MEMBER_LEFT", null, m.id, `${m.displayName} left`);
      }),
    transferOwnership: (id, body, o) =>
      mutate(o, id, "OWNERSHIP_OFFERED", () => {
        const p = proj(id);
        const m = ownerOnly(p);
        const to = p.members.find((x) => x.id === body.toMemberId && x.status === "ACTIVE");
        if (!to || !to.hasRecoverableAccount) fail(422, "VALIDATION", "The new owner needs an account with a verified email.", "toMemberId");
        p.pendingOwnership = to.id;
        log(p, m.id, "OWNERSHIP_OFFERED", null, to.id, `${m.displayName} offered ownership to ${to.displayName}`);
      }),
    acceptOwnership: (id, o) =>
      mutate(o, id, "OWNERSHIP_ACCEPTED", () => {
        const p = proj(id);
        const m = memberOf(p);
        if (p.pendingOwnership !== m.id) fail(409, "INVALID_TRANSITION", "There's no ownership offer for you.");
        for (const x of p.members) x.isOwner = x.id === m.id;
        p.project.ownerMemberId = m.id;
        p.pendingOwnership = null;
        const r = active(p);
        if (r.round.status === "COLLECTING") clearReady(r, "all");
        log(p, m.id, "OWNERSHIP_TRANSFERRED", null, m.id, `${m.displayName} is now the owner`);
      }),
    renameMe: (id, body, o) =>
      mutate(o, id, "MEMBER_RENAMED", () => {
        const p = proj(id);
        const m = memberOf(p);
        const d = RenameMemberSchema.safeParse(body);
        if (!d.success) zodFail(d.error.issues);
        const next = d.data!.displayName;
        if (next !== m.displayName) {
          const prev = m.displayName;
          m.displayName = next;
          log(p, m.id, "MEMBER_RENAMED", null, m.id, `${prev} is now called ${next}`, { from: prev, to: next });
        }
        return { ...m };
      }),

    createEntry: (id, roundId, body, o) =>
      mutate(o, id, "ENTRY_CREATED", () => {
        const p = proj(id);
        const m = memberOf(p);
        const r = collecting(p, roundId);
        const parsed = EntryInputSchema.safeParse(body);
        if (!parsed.success) zodFail(parsed.error.issues);
        const e = buildEntry(p, r.round.id, parsed.data!, m.id);
        r.entries.push(e);
        p.project.baseCurrencyLocked = true;
        bumpLedger(r);
        clearReady(r, [m.id]);
        refreshReferenced(p);
        log(p, m.id, "ENTRY_CREATED", r.round.id, e.id, `${m.displayName} added “${e.description}”`);
      }),
    updateEntry: (id, roundId, entryId, body, o) =>
      mutate(o, id, "ENTRY_UPDATED", () => {
        const p = proj(id);
        const m = memberOf(p);
        const r = collecting(p, roundId);
        const i = r.entries.findIndex((e) => e.id === entryId);
        if (i < 0) fail(404, "NOT_FOUND", "This entry was deleted.");
        const prev = r.entries[i]!;
        if (!m.isOwner && prev.creatorMemberId !== m.id) fail(403, "FORBIDDEN", "Only the person who added it or the owner can change this entry.");
        if (body.expectedRevision !== prev.revision) fail(409, "STALE_VERSION", "Someone else changed this entry.");
        const { expectedRevision: _r, ...rest } = body;
        const parsed = EntryInputSchema.safeParse(rest);
        if (!parsed.success) zodFail(parsed.error.issues);
        r.entries[i] = buildEntry(p, r.round.id, parsed.data!, m.id, prev);
        bumpLedger(r);
        clearReady(r, [m.id, prev.creatorMemberId]);
        refreshReferenced(p);
        log(p, m.id, "ENTRY_UPDATED", r.round.id, prev.id, `${m.displayName} edited “${parsed.data!.description}”`);
      }),
    deleteEntry: (id, roundId, entryId, body, o) =>
      mutate(o, id, "ENTRY_DELETED", () => {
        const p = proj(id);
        const m = memberOf(p);
        const r = collecting(p, roundId);
        const e = r.entries.find((x) => x.id === entryId);
        if (!e) fail(404, "NOT_FOUND", "This entry was already deleted.");
        if (!m.isOwner && e.creatorMemberId !== m.id) fail(403, "FORBIDDEN", "Only the person who added it or the owner can delete this entry.");
        if (body.expectedRevision !== e.revision) fail(409, "STALE_VERSION", "Someone else changed this entry.");
        r.entries = r.entries.filter((x) => x.id !== entryId);
        r.deleted.push(entryId);
        bumpLedger(r);
        clearReady(r, [m.id, e.creatorMemberId]);
        refreshReferenced(p);
        log(p, m.id, "ENTRY_DELETED", r.round.id, e.id, `${m.displayName} deleted “${e.description}”`);
      }),
    createAdjustment: (id, roundId, body, o) =>
      mutate(o, id, "ADJUSTMENT_CREATED", () => {
        const p = proj(id);
        const m = ownerOnly(p);
        const r = collecting(p, roundId);
        const d = AdjustmentInputSchema.safeParse(body);
        if (!d.success) zodFail(d.error.issues);
        const sum = d.data!.effects.reduce((a, x) => a + BigInt(x.baseAmount), 0n);
        if (sum !== 0n) fail(422, "VALIDATION", "Effects must add up to zero", "effects");
        const orig = roundOf(p, d.data!.correctedRoundId).entries.find((e) => e.id === d.data!.correctedEntryId);
        if (!orig) fail(404, "NOT_FOUND", "The original entry isn't available.");
        const t = now();
        const effects = d.data!.effects.map((x) => ({ memberId: x.memberId, originalAmount: x.baseAmount, baseAmount: x.baseAmount }));
        const e: EntryDTO = {
          id: uid("e_"),
          roundId: r.round.id,
          type: "ADJUSTMENT",
          creatorMemberId: m.id,
          lastEditedByMemberId: null,
          occurredAt: d.data!.occurredAt,
          description: d.data!.description,
          originalAmount: "0",
          originalCurrency: p.project.baseCurrency,
          originalExponent: p.project.baseExponent,
          baseAmount: "0",
          baseCurrency: p.project.baseCurrency,
          baseExponent: p.project.baseExponent,
          conversion: { method: "IDENTITY", rate: "1", rateSource: "IDENTITY", rateSetByMemberId: null, rateSetAt: null, note: null },
          payerMemberId: null,
          splitMode: null,
          contributions: [],
          allocations: [],
          adjustmentEffects: effects,
          correctedEntryId: orig.id,
          correctedRoundId: d.data!.correctedRoundId,
          revision: 1,
          createdAt: t,
          updatedAt: t,
        };
        r.entries.push(e);
        bumpLedger(r);
        clearReady(r, [m.id]);
        refreshReferenced(p);
        log(p, m.id, "ADJUSTMENT_CREATED", r.round.id, e.id, `${m.displayName} added a correction for “${orig.description}”`);
      }),

    setReadiness: (id, roundId, body, o) =>
      mutate(o, id, "READY_SET", () => {
        const p = proj(id);
        const m = memberOf(p);
        const r = collecting(p, roundId);
        r.readiness[m.id] = { ready: body.ready, markedAt: body.ready ? now() : null };
        r.round.reviewVersion++;
        log(p, m.id, body.ready ? "READY_SET" : "READY_CLEARED", r.round.id, null, body.ready ? `${m.displayName} finished adding` : `${m.displayName} is adding again`);
      }),
    getReview: (id, roundId) =>
      delay((): ReviewDTO => {
        const p = proj(id);
        ownerOnly(p);
        const r = collecting(p, roundId);
        const rv = roundView(p, r);
        const nets: Record<string, bigint> = {};
        for (const b of rv.balances) if (BigInt(b.net) !== 0n) nets[b.memberId] = BigInt(b.net);
        return {
          roundId,
          reviewVersion: r.round.reviewVersion,
          ledgerVersion: r.round.ledgerVersion,
          notReadyMemberIds: rv.readiness.filter((x) => !x.ready).map((x) => x.memberId),
          view: rv,
          proposedTransfers: planSettlement(nets).map((t) => ({ fromMemberId: t.from, toMemberId: t.to, amount: t.amount.toString() })),
        };
      }),
    freeze: (id, roundId, body, o) =>
      mutate(o, id, "ROUND_FROZEN", () => {
        const p = proj(id);
        const m = ownerOnly(p);
        const r = collecting(p, roundId);
        const d = FreezeSchema.parse(body);
        if (d.expectedReviewVersion !== r.round.reviewVersion) fail(409, "REVIEW_STALE", "Something changed during review.", undefined, { currentReviewVersion: r.round.reviewVersion });
        const notReady = roundView(p, r).readiness.filter((x) => !x.ready).map((x) => x.memberId).sort();
        if (notReady.join() !== [...d.acknowledgeNotReady].sort().join()) fail(409, "NOT_READY_UNACKNOWLEDGED", "Confirm who isn't finished.", undefined, { notReady });
        freezeRound(p, r, m.id, notReady.length ? d.earlyFreezeReason || null : null);
        Object.assign(r.round, { scheduledFreezeDate: null, scheduledFreezeTimeZone: null, scheduledFreezeAt: null });
        refreshReferenced(p);
        log(p, m.id, "ROUND_FROZEN", r.round.id, null, `${m.displayName} froze round ${r.round.sequence}${notReady.length ? ` before ${notReady.map((x) => nameOf(p, x)).join(", ")} finished` : ""}`);
        if (r.round.status === "SETTLED") log(p, null, "ROUND_SETTLED", r.round.id, null, `Round ${r.round.sequence} settled: no repayments needed`);
      }),
    setFreezeSchedule: (id, roundId, body, o) =>
      mutate(o, id, "FREEZE_SCHEDULE_CHANGED", () => {
        const p = proj(id);
        const m = ownerOnly(p);
        const r = collecting(p, roundId);
        const d = FreezeScheduleSchema.safeParse(body);
        if (!d.success) zodFail(d.error.issues);
        const { date, timeZone } = d.data!;
        if (!validTimeZone(timeZone)) fail(422, "VALIDATION", "Unknown time zone", "timeZone");
        if (date === null) {
          if (r.round.scheduledFreezeDate) log(p, m.id, "FREEZE_SCHEDULE_CLEARED", r.round.id, null, `${m.displayName} removed the freeze date`);
          Object.assign(r.round, { scheduledFreezeDate: null, scheduledFreezeTimeZone: null, scheduledFreezeAt: null });
        } else {
          if (date < todayIn(timeZone)) fail(422, "VALIDATION", "Pick today or a later date.", "date");
          Object.assign(r.round, { scheduledFreezeDate: date, scheduledFreezeTimeZone: timeZone, scheduledFreezeAt: endOfDayIn(date, timeZone) });
          log(p, m.id, "FREEZE_SCHEDULED", r.round.id, null, `${m.displayName} set the freeze date to ${date}`, { date, timeZone });
        }
        return { ...r.round };
      }),
    getRound: (id, roundId) =>
      delay(() => {
        const p = proj(id);
        memberOf(p);
        return roundView(p, roundOf(p, roundId));
      }),

    markSent: (id, roundId, iid, _body, o) =>
      mutate(o, id, "INSTRUCTION_SENT", () => {
        const p = proj(id);
        const m = memberOf(p);
        const r = roundOf(p, roundId);
        if (r.round.status !== "SETTLING") fail(409, "ROUND_NOT_SETTLING", "This round isn't settling.");
        const i = r.instructions.find((x) => x.id === iid);
        if (!i) fail(404, "NOT_FOUND", "Transfer not found.");
        if (i.fromMemberId !== m.id) fail(403, "FORBIDDEN", "Only the sender can mark this as sent.");
        if (i.state === "SENT") return;
        if (i.state !== "PROPOSED" && i.state !== "DISPUTED") fail(409, "INVALID_TRANSITION", "This transfer is already confirmed.");
        Object.assign(i, { state: "SENT", sentAt: now(), revision: i.revision + 1 });
        log(p, m.id, "INSTRUCTION_SENT", r.round.id, i.id, `${m.displayName} sent ${nameOf(p, i.toMemberId)} their repayment`);
      }),
    markReceived: (id, roundId, iid, _body, o) =>
      mutate(o, id, "INSTRUCTION_CONFIRMED", () => {
        const p = proj(id);
        const m = memberOf(p);
        const r = roundOf(p, roundId);
        if (r.round.status !== "SETTLING") fail(409, "ROUND_NOT_SETTLING", "This round isn't settling.");
        const i = r.instructions.find((x) => x.id === iid);
        if (!i) fail(404, "NOT_FOUND", "Transfer not found.");
        if (i.toMemberId !== m.id) fail(403, "FORBIDDEN", "Only the recipient can confirm receipt.");
        if (i.state === "CONFIRMED") return;
        if (i.state !== "SENT") fail(409, "INVALID_TRANSITION", "The sender hasn't marked this as sent yet.");
        Object.assign(i, { state: "CONFIRMED", confirmedAt: now(), revision: i.revision + 1 });
        log(p, m.id, "INSTRUCTION_CONFIRMED", r.round.id, i.id, `${m.displayName} confirmed receipt from ${nameOf(p, i.fromMemberId)}`);
        if (r.instructions.every((x) => x.state === "CONFIRMED")) {
          r.round.status = "SETTLED";
          r.round.settledAt = now();
          log(p, null, "ROUND_SETTLED", r.round.id, null, `Round ${r.round.sequence} is all settled`);
        }
      }),
    markDisputed: (id, roundId, iid, body, o) =>
      mutate(o, id, "INSTRUCTION_DISPUTED", () => {
        const p = proj(id);
        const m = memberOf(p);
        const r = roundOf(p, roundId);
        const i = r.instructions.find((x) => x.id === iid);
        if (!i) fail(404, "NOT_FOUND", "Transfer not found.");
        if (i.toMemberId !== m.id) fail(403, "FORBIDDEN", "Only the recipient can dispute receipt.");
        if (i.state !== "SENT") fail(409, "INVALID_TRANSITION", "Only a sent transfer can be disputed.");
        Object.assign(i, { state: "DISPUTED", disputedAt: now(), disputeNote: body.note ?? null, revision: i.revision + 1 });
        log(p, m.id, "INSTRUCTION_DISPUTED", r.round.id, i.id, `${m.displayName} hasn't received the repayment from ${nameOf(p, i.fromMemberId)}`);
      }),

    startRound: (id, o) =>
      mutate(o, id, "ROUND_STARTED", () => {
        const p = proj(id);
        const m = ownerOnly(p);
        const last = active(p);
        if (last.round.status !== "SETTLED") fail(409, "INVALID_TRANSITION", "Finish the current round first.");
        const t = now();
        const r: MockRound = {
          round: blankRound(last.round.sequence + 1, t),
          entries: [],
          deleted: [],
          readiness: Object.fromEntries(p.members.filter((x) => x.status === "ACTIVE").map((x) => [x.id, { ready: false, markedAt: null }])),
          instructions: [],
        };
        p.rounds.push(r);
        p.project.activeRoundId = r.round.id;
        log(p, m.id, "ROUND_STARTED", r.round.id, null, `${m.displayName} started round ${r.round.sequence}`);
      }),
    getHistory: (id) =>
      delay(() => {
        const p = proj(id);
        memberOf(p);
        return { rounds: [...p.rounds].reverse().map((r) => ({ ...r.round })), events: p.events.map((e) => ({ ...e })) };
      }),
    exportCsv: (id) =>
      delay(() => {
        const p = proj(id);
        memberOf(p);
        const rows = [["round_id", "round", "entry_id", "type", "date", "description", "original_amount", "original_currency", "base_amount", "base_currency", "method", "rate", "rate_set_at", "member", "allocation_base"].join(",")];
        for (const r of p.rounds)
          for (const e of r.entries)
            for (const a of e.allocations.length ? e.allocations : (e.adjustmentEffects ?? []))
              rows.push(
                [r.round.id, r.round.sequence, e.id, e.type, e.occurredAt, JSON.stringify(e.description), e.originalAmount, e.originalCurrency, e.baseAmount, e.baseCurrency, e.conversion.method, e.conversion.rate, e.conversion.rateSetAt ?? "", JSON.stringify(nameOf(p, a.memberId)), a.baseAmount].join(","),
              );
        return rows.join("\n");
      }).then((csv) => new Blob([csv], { type: "text/csv" })),

    live(id, handlers) {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(handlers);
      const t = setTimeout(() => handlers.onStatus("open"), 60);
      return {
        close() {
          clearTimeout(t);
          listeners.get(id)?.delete(handlers);
        },
      };
    },

    DevPanel: () => null,
  };

  // ---------- dev panel: act as another member, reseed, simulate disconnects ----------
  const switchTo = (principalId: string | null) => {
    state.me = principalId;
    save(state);
    location.reload();
  };
  const simulateDisconnect = () => {
    for (const set of listeners.values())
      for (const h of set) {
        h.onStatus("reconnecting");
        setTimeout(() => {
          h.onStatus("open");
          h.onChange("reconnected");
        }, 4000);
      }
  };
  api.DevPanel = function MockDevPanel() {
    const [open, setOpen] = useState(false);
    if (new URLSearchParams(location.search).has("nodev")) return null;
    const h = createElement;
    const pill = { position: "fixed", top: 8, left: 8, zIndex: 100, font: "600 11px system-ui", background: "#1a1a1a", color: "#fff", borderRadius: 6, padding: "4px 8px", border: 0, opacity: 0.8 } as const;
    if (!open) return h("button", { style: pill, onClick: () => setOpen(true), "aria-label": "Mock tools" }, "MOCK");
    const who = state.me ? (state.principals[state.me]?.displayName ?? state.principals[state.me]?.email) : "signed out";
    const panel = { ...pill, opacity: 1, padding: 12, display: "flex", flexDirection: "column", gap: 8, width: 230 } as const;
    const btn = { font: "500 12px system-ui", padding: "5px 8px", borderRadius: 4, border: "1px solid #555", background: "#2a2a2a", color: "#fff", textAlign: "left" } as const;
    return h(
      "div",
      { style: panel },
      h("b", null, `Mock · acting as ${who}`),
      h(
        "select",
        { style: btn, value: state.me ?? "", onChange: (e: { target: { value: string } }) => switchTo(e.target.value || null) },
        h("option", { value: "" }, "Signed out"),
        ...Object.values(state.principals).map((p) => h("option", { key: p.id, value: p.id }, `${p.displayName ?? p.email}${p.email ? "" : " (guest)"}`)),
      ),
      ...(["collecting", "settling", "settled", "autofrozen"] as const).map((k) =>
        h("button", { key: k, style: btn, onClick: () => ((state = seed(k)), save(state), location.reload()) }, `Reset: Lisbon ${k}`),
      ),
      h("button", { style: btn, onClick: simulateDisconnect }, "Simulate disconnect (4s)"),
      h("a", { style: { ...btn, textDecoration: "none" }, href: "/join#p_porto.demo-invite-token-0001" }, "Open demo invitation"),
      h("button", { style: btn, onClick: () => setOpen(false) }, "Close"),
    );
  };

  return api;
}
