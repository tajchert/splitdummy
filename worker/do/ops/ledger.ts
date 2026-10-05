/** Ledger ops: expenses, refunds, adjustments, readiness. All require the active collecting round. */
import {
  AdjustmentInputSchema,
  DeleteEntrySchema,
  EntryInputSchema,
  ReadinessSchema,
  UpdateEntrySchema,
  type EntryInput,
  type OkDTO,
  type ReadinessDTO,
} from "@shared/api";
import {
  MAX_MINOR,
  computeEntry,
  getCurrency,
  parseRate,
  rateToString,
  type ComputedEntry,
  type ConversionInput,
  type EntryComputationError,
  type Shares,
} from "@shared/money";
import { ApiError, conflict, forbidden, invalid, limitExceeded, notFound, parseBody } from "../errors";
import { money } from "../format";
import { LIMITS } from "../limits";
import type { EntryRow, MemberRow, RoundRow } from "../store";
import { newId, type Tx } from "../tx";
import type { DoRequest } from "../types";
import { entryDto } from "../views";
import { extrasSummary, normalizeNote, setEntryAttachments, trashEntryAttachments } from "./attachments";
import { ok, rateErrorMessage, type OpResult } from "./project";

interface PreparedEntry {
  input: EntryInput;
  currency: { code: string; exponent: number };
  computed: ComputedEntry;
  method: ConversionInput["method"];
  rateSource: EntryRow["rate_source"];
  rateSetBy: string | null;
  rateSetAt: string | null;
  note: string | null;
}

function liveMember(tx: Tx, memberId: string): MemberRow | undefined {
  const m = tx.store.member(memberId);
  return m && m.status !== "REMOVED" && m.account_deleted !== 1 ? m : undefined;
}

const COMPUTE_ERRORS: Record<EntryComputationError, [field: string, message: string]> = {
  NO_PARTICIPANTS: ["participants", "Pick at least one person"],
  EXACT_SUM_MISMATCH: ["participants", "The amounts must add up to the total"],
  NEGATIVE_SHARE: ["participants", "Amounts can't be negative"],
  IDENTITY_EXPONENT_MISMATCH: ["conversion", "This currency needs an exchange rate"],
  BASE_ROUNDS_TO_ZERO: ["conversion", "This amount converts to less than the smallest unit of the settlement currency"],
  BASE_NOT_POSITIVE: ["conversion.baseAmount", "The converted amount must be greater than zero"],
  TOO_LARGE: ["originalAmount", "That amount is too large"],
};

