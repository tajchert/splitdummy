/** Account deletion support: the edge asks each project what deleting this principal means there. */
import type { OkDTO } from "@shared/api";
import { conflict, forbidden, notFound, unauthenticated } from "../errors";
import { money } from "../format";
import type { AuditRow, MemberRow } from "../store";
import type { Tx } from "../tx";
import type { DoResponse } from "../types";
import type { SnapshotData } from "../views";
import { ok } from "./project";

export const DELETED_ACCOUNT_NAME = "Deleted account";

export interface AccountDeletionInfo {
  role: "OWNER" | "MEMBER" | "NONE";
  name: string;
  memberCount: number;
  hasOpenTransfers: boolean;
}

/** The principal's membership, including removed members awaiting anonymization (undefined when there is none). */
function membership(tx: Tx): MemberRow | undefined {
  if (!tx.principal) throw unauthenticated();
  tx.requireProject();
  const m = tx.store.memberByPrincipal(tx.principal.principalId);
  return m && m.account_deleted !== 1 ? m : undefined;
}

/**
 * Settling transfers and collecting ledger references both require a live account.
 * Even a zero net can change when another expense is edited or deleted before freeze.
 */
function hasOpenTransfers(tx: Tx, memberId: string): boolean {
  const round = tx.activeRound();
  if (round?.status === "COLLECTING" && tx.store.count(
    `SELECT COUNT(*) AS n FROM entries e WHERE e.round_id = ?1 AND e.deleted = 0 AND (
       e.payer_member_id = ?2
       OR EXISTS (SELECT 1 FROM contributions c WHERE c.entry_id = e.id AND c.member_id = ?2)
       OR EXISTS (SELECT 1 FROM allocations a WHERE a.entry_id = e.id AND a.member_id = ?2)
       OR EXISTS (SELECT 1 FROM adjustment_effects x WHERE x.entry_id = e.id AND x.member_id = ?2))`,
    round.id,
    memberId,
  ) > 0) return true;
  return (
    tx.store.count(
      `SELECT COUNT(*) AS n FROM instructions i JOIN rounds r ON r.id = i.round_id
       WHERE r.status = 'SETTLING' AND i.state != 'CONFIRMED' AND (i.from_member_id = ?1 OR i.to_member_id = ?1)`,
      memberId,
    ) > 0
  );
}

/** Read-only. 404 only when the project doesn't exist (e.g. already deleted); non-members get role NONE. */
export function accountDeletionInfo(tx: Tx): DoResponse {
  const me = membership(tx);
  const project = tx.project;
  const body: AccountDeletionInfo = {
    role: !me ? "NONE" : project.owner_member_id === me.id ? "OWNER" : "MEMBER",
    name: project.name,
    memberCount: tx.store.count("SELECT COUNT(*) AS n FROM members WHERE status != 'REMOVED' AND account_deleted = 0"),
    hasOpenTransfers: me ? hasOpenTransfers(tx, me.id) : false,
  };
  return ok(body);
}

/** Owner check for deleteProject; returns every principal that had a membership row. */
export function deletionPrincipals(tx: Tx): string[] {
  const me = membership(tx);
  if (!me) throw notFound();
  if (tx.project.owner_member_id !== me.id) throw forbidden("Only the group owner can delete the group.");
  return tx.store.members().filter((m) => m.account_deleted !== 1).map((m) => m.principal_id);
}

/**
 * The member's account is gone: keep every ledger and transfer reference (member ID) but drop the
 * name and the link to the principal. Idempotent: once anonymized, the principal no longer matches.
 */
