/** Account deletion support: the edge asks each project what deleting this principal means there. */
import type { OkDTO } from "@shared/api";
import { conflict, forbidden, notFound, unauthenticated } from "../errors";
import type { MemberRow } from "../store";
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

/** The principal's current, non-removed membership (undefined when there is none). */
function membership(tx: Tx): MemberRow | undefined {
  if (!tx.principal) throw unauthenticated();
  tx.requireProject();
  const m = tx.store.memberByPrincipal(tx.principal.principalId);
  return m && m.status !== "REMOVED" && m.account_deleted !== 1 ? m : undefined;
}

/** Any unconfirmed transfer in a settling round where the member sends or receives. */
function hasOpenTransfers(tx: Tx, memberId: string): boolean {
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
  const OK: OkDTO = { ok: true };
  if (!me) return ok(OK);
  const project = tx.project;
  if (project.owner_member_id === me.id) {
    throw conflict("INVALID_TRANSITION", "The owner's group is deleted with the account, not anonymized.");
  }
  if (hasOpenTransfers(tx, me.id)) {
    throw conflict("ACCOUNT_HAS_OPEN_TRANSFERS", "Confirm your open transfers before deleting your account.", {
      projects: [{ id: project.id, name: project.name }],
    });
  }
  tx.setActor(me);
  // Readiness first, while they still count as an active member of the collecting round.
  tx.clearReadiness([me.id]);
  const round = tx.activeRound();
  const leave = me.status === "ACTIVE" && round?.status !== "SETTLING";
  tx.store.run(
    `UPDATE members SET display_name = ?, account_deleted = 1, principal_id = ?, has_recoverable_account = 0,
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
  tx.audit("MEMBER_ACCOUNT_DELETED", "A member deleted their account", { roundId: round?.id ?? null, entityId: me.id });
  tx.disconnect.push(me.id);
  return ok(OK);
}