/** Validate an expense/refund against current project state and compute its stored effect. */
function prepareEntry(tx: Tx, input: EntryInput, actor: MemberRow): PreparedEntry {
  const project = tx.project;
  const currency = getCurrency(input.originalCurrency);
  if (!currency) throw invalid("originalCurrency", "Choose a supported currency");
  const foreign = currency.code !== project.base_currency;
  if (foreign && project.multi_currency_enabled !== 1) {
    throw conflict(
      "MULTI_CURRENCY_DISABLED",
      `This group only accepts expenses in ${project.base_currency}. Nothing was saved.`,
    );
  }

  const originalAmount = BigInt(input.originalAmount);
  if (originalAmount > MAX_MINOR) throw invalid("originalAmount", "That amount is too large");

  let conversion: ConversionInput;
  let rateSource: EntryRow["rate_source"];
  let rateSetBy: string | null = actor.id;
  let rateSetAt: string | null = tx.now;
  let note: string | null = null;
  const c = input.conversion;
  if (!foreign) {
    if (c.method !== "IDENTITY") {
      throw invalid("conversion.method", `Expenses in ${project.base_currency} don't need a conversion`);
    }
    conversion = { method: "IDENTITY" };
    rateSource = "IDENTITY";
    rateSetBy = null;
    rateSetAt = null;
  } else if (c.method === "MANUAL_RATE") {
    const parsed = parseRate(c.rate);
    if (!parsed.ok) throw invalid("conversion.rate", rateErrorMessage(parsed.error));
    conversion = { method: "MANUAL_RATE", rate: parsed.value };
    const saved = tx.store.rate(currency.code);
    if (saved && saved.rate === rateToString(parsed.value)) {
      rateSource = "OWNER_DEFAULT";
      rateSetBy = saved.set_by_member_id;
      rateSetAt = saved.set_at;
    } else {
      rateSource = "ENTRY_OVERRIDE";
    }
    note = c.note?.trim() || null;
  } else if (c.method === "ACTUAL_BASE_AMOUNT") {
    const baseAmount = BigInt(c.baseAmount);
    if (baseAmount > MAX_MINOR) throw invalid("conversion.baseAmount", "That amount is too large");
    conversion = { method: "ACTUAL_BASE_AMOUNT", baseAmount };
    rateSource = "ACTUAL_CHARGE";
    note = c.note?.trim() || null;
  } else {
    throw invalid("conversion", `Enter an exchange rate or the amount charged in ${project.base_currency}`);
  }

  if (!liveMember(tx, input.payerMemberId)) {
    throw invalid("payerMemberId", input.type === "EXPENSE" ? "Choose who paid" : "Choose who received the refund");
  }
  const seen = new Set<string>();
  input.participants.forEach((p, i) => {
    if (seen.has(p.memberId)) throw invalid(`participants.${i}.memberId`, "This person is listed twice");
    seen.add(p.memberId);
    if (!liveMember(tx, p.memberId)) throw invalid(`participants.${i}.memberId`, "This person isn't in the group");
  });

  let participants: string[] | Shares;
  if (input.splitMode === "EQUAL") {
    participants = input.participants.map((p) => p.memberId);
  } else {
    const shares: Shares = {};
    input.participants.forEach((p, i) => {
      if (p.amount === undefined) throw invalid(`participants.${i}.amount`, "Enter an amount");
      const amount = BigInt(p.amount);
      if (amount < 0n) throw invalid(`participants.${i}.amount`, "Amounts can't be negative");
      shares[p.memberId] = amount;
    });
    participants = shares;
  }

  const result = computeEntry({
    type: input.type,
    originalAmount,
    originalExponent: currency.exponent,
    baseExponent: project.base_exponent,
    conversion,
    payerMemberId: input.payerMemberId,
    splitMode: input.splitMode,
    participants,
  });
  if (!result.ok) {
    const [field, message] = COMPUTE_ERRORS[result.error];
    throw invalid(field, message, { reason: result.error });
  }
  if (result.value.baseAmount > MAX_MINOR) throw invalid("originalAmount", "That amount is too large");
  if (Number.isNaN(Date.parse(input.occurredAt))) throw invalid("occurredAt", "Enter a valid date");

  return {
    input,
    currency,
    computed: result.value,
    method: conversion.method,
    rateSource,
    rateSetBy,
    rateSetAt,
    note,
  };
}

/** Cumulative absolute base total of a round must stay within MAX_MINOR. */
function checkRoundTotal(tx: Tx, roundId: string, addBase: bigint, excludeEntryId: string | null): void {
  const rows = tx.store.all<{ base_amount: string }>(
    "SELECT base_amount FROM entries WHERE round_id = ? AND deleted = 0 AND id != ?",
    roundId,
    excludeEntryId ?? "",
  );
  let total = addBase;
  for (const r of rows) total += BigInt(r.base_amount);
  if (total > MAX_MINOR) {
    throw new ApiError(422, "LIMIT_EXCEEDED", "This round's total would exceed the maximum allowed.", "originalAmount");
  }
}

function checkEntryCount(tx: Tx, roundId: string): void {
  if (tx.store.count("SELECT COUNT(*) AS n FROM entries WHERE round_id = ?", roundId) >= LIMITS.entriesPerRound) {
    throw limitExceeded(`A round can have at most ${LIMITS.entriesPerRound} entries.`);
  }
}

function writeSplits(tx: Tx, entryId: string, p: PreparedEntry): void {
  tx.store.run("DELETE FROM contributions WHERE entry_id = ?", entryId);
  tx.store.run("DELETE FROM allocations WHERE entry_id = ?", entryId);
  const c = p.computed;
  for (const id of Object.keys(c.originalContributions).sort()) {
    tx.store.run(
      "INSERT INTO contributions (entry_id, member_id, original_amount, base_amount) VALUES (?, ?, ?, ?)",
      entryId,
      id,
      c.originalContributions[id]!.toString(),
      (c.baseContributions[id] ?? 0n).toString(),
    );
  }
  for (const id of Object.keys(c.originalAllocations).sort()) {
    tx.store.run(
      "INSERT INTO allocations (entry_id, member_id, original_amount, base_amount) VALUES (?, ?, ?, ?)",
      entryId,
      id,
      c.originalAllocations[id]!.toString(),
      (c.baseAllocations[id] ?? 0n).toString(),
    );
  }
}