export function anonymizeMember(tx: Tx): DoResponse {
  const me = membership(tx);
  anonymizeRetiredRows(tx);
  const OK: OkDTO = { ok: true };
  if (!me) return ok(OK);
  const project = tx.project;
  if (project.owner_member_id === me.id) {
    throw conflict("INVALID_TRANSITION", "The owner's group is deleted with the account, not anonymized.");
  }
  if (hasOpenTransfers(tx, me.id)) {
    throw conflict("ACCOUNT_HAS_OPEN_TRANSFERS", "Settle your expenses and confirm your transfers before deleting your account.", {
      projects: [{ id: project.id, name: project.name }],
    });
  }
  tx.setActor(me);
  // Readiness first, while they still count as an active member of the collecting round.
  tx.clearReadiness([me.id]);
  const round = tx.activeRound();
  const leave = me.status === "ACTIVE" && round?.status !== "SETTLING";
  tx.store.run(
    `UPDATE members SET display_name = ?, account_deleted = 1, principal_id = ?, has_recoverable_account = 0, invited_email = NULL,
       status = ?, status_changed_at = ? WHERE id = ?`,
    DELETED_ACCOUNT_NAME,
    `deleted_${me.id}`,
    leave ? "LEFT" : me.status,
    leave ? tx.now : me.status_changed_at,
    me.id,
  );
  if (project.pending_owner_member_id === me.id) {
    tx.store.run("UPDATE project SET pending_owner_member_id = NULL WHERE id = ?", project.id);
  }
  // Frozen snapshots keep the member ID for the accounting; only the name goes.
  for (const row of tx.store.all<{ round_id: string; snapshot_json: string }>("SELECT round_id, snapshot_json FROM settlement_snapshots")) {
    const snap = JSON.parse(row.snapshot_json) as SnapshotData;
    const entry = snap.members.find((m) => m.id === me.id);
    if (!entry || entry.displayName === DELETED_ACCOUNT_NAME) continue;
    entry.displayName = DELETED_ACCOUNT_NAME;
    tx.store.run("UPDATE settlement_snapshots SET snapshot_json = ? WHERE round_id = ?", JSON.stringify(snap), row.round_id);
  }
  anonymizeAudit(tx, me.id);
  tx.audit("MEMBER_ACCOUNT_DELETED", "A member deleted their account", { roundId: round?.id ?? null, entityId: me.id });
  tx.disconnect.push(me.id);
  return ok(OK);
}

/**
 * Rows of this account that a later invite claim retired (`ph:retired:<principalId>:<memberId>`)
 * are the same person's earlier membership: scrub them like any removed member.
 */
function anonymizeRetiredRows(tx: Tx): void {
  const principalId = tx.principal!.principalId;
  const rows = tx.store.all<MemberRow>(
    "SELECT * FROM members WHERE principal_id LIKE ? ESCAPE '\\'",
    `ph:retired:${principalId.replace(/[\\%_]/g, "\\$&")}:%`,
  );
  for (const row of rows) {
    tx.store.run(
      "UPDATE members SET display_name = ?, account_deleted = 1, principal_id = ?, has_recoverable_account = 0, invited_email = NULL WHERE id = ?",
      DELETED_ACCOUNT_NAME,
      `deleted_${row.id}`,
      row.id,
    );
    anonymizeAudit(tx, row.id);
  }
}

/** Redact system-generated identity labels, keeping action, IDs and financial details. */
function anonymizeAudit(tx: Tx, memberId: string): void {
  const events = tx.store.all<AuditRow>(
    `SELECT * FROM audit_events WHERE actor_member_id = ?1 OR entity_id = ?1
       OR entity_id IN (SELECT id FROM instructions WHERE from_member_id = ?1 OR to_member_id = ?1)`,
    memberId,
  );
  for (const event of events) {
    let summary = `Activity involving a deleted account: ${event.action.toLowerCase().replaceAll("_", " ")}`;
    let details = event.details_json;
    if ((event.action === "MEMBER_RENAMED" || (event.action === "MEMBER_CLAIMED" && details)) && event.entity_id === memberId) {
      details = JSON.stringify({ from: DELETED_ACCOUNT_NAME, to: DELETED_ACCOUNT_NAME });
    }
    // Transfer amounts have no duplicate in audit details; retain them in the label.
    const instruction = event.entity_id && event.action.startsWith("INSTRUCTION_")
      ? tx.store.instruction(event.entity_id) : undefined;
    if (instruction) {
      const from = tx.store.member(instruction.from_member_id)!.display_name;
      const to = tx.store.member(instruction.to_member_id)!.display_name;
      const amount = money(instruction.amount, instruction.exponent, instruction.currency);
      if (event.action === "INSTRUCTION_SENT") summary = `${from} sent ${amount} to ${to}`;
      if (event.action === "INSTRUCTION_CONFIRMED") summary = `${to} received ${amount} from ${from}`;
      if (event.action === "INSTRUCTION_DISPUTED") summary = `${to} has not received ${amount} from ${from}`;
    }
    tx.store.run("UPDATE audit_events SET summary = ?, details_json = ? WHERE id = ?", summary, details, event.id);
  }
}
