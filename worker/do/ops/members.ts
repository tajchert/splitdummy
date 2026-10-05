/** Owner-managed membership: placeholders (no account yet), email invites that claim them, and renames. */
import { AddMemberSchema, DisplayNameSchema, InviteMemberSchema, RenameMemberSchema, type JoinResultDTO, type MemberInvitePreviewDTO } from "@shared/api";
import { z } from "zod";
import { ApiError, conflict, forbidden, invalid, limitExceeded, notFound, parseBody } from "../errors";
import { LIMITS, MEMBER_INVITE_TTL_MS } from "../limits";
import { PLACEHOLDER_PREFIX, type MemberRow } from "../store";
import { newId, type Tx } from "../tx";
import type { DoRequest, DoResponse, DoTransient, MemberInviteMail, Principal } from "../types";
import { memberDto } from "../views";
import { ok, type OpResult } from "./project";

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

function placeholderParam(tx: Tx, req: DoRequest): MemberRow {
  const target = tx.store.member(req.params.memberId ?? "");
  if (!target || target.status === "REMOVED") throw notFound("This member isn't available.");
  if (target.kind !== "PLACEHOLDER") throw conflict("INVALID_TRANSITION", `${target.display_name} has already joined.`);
  return target;
}

export function inviteMember(tx: Tx, req: DoRequest, prepared: InvitePrepared, origin: string): OpResult {
  tx.owner("Only the group owner can invite people.");
  tx.requireNotSettling();
  const body = parseBody(InviteMemberSchema, req.body);
  const target = placeholderParam(tx, req);
  assertEmailFree(tx, body.email, target.id);
  const mail = issueInvite(tx, target, body.email, prepared, origin);
  return memberResult(tx, target.id, 200, { inviteMail: mail });
}

export function cancelMemberInvite(tx: Tx, req: DoRequest): OpResult {
  tx.owner("Only the group owner can manage invitations.");
  tx.requireNotSettling();
  const target = placeholderParam(tx, req);
  if (target.invited_email !== null) {
    tx.store.run(
      "UPDATE members SET invited_email = NULL, invite_secret_hash = NULL, invite_sent_at = NULL, invite_expires_at = NULL WHERE id = ?",
      target.id,
    );
    tx.audit("MEMBER_INVITE_CANCELLED", `Cancelled the email invitation for ${target.display_name}`, { entityId: target.id });
  }
  return memberResult(tx, target.id);
}

/** Cancelled and rotated links are unknown hashes (404). Claimed links keep their hash and report CLAIMED. */
function inviteByHash(tx: Tx, secretHash: string): MemberRow {
  const m = tx.store.first<MemberRow>("SELECT * FROM members WHERE invite_secret_hash = ?", secretHash);
  if (!m || m.status === "REMOVED" || !tx.store.project()) {
    throw new ApiError(404, "INVITE_INVALID", "This invitation link isn't valid anymore. Ask the owner to send a new one.");
  }
  return m;
}

function memberInviteStatus(tx: Tx, m: MemberRow): MemberInvitePreviewDTO["status"] {
  if (m.kind !== "PLACEHOLDER") return "CLAIMED";
  return Date.parse(m.invite_expires_at!) <= Date.parse(tx.now) ? "EXPIRED" : "OPEN";
}

export function previewMemberInvite(tx: Tx, prepared: { secretHash: string }): DoResponse {
  const m = inviteByHash(tx, prepared.secretHash);
  const project = tx.project;
  const mine = tx.principal ? tx.store.memberByPrincipal(tx.principal.principalId) : undefined;
  const body: MemberInvitePreviewDTO = {
    projectName: project.name,
    baseCurrency: project.base_currency,
    displayName: m.display_name,
    status: memberInviteStatus(tx, m),
    canRename: project.members_can_rename === 1,
    alreadyMemberProjectId: mine && mine.status === "ACTIVE" ? project.id : null,
  };
  return { status: 200, body, transient: { invitedEmail: m.invited_email! } };
}

/** Placeholder whose live email invite matches a verified address (used by link joins too). */
export function findInvitedPlaceholder(tx: Tx, email: string): MemberRow | undefined {
  return tx.store.first<MemberRow>(
    "SELECT * FROM members WHERE kind = 'PLACEHOLDER' AND status = 'ACTIVE' AND invited_email = ?",
    email,
  );
}

/**
 * The principal takes over the placeholder: same member id, so every entry and transfer carries over.
 * Callers guarantee the principal has no ACTIVE/LEFT member here; a REMOVED one is retired first so
 * the UNIQUE principal_id can move.
 */
export function claimPlaceholder(tx: Tx, m: MemberRow, principal: Principal, displayName: string | undefined): MemberRow {
  const previous = tx.store.memberByPrincipal(principal.principalId);
  if (previous && previous.id !== m.id) {
    tx.store.run("UPDATE members SET principal_id = ? WHERE id = ?", `${PLACEHOLDER_PREFIX}${previous.id}`, previous.id);
  }
  const rename = displayName !== undefined && tx.project.members_can_rename === 1 && displayName !== m.display_name;
  tx.store.run(
    "UPDATE members SET principal_id = ?, kind = 'PERSON', is_guest = ?, has_recoverable_account = ?, display_name = ? WHERE id = ?",
    principal.principalId,
    principal.kind === "GUEST" ? 1 : 0,
    principal.hasRecoverableAccount ? 1 : 0,
    rename ? displayName : m.display_name,
    m.id,
  );
  const member = tx.store.member(m.id)!;
  tx.setActor(member);
  tx.audit("MEMBER_CLAIMED", `${member.display_name} joined`, {
    roundId: tx.activeRound()?.id ?? null,
    entityId: member.id,
    details: rename ? { from: m.display_name, to: displayName } : undefined,
  });
  tx.clearReadiness("ALL");
  return member;
}

const AcceptBody = z.object({ displayName: DisplayNameSchema.optional() });

export function acceptMemberInvite(tx: Tx, req: DoRequest, prepared: { secretHash: string }): OpResult {
  const principal = tx.principal;
  if (!principal?.email) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  const body = parseBody(AcceptBody, req.body);
  const m = inviteByHash(tx, prepared.secretHash);
  const status = memberInviteStatus(tx, m);
  if (status === "CLAIMED") throw conflict("INVITE_INVALID", "This invitation was already used.", { status });
  if (status === "EXPIRED") throw conflict("INVITE_INVALID", "This invitation has expired. Ask the owner to send a new one.", { status });
  if (principal.email !== m.invited_email) throw forbidden("This invitation is for a different email address.");
  const mine = tx.store.memberByPrincipal(principal.principalId);
  if (mine && mine.status !== "REMOVED") {
    throw conflict("ALREADY_MEMBER", `You're already in this group as ${mine.display_name}.`, { memberId: mine.id });
  }
  claimPlaceholder(tx, m, principal, body.displayName);
  const result: JoinResultDTO = { projectId: tx.project.id, memberId: m.id };
  return () => ok(result);
}