function lockBaseCurrency(tx: Tx): void {
  tx.store.run("UPDATE project SET base_currency_locked = 1 WHERE id = ?", tx.project.id);
}

function describe(p: PreparedEntry): string {
  return money(p.input.originalAmount, p.currency.exponent, p.currency.code);
}

export function createEntry(tx: Tx, req: DoRequest): OpResult {
  const me = tx.member();
  const round = tx.collectingRound(req.params.roundId);
  const input = parseBody(EntryInputSchema, req.body);
  checkEntryCount(tx, round.id);
  const p = prepareEntry(tx, input, me);
  checkRoundTotal(tx, round.id, p.computed.baseAmount, null);
  const project = tx.project;
  const id = newId("e");
  tx.store.run(
    `INSERT INTO entries (id, round_id, type, creator_member_id, occurred_at, description,
       original_amount, original_currency, original_exponent, base_amount, base_currency, base_exponent,
       conversion_method, rate, rate_source, rate_set_by_member_id, rate_set_at, conversion_note,
       payer_member_id, split_mode, note, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    id,
    round.id,
    input.type,
    me.id,
    input.occurredAt,
    input.description,
    input.originalAmount,
    p.currency.code,
    p.currency.exponent,
    p.computed.baseAmount.toString(),
    project.base_currency,
    project.base_exponent,
    p.method,
    p.computed.rateString,
    p.rateSource,
    p.rateSetBy,
    p.rateSetAt,
    p.note,
    input.payerMemberId,
    input.splitMode,
    normalizeNote(input.note),
    tx.now,
    tx.now,
  );
  writeSplits(tx, id, p);
  if (input.attachmentIds?.length) setEntryAttachments(tx, id, input.attachmentIds, me);
  lockBaseCurrency(tx);
  tx.financial();
  tx.clearReadiness([me.id]);
  const label = input.type === "EXPENSE" ? "expense" : "refund";
  tx.audit(input.type === "EXPENSE" ? "ENTRY_CREATED" : "REFUND_CREATED", `${me.display_name} added ${label} “${input.description}” ${describe(p)}`, {
    roundId: round.id,
    entityId: id,
    revision: 1,
    details: { after: entryDto(tx.store.loadEntry(id)!) },
  });
  return () => ok(entryDto(tx.store.loadEntry(id)!), 201);
}

/** Entry named in the path, in the named round, not deleted, editable by the actor. */
function editableEntry(tx: Tx, req: DoRequest, round: RoundRow, me: MemberRow): EntryRow {
  const row = tx.store.entryRow(req.params.entryId ?? "");
  if (!row || row.round_id !== round.id || row.deleted === 1) throw notFound("This entry isn't available.");
  if (row.creator_member_id !== me.id && tx.project.owner_member_id !== me.id) {
    throw forbidden("Only the person who added this entry or the group owner can change it.");
  }
  return row;
}

function checkRevision(row: EntryRow, expected: number): void {
  if (row.revision !== expected) {
    throw conflict("STALE_VERSION", "Someone changed this entry since you opened it. Review the latest version.", {
      currentRevision: row.revision,
    });
  }
}

export function updateEntry(tx: Tx, req: DoRequest): OpResult {
  const me = tx.member();
  const round = tx.collectingRound(req.params.roundId);
  const body = parseBody(UpdateEntrySchema, req.body);
  const row = editableEntry(tx, req, round, me);
  if (row.type === "ADJUSTMENT") {
    throw conflict("INVALID_TRANSITION", "Adjustments can't be edited. Delete it and create a new one.");
  }
  checkRevision(row, body.expectedRevision);
  const { expectedRevision: _, ...input } = body;
  const p = prepareEntry(tx, input, me);
  checkRoundTotal(tx, round.id, p.computed.baseAmount, row.id);
  const before = entryDto(tx.store.loadEntry(row.id)!);
  const project = tx.project;
  const revision = row.revision + 1;
  const note = input.note === undefined ? row.note : normalizeNote(input.note);
  tx.store.run(
    `UPDATE entries SET type = ?, last_edited_by_member_id = ?, occurred_at = ?, description = ?,
       original_amount = ?, original_currency = ?, original_exponent = ?, base_amount = ?, base_currency = ?, base_exponent = ?,
       conversion_method = ?, rate = ?, rate_source = ?, rate_set_by_member_id = ?, rate_set_at = ?, conversion_note = ?,
       payer_member_id = ?, split_mode = ?, note = ?, revision = ?, updated_at = ?
     WHERE id = ?`,
    input.type,
    me.id,
    input.occurredAt,
    input.description,
    input.originalAmount,
    p.currency.code,
    p.currency.exponent,
    p.computed.baseAmount.toString(),
    project.base_currency,
    project.base_exponent,
    p.method,
    p.computed.rateString,
    p.rateSource,
    p.rateSetBy,
    p.rateSetAt,
    p.note,
    input.payerMemberId,
    input.splitMode,
    note,
    revision,
    tx.now,
    row.id,
  );
  writeSplits(tx, row.id, p);
  if (input.attachmentIds !== undefined) setEntryAttachments(tx, row.id, input.attachmentIds, me);
  tx.financial();
  tx.clearReadiness([me.id, row.creator_member_id]);
  const after = entryDto(tx.store.loadEntry(row.id)!);
  const extras = extrasSummary(before, after);
  tx.audit("ENTRY_UPDATED", `${me.display_name} edited “${input.description}” ${describe(p)}${extras.map((x) => ` · ${x}`).join("")}`, {
    roundId: round.id,
    entityId: row.id,
    revision,
    details: { creatorMemberId: row.creator_member_id, before, after },
  });
  return () => ok(entryDto(tx.store.loadEntry(row.id)!));
}

export function deleteEntry(tx: Tx, req: DoRequest): OpResult {
  const me = tx.member();
  const round = tx.collectingRound(req.params.roundId);
  const body = parseBody(DeleteEntrySchema, req.body);
  const row = editableEntry(tx, req, round, me);
  if (row.type === "ADJUSTMENT" && tx.project.owner_member_id !== me.id) {
    throw forbidden("Only the group owner can remove adjustments.");
  }
  checkRevision(row, body.expectedRevision);
  const before = entryDto(tx.store.loadEntry(row.id)!);
  const revision = row.revision + 1;
  tx.store.run(
    "UPDATE entries SET deleted = 1, deleted_at = ?, deleted_by_member_id = ?, revision = ?, updated_at = ? WHERE id = ?",
    tx.now,
    me.id,
    revision,
    tx.now,
    row.id,
  );
  trashEntryAttachments(tx, row.id);
  tx.financial();
  tx.clearReadiness([me.id, row.creator_member_id]);
  tx.audit("ENTRY_DELETED", `${me.display_name} deleted “${row.description}” ${money(row.original_amount, row.original_exponent, row.original_currency)}`, {
    roundId: round.id,
    entityId: row.id,
    revision,
    details: { creatorMemberId: row.creator_member_id, before },
  });
  const result: OkDTO = { ok: true };
  return ok(result);
}

export function createAdjustment(tx: Tx, req: DoRequest): OpResult {
  const owner = tx.owner("Only the group owner can create adjustments.");
  const round = tx.collectingRound(req.params.roundId);
  const input = parseBody(AdjustmentInputSchema, req.body);
  checkEntryCount(tx, round.id);

  const corrected = tx.store.round(input.correctedRoundId);
  if (!corrected || corrected.id === round.id || corrected.status === "COLLECTING") {
    throw invalid("correctedRoundId", "Choose an earlier, frozen round");
  }
  const target = tx.store.entryRow(input.correctedEntryId);
  if (!target || target.round_id !== corrected.id || target.deleted === 1) {
    throw invalid("correctedEntryId", "Choose an entry from that round");
  }
  if (Number.isNaN(Date.parse(input.occurredAt))) throw invalid("occurredAt", "Enter a valid date");

  const effects: Shares = {};
  let sum = 0n;
  let positive = 0n;
  let nonZero = 0;
  const seen = new Set<string>();
  input.effects.forEach((e, i) => {
    if (seen.has(e.memberId)) throw invalid(`effects.${i}.memberId`, "This person is listed twice");
    seen.add(e.memberId);
    if (!liveMember(tx, e.memberId)) throw invalid(`effects.${i}.memberId`, "This person isn't in the group");
    const amount = BigInt(e.baseAmount);
    if ((amount < 0n ? -amount : amount) > MAX_MINOR) throw invalid(`effects.${i}.baseAmount`, "That amount is too large");
    sum += amount;
    if (amount !== 0n) {
      nonZero++;
      effects[e.memberId] = amount;
      if (amount > 0n) positive += amount;
    }
  });
  if (nonZero < 2) throw invalid("effects", "An adjustment needs at least two people with a non-zero amount");
  if (sum !== 0n) throw invalid("effects", "Adjustment amounts must add up to zero", { sum: sum.toString() });
  checkRoundTotal(tx, round.id, positive, null);

  const project = tx.project;
  const id = newId("e");
  tx.store.run(
    `INSERT INTO entries (id, round_id, type, creator_member_id, occurred_at, description,
       original_amount, original_currency, original_exponent, base_amount, base_currency, base_exponent,
       conversion_method, rate, rate_source, corrected_entry_id, corrected_round_id, revision, created_at, updated_at)
     VALUES (?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IDENTITY', '1', 'IDENTITY', ?, ?, 1, ?, ?)`,
    id,
    round.id,
    owner.id,
    input.occurredAt,
    input.description,
    positive.toString(),
    project.base_currency,
    project.base_exponent,
    positive.toString(),
    project.base_currency,
    project.base_exponent,
    target.id,
    corrected.id,
    tx.now,
    tx.now,
  );
  for (const memberId of Object.keys(effects).sort()) {
    tx.store.run(
      "INSERT INTO adjustment_effects (entry_id, member_id, base_amount) VALUES (?, ?, ?)",
      id,
      memberId,
      effects[memberId]!.toString(),
    );
  }
  lockBaseCurrency(tx);
  tx.financial();
  tx.clearReadiness([owner.id]);
  tx.audit("ADJUSTMENT_CREATED", `${owner.display_name} added adjustment “${input.description}” correcting round ${corrected.sequence}`, {
    roundId: round.id,
    entityId: id,
    revision: 1,
    details: { correctedEntryId: target.id, correctedRoundId: corrected.id, effects: input.effects },
  });
  return () => ok(entryDto(tx.store.loadEntry(id)!), 201);
}

export function setReadiness(tx: Tx, req: DoRequest): OpResult {
  const me = tx.member();
  const round = tx.collectingRound(req.params.roundId);
  const body = parseBody(ReadinessSchema, req.body);
  if (me.status !== "ACTIVE") throw conflict("INVALID_TRANSITION", "You have left this group.");
  const current = tx.store.first<{ ready: number; marked_at: string | null }>(
    "SELECT ready, marked_at FROM readiness WHERE round_id = ? AND member_id = ?",
    round.id,
    me.id,
  );
  const ready = body.ready ? 1 : 0;
  if ((current?.ready ?? 0) !== ready) {
    tx.store.run(
      `INSERT INTO readiness (round_id, member_id, ready, marked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(round_id, member_id) DO UPDATE SET ready = excluded.ready, marked_at = excluded.marked_at`,
      round.id,
      me.id,
      ready,
      tx.now,
    );
    tx.reviewTouched();
    tx.audit(
      body.ready ? "READY_SET" : "READY_CLEARED",
      body.ready ? `${me.display_name} has added everything` : `${me.display_name} is still adding expenses`,
      { roundId: round.id, entityId: me.id },
    );
  }
  const row = tx.store.first<{ ready: number; marked_at: string | null }>(
    "SELECT ready, marked_at FROM readiness WHERE round_id = ? AND member_id = ?",
    round.id,
    me.id,
  );
  const result: ReadinessDTO = { memberId: me.id, ready: row?.ready === 1, markedAt: row?.marked_at ?? null };
  return ok(result);
}
