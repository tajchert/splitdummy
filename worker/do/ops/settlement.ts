/** Freeze, settlement instructions and round succession. */
import { FreezeSchema, InstructionActionSchema, type FreezeResultDTO, type InstructionResultDTO } from "@shared/api";
import { SETTLEMENT_ALGORITHM_VERSION, planSettlement } from "@shared/money";
import { conflict, forbidden, limitExceeded, notFound, notSettling, parseBody } from "../errors";
import { money } from "../format";
import { LIMITS } from "../limits";
import type { InstructionRow, RoundRow } from "../store";
import { newId, type Tx } from "../tx";
import type { DoRequest } from "../types";
import {
  computeRoundBalances,
  entryDto,
  instructionDto,
  rateDto,
  readinessList,
  roundDto,
  snapshotBalances,
  type SnapshotData,
} from "../views";
import { ok, type OpResult } from "./project";

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;

export function freeze(tx: Tx, req: DoRequest): OpResult {
  const owner = tx.owner("Only the group owner can freeze expenses.");
  const round = tx.collectingRound(req.params.roundId);
  const body = parseBody(FreezeSchema, req.body);
  if (body.expectedReviewVersion !== round.review_version) {
    throw conflict("REVIEW_STALE", "Something changed since you opened the review. Please review again.", {
      currentReviewVersion: round.review_version,
    });
  }
  const readiness = readinessList(tx.store, round.id);
  const notReady = readiness.filter((r) => !r.ready).map((r) => r.memberId);
  if (!sameSet([...new Set(body.acknowledgeNotReady)], notReady)) {
    throw conflict("NOT_READY_UNACKNOWLEDGED", "Confirm that you're freezing before everyone is ready.", { notReady });
  }
  const earlyFreezeReason = notReady.length > 0 ? body.earlyFreezeReason?.trim() || null : null;

  const project = tx.project;
  const members = tx.store.members();
  const entries = tx.store.roundEntries(round.id).map(entryDto);
  // computeBalances throws on a non-zero sum; that aborts the transaction and the round stays collecting.
  const balances = computeRoundBalances(members, entries);
  const nets: Record<string, bigint> = {};
  for (const b of balances) nets[b.memberId] = b.net;
  const plan = planSettlement(nets);

  const instructions = plan.map((t, position) => ({ id: newId("i"), position, ...t }));
  for (const i of instructions) {
    tx.store.run(
      `INSERT INTO instructions (id, round_id, position, from_member_id, to_member_id, amount, currency, exponent, state, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', 1)`,
      i.id,
      round.id,
      i.position,
      i.from,
      i.to,
      i.amount.toString(),
      project.base_currency,
      project.base_exponent,
    );
  }

  const snapshot: SnapshotData = {
    algorithmVersion: SETTLEMENT_ALGORITHM_VERSION,
    ledgerVersion: round.ledger_version,
    reviewVersion: round.review_version,
    cutoffAt: tx.now,
    frozenByMemberId: owner.id,
    members: members.map((m) => ({
      id: m.id,
      displayName: m.display_name,
      isOwner: m.id === project.owner_member_id,
      status: m.status,
    })),
    readiness,
    acknowledgedNotReady: notReady,
    earlyFreezeReason,
    rates: tx.store.rates().map(rateDto),
    entries,
    balances: snapshotBalances(balances),
    instructions: instructions.map((i) => ({
      id: i.id,
      fromMemberId: i.from,
      toMemberId: i.to,
      amount: i.amount.toString(),
    })),
  };
  tx.store.run(
    `INSERT INTO settlement_snapshots (round_id, ledger_version, review_version, cutoff_at, algorithm_version, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    round.id,
    round.ledger_version,
    round.review_version,
    tx.now,
    SETTLEMENT_ALGORITHM_VERSION,
    JSON.stringify(snapshot),
  );

  const settled = instructions.length === 0;
  tx.store.run(
    `UPDATE rounds SET status = ?, frozen_at = ?, frozen_by_member_id = ?, early_freeze_reason = ?, settled_at = ?
     WHERE id = ?`,
    settled ? "SETTLED" : "SETTLING",
    tx.now,
    owner.id,
    earlyFreezeReason,
    settled ? tx.now : null,
    round.id,
  );
  tx.audit("ROUND_FROZEN", `${owner.display_name} froze expenses for round ${round.sequence}`, {
    roundId: round.id,
    entityId: round.id,
    details: {
      ledgerVersion: round.ledger_version,
      reviewVersion: round.review_version,
      acknowledgedNotReady: notReady,
      earlyFreezeReason,
      algorithmVersion: SETTLEMENT_ALGORITHM_VERSION,
      instructionCount: instructions.length,
    },
  });
  const everyone = members.filter((m) => m.status !== "REMOVED").map((m) => m.id);
  tx.notify("ROUND_FROZEN", everyone, `Expenses in “${project.name}” are frozen. Settlement has started.`);
  if (settled) {
    tx.store.run("UPDATE project SET active_round_id = NULL WHERE id = ?", project.id);
    tx.audit("ROUND_SETTLED", `Round ${round.sequence} is all settled (nothing to repay)`, {
      roundId: round.id,
      entityId: round.id,
    });
    tx.notify("ROUND_SETTLED", everyone, `“${project.name}” is all settled.`);
  }
  return () => {
    const result: FreezeResultDTO = {
      round: roundDto(tx.store.round(round.id)!),
      instructions: tx.store.instructions(round.id).map(instructionDto),
    };
    return ok(result);
  };
}

type Action = "SENT" | "CONFIRMED" | "DISPUTED";

function instructionFor(tx: Tx, req: DoRequest): { round: RoundRow; instruction: InstructionRow } {
  const round = tx.store.round(req.params.roundId ?? "");
  if (!round) throw notFound("This round isn't available.");
  const instruction = tx.store.instruction(req.params.instructionId ?? "");
  if (!instruction || instruction.round_id !== round.id) throw notFound("This transfer isn't available.");
  return { round, instruction };
}

function result(tx: Tx, roundId: string, instructionId: string): OpResult {
  return () => {
    const body: InstructionResultDTO = {
      instruction: instructionDto(tx.store.instruction(instructionId)!),
      round: roundDto(tx.store.round(roundId)!),
    };
    return ok(body);
  };
}

function transition(tx: Tx, req: DoRequest, action: Action): OpResult {
  const me = tx.member();
  const { round, instruction } = instructionFor(tx, req);
  const body = parseBody(InstructionActionSchema, req.body);
  const isSender = instruction.from_member_id === me.id;
  const isRecipient = instruction.to_member_id === me.id;
  if (action === "SENT" && !isSender) throw forbidden("Only the sender can mark this transfer as sent.");
  if (action !== "SENT" && !isRecipient) throw forbidden("Only the recipient can confirm or dispute this transfer.");

  // Retries and double clicks of an action that already took effect are no-ops.
  const already =
    (action === "SENT" && instruction.state === "SENT") ||
    (action === "CONFIRMED" && instruction.state === "CONFIRMED") ||
    (action === "DISPUTED" && instruction.state === "DISPUTED");
  if (already) return result(tx, round.id, instruction.id);

  if (round.status !== "SETTLING") throw notSettling();
  const allowed: Record<Action, InstructionRow["state"][]> = {
    SENT: ["PROPOSED", "DISPUTED"],
    CONFIRMED: ["SENT", "DISPUTED"],
    DISPUTED: ["SENT"],
  };
  if (!allowed[action].includes(instruction.state)) {
    throw conflict("INVALID_TRANSITION", invalidTransitionMessage(action, instruction.state), {
      state: instruction.state,
    });
  }
  if (body.expectedRevision !== undefined && body.expectedRevision !== instruction.revision) {
    throw conflict("STALE_VERSION", "This transfer changed since you opened it.", { currentRevision: instruction.revision });
  }

  const revision = instruction.revision + 1;
  const project = tx.project;
  const members = new Map(tx.store.members().map((m) => [m.id, m.display_name]));
  const from = members.get(instruction.from_member_id) ?? "Someone";
  const to = members.get(instruction.to_member_id) ?? "someone";
  const amount = money(instruction.amount, instruction.exponent, instruction.currency);
  const auditOpts = { roundId: round.id, entityId: instruction.id, revision };

  if (action === "SENT") {
    tx.store.run(
      "UPDATE instructions SET state = 'SENT', sent_at = ?, revision = ? WHERE id = ?",
      tx.now,
      revision,
      instruction.id,
    );
    tx.audit("INSTRUCTION_SENT", `${from} sent ${amount} to ${to}`, auditOpts);
    tx.notify("TRANSFER_SENT", [instruction.to_member_id], `${from} says they sent you ${amount} in “${project.name}”.`);
  } else if (action === "DISPUTED") {
    const note = body.note?.trim() || null;
    tx.store.run(
      "UPDATE instructions SET state = 'DISPUTED', disputed_at = ?, dispute_note = ?, revision = ? WHERE id = ?",
      tx.now,
      note,
      revision,
      instruction.id,
    );
    tx.audit("INSTRUCTION_DISPUTED", `${to} has not received ${amount} from ${from}`, { ...auditOpts, details: { note } });
    tx.notify("TRANSFER_DISPUTED", [instruction.from_member_id], `${to} hasn't received ${amount} in “${project.name}”.`);
  } else {
    tx.store.run(
      "UPDATE instructions SET state = 'CONFIRMED', confirmed_at = ?, revision = ? WHERE id = ?",
      tx.now,
      revision,
      instruction.id,
    );
    // UNIQUE(instruction_id) makes a second confirmed transfer for the same instruction impossible.
    tx.store.run(
      `INSERT INTO confirmed_transfers (id, instruction_id, round_id, from_member_id, to_member_id, amount, currency, sent_at, confirmed_at, confirmed_by_member_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("t"),
      instruction.id,
      round.id,
      instruction.from_member_id,
      instruction.to_member_id,
      instruction.amount,
      instruction.currency,
      instruction.sent_at,
      tx.now,
      me.id,
    );
    tx.audit("INSTRUCTION_CONFIRMED", `${to} received ${amount} from ${from}`, auditOpts);
    tx.notify("TRANSFER_CONFIRMED", [instruction.from_member_id], `${to} confirmed receiving ${amount} in “${project.name}”.`);

    const open = tx.store.count(
      "SELECT COUNT(*) AS n FROM instructions WHERE round_id = ? AND state != 'CONFIRMED'",
      round.id,
    );
    if (open === 0) {
      tx.store.run("UPDATE rounds SET status = 'SETTLED', settled_at = ? WHERE id = ?", tx.now, round.id);
      tx.store.run("UPDATE project SET active_round_id = NULL WHERE id = ?", project.id);
      tx.audit("ROUND_SETTLED", `Round ${round.sequence} is all settled`, { roundId: round.id, entityId: round.id });
      const everyone = tx.store.members().filter((m) => m.status !== "REMOVED").map((m) => m.id);
      tx.notify("ROUND_SETTLED", everyone, `“${project.name}” is all settled.`);
    }
  }
  return result(tx, round.id, instruction.id);
}

function invalidTransitionMessage(action: Action, state: InstructionRow["state"]): string {
  if (state === "CONFIRMED") return "This transfer is already confirmed.";
  if (action === "SENT") return "This transfer can't be marked as sent right now.";
  return "The sender hasn't marked this transfer as sent yet.";
}

export const markSent = (tx: Tx, req: DoRequest) => transition(tx, req, "SENT");
export const markReceived = (tx: Tx, req: DoRequest) => transition(tx, req, "CONFIRMED");
export const markDisputed = (tx: Tx, req: DoRequest) => transition(tx, req, "DISPUTED");

export function startRound(tx: Tx): OpResult {
  const owner = tx.owner("Only the group owner can start a new round.");
  const project = tx.project;
  const latest = tx.store.latestRound();
  if (project.active_round_id || !latest || latest.status !== "SETTLED") {
    throw conflict("INVALID_TRANSITION", "The current round must be settled before starting a new one.");
  }
  if (tx.store.count("SELECT COUNT(*) AS n FROM rounds") >= LIMITS.rounds) {
    throw limitExceeded("This group has reached its round limit.");
  }
  const id = newId("r");
  const sequence = latest.sequence + 1;
  tx.store.run(
    "INSERT INTO rounds (id, sequence, status, ledger_version, review_version, created_at) VALUES (?, ?, 'COLLECTING', 0, 0, ?)",
    id,
    sequence,
    tx.now,
  );
  tx.store.run("UPDATE project SET active_round_id = ? WHERE id = ?", id, project.id);
  tx.audit("ROUND_STARTED", `${owner.display_name} started round ${sequence}`, { roundId: id, entityId: id });
  return () => ok(roundDto(tx.store.round(id)!), 201);
}
