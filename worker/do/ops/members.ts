/** Owner-managed membership: placeholders (no account yet), email invites that claim them, and renames. */
import { AddMemberSchema, RenameMemberSchema } from "@shared/api";
import { invalid, limitExceeded, notFound, parseBody } from "../errors";
import { LIMITS, MEMBER_INVITE_TTL_MS } from "../limits";
import { PLACEHOLDER_PREFIX, type MemberRow } from "../store";
import { newId, type Tx } from "../tx";
import type { DoRequest, DoResponse, DoTransient, MemberInviteMail } from "../types";
import { memberDto } from "../views";
import type { OpResult } from "./project";

export type InvitePrepared = { secret: string; secretHash: string };

/** MemberDTO as the owner sees it, built after finish() so it reflects the commit. */
export function memberResult(tx: Tx, memberId: string, status = 200, transient?: DoTransient): () => DoResponse {
  return () => ({
    status,
    body: memberDto(tx.store.member(memberId)!, tx.project, tx.store.isReferenced(memberId), true, tx.now),
    ...(transient ? { transient } : {}),
  });
}

function assertCapacity(tx: Tx): void {
  if (tx.store.count("SELECT COUNT(*) AS n FROM members WHERE status != 'REMOVED'") >= LIMITS.members) {
    throw limitExceeded(`A group can have at most ${LIMITS.members} members.`);
  }
  if (tx.store.count("SELECT COUNT(*) AS n FROM members") >= LIMITS.memberRows) {
    throw limitExceeded("This group has reached its membership limit.");
  }
}

/** One live invitation per address per group. */
function assertEmailFree(tx: Tx, email: string, exceptMemberId: string | null): void {
  const taken = tx.store.first<{ id: string }>(
    "SELECT id FROM members WHERE kind = 'PLACEHOLDER' AND status != 'REMOVED' AND invited_email = ? AND id != ?",
    email,
    exceptMemberId ?? "",
  );
  if (taken) throw invalid("email", "Someone in this group was already invited with this email.");
}

/** Stores the hash + expiry on the placeholder (replacing any earlier link) and returns the email to send. */
export function issueInvite(tx: Tx, member: MemberRow, email: string, prepared: InvitePrepared, origin: string): MemberInviteMail {
  const expiresAt = new Date(Date.parse(tx.now) + MEMBER_INVITE_TTL_MS).toISOString();
  tx.store.run(
    "UPDATE members SET invited_email = ?, invite_secret_hash = ?, invite_sent_at = ?, invite_expires_at = ? WHERE id = ?",
    email,
    prepared.secretHash,
    tx.now,
    expiresAt,
    member.id,
  );
  // History is visible to every member, so the address stays out of it.
  tx.audit("MEMBER_INVITED", `Invited ${member.display_name} by email`, { entityId: member.id, details: { expiresAt } });
  return {
    to: email,
    url: `${origin}/invite#${tx.project.id}.${prepared.secret}`,
    projectName: tx.project.name,
    inviterName: tx.member().display_name,
    displayName: member.display_name,
    expiresAt,
  };
}

export function addMember(tx: Tx, req: DoRequest, prepared: InvitePrepared, origin: string): OpResult {
  tx.owner("Only the group owner can add people.");
  tx.requireNotSettling();
  const body = parseBody(AddMemberSchema, req.body);
  assertCapacity(tx);
  if (body.email) assertEmailFree(tx, body.email, null);
  const id = newId("m");
  tx.store.run(
    `INSERT INTO members (id, principal_id, display_name, is_guest, has_recoverable_account, joined_at, status, kind)
     VALUES (?, ?, ?, 0, 0, ?, 'ACTIVE', 'PLACEHOLDER')`,
    id,
    `${PLACEHOLDER_PREFIX}${id}`,
    body.displayName,
    tx.now,
  );
  const member = tx.store.member(id)!;
  tx.audit("MEMBER_ADDED", `Added ${member.display_name}`, { roundId: tx.activeRound()?.id ?? null, entityId: id });
  const mail = body.email ? issueInvite(tx, member, body.email, prepared, origin) : undefined;
  return memberResult(tx, id, 201, mail ? { inviteMail: mail } : undefined);
}

export function renameMember(tx: Tx, req: DoRequest): OpResult {
  const owner = tx.owner("Only the group owner can rename other people.");
  const body = parseBody(RenameMemberSchema, req.body);
  const target = tx.store.member(req.params.memberId ?? "");
  if (!target || target.status === "REMOVED" || target.account_deleted === 1) throw notFound("This member isn't available.");
  if (body.displayName !== target.display_name) {
    tx.store.run("UPDATE members SET display_name = ? WHERE id = ?", body.displayName, target.id);
    tx.audit("MEMBER_RENAMED", `${owner.display_name} renamed ${target.display_name} to ${body.displayName}`, {
      roundId: tx.activeRound()?.id ?? null,
      entityId: target.id,
      details: { from: target.display_name, to: body.displayName, byMemberId: owner.id },
    });
  }
  return memberResult(tx, target.id);
}
