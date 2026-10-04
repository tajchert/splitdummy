/** Project, settings, rate defaults, invitations, membership and ownership ops. */
import {
  CreateProjectSchema,
  DisplayNameSchema,
  PutRateSchema,
  TransferOwnershipSchema,
  UpdateSettingsSchema,
  type InvitationPreviewDTO,
  type JoinResultDTO,
  type OkDTO,
} from "@shared/api";
import { getCurrency, parseRate, rateToString } from "@shared/money";
import { z } from "zod";
import { ApiError, conflict, forbidden, invalid, limitExceeded, notFound, parseBody } from "../errors";
import { INVITE_TTL_MS, LIMITS } from "../limits";
import type { InvitationRow, MemberRow } from "../store";
import { newId, type Tx } from "../tx";
import type { DoRequest, DoResponse, Principal } from "../types";
import { invitationDto, memberDto, projectDto, projectView, rateDto } from "../views";

export type OpResult = DoResponse | (() => DoResponse);

export const ok = (body: unknown, status = 200): DoResponse => ({ status, body });
const OK: OkDTO = { ok: true };

const CreateProjectBody = CreateProjectSchema.omit({ turnstileToken: true }).extend({
  projectId: z.string().min(1).max(64).optional(),
});

export function createProject(tx: Tx, req: DoRequest): OpResult {
  const principal = tx.principal;
  if (!principal) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  if (!principal.hasRecoverableAccount) throw forbidden("Sign in with your email to create a group.");
  const body = parseBody(CreateProjectBody, req.body);
  const projectId = req.params.projectId ?? body.projectId;
  if (!projectId) throw invalid("projectId", "Missing project ID");
  if (tx.store.project()) throw conflict("INVALID_TRANSITION", "This group already exists.");
  const currency = getCurrency(body.baseCurrency);
  if (!currency) throw invalid("baseCurrency", "Choose a supported currency");

  const memberId = newId("m");
  const roundId = newId("r");
  tx.store.run(
    `INSERT INTO project (id, name, owner_member_id, base_currency, base_exponent, multi_currency_enabled, active_round_id, version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    projectId,
    body.name,
    memberId,
    currency.code,
    currency.exponent,
    body.multiCurrencyEnabled ? 1 : 0,
    roundId,
    tx.now,
  );
  insertMember(tx, memberId, principal, body.ownerDisplayName);
  tx.store.run(
    "INSERT INTO rounds (id, sequence, status, ledger_version, review_version, created_at) VALUES (?, 1, 'COLLECTING', 0, 0, ?)",
    roundId,
    tx.now,
  );
  const member = tx.store.member(memberId)!;
  tx.setActor(member);
  tx.audit("PROJECT_CREATED", `Created group “${body.name}” in ${currency.code}`, {
    roundId,
    entityId: projectId,
    details: { baseCurrency: currency.code, multiCurrencyEnabled: body.multiCurrencyEnabled },
  });
  tx.audit("ROUND_STARTED", "Started round 1", { roundId, entityId: roundId });
  return () => ok(projectView(tx.store, member), 201);
}

function insertMember(tx: Tx, memberId: string, principal: Principal, displayName: string): void {
  tx.store.run(
    `INSERT INTO members (id, principal_id, display_name, is_guest, has_recoverable_account, joined_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    memberId,
    principal.principalId,
    displayName,
    principal.kind === "GUEST" ? 1 : 0,
    principal.hasRecoverableAccount ? 1 : 0,
    tx.now,
  );
}

export function updateSettings(tx: Tx, req: DoRequest): OpResult {
  tx.owner("Only the group owner can change settings.");
  const body = parseBody(UpdateSettingsSchema, req.body);
  const project = tx.project;
  if (body.expectedVersion !== project.version) {
    throw conflict("STALE_VERSION", "Settings changed since you opened them. Review and try again.", {
      currentVersion: project.version,
    });
  }
  const changes: Record<string, unknown> = {};

  if (body.name !== undefined && body.name !== project.name) {
    tx.store.run("UPDATE project SET name = ? WHERE id = ?", body.name, project.id);
    changes.name = { from: project.name, to: body.name };
    tx.audit("PROJECT_RENAMED", `Renamed the group to “${body.name}”`, { entityId: project.id, details: changes.name });
  }

  if (body.baseCurrency !== undefined && body.baseCurrency !== project.base_currency) {
    if (project.base_currency_locked === 1) {
      throw conflict("CURRENCY_LOCKED", "The settlement currency is fixed once the first expense is saved.");
    }
    tx.requireNotSettling();
    const currency = getCurrency(body.baseCurrency);
    if (!currency) throw invalid("baseCurrency", "Choose a supported currency");
    tx.store.run(
      "UPDATE project SET base_currency = ?, base_exponent = ? WHERE id = ?",
      currency.code,
      currency.exponent,
      project.id,
    );
    // Rate defaults are pairs into the old base; they no longer mean anything.
    tx.store.run("DELETE FROM rate_defaults");
    changes.baseCurrency = { from: project.base_currency, to: currency.code };
    tx.audit("BASE_CURRENCY_CHANGED", `Changed the settlement currency to ${currency.code}`, {
      entityId: project.id,
      details: changes.baseCurrency,
    });
    tx.clearReadiness("ALL");
  }

  const multi = project.multi_currency_enabled === 1;
  if (body.multiCurrencyEnabled !== undefined && body.multiCurrencyEnabled !== multi) {
    tx.requireNotSettling();
    const round = tx.activeRound();
    if (!body.multiCurrencyEnabled && round) {
      const base = tx.store.project()!.base_currency;
      const foreign = tx.store.all<{ original_currency: string }>(
        "SELECT DISTINCT original_currency FROM entries WHERE round_id = ? AND deleted = 0 AND original_currency != ?",
        round.id,
        base,
      );
      if (foreign.length > 0) {
        throw conflict(
          "FOREIGN_ENTRIES_EXIST",
          "This round has expenses in other currencies. Remove them before turning off multiple currencies.",
          { currencies: foreign.map((f) => f.original_currency) },
        );
      }
    }
    tx.store.run("UPDATE project SET multi_currency_enabled = ? WHERE id = ?", body.multiCurrencyEnabled ? 1 : 0, project.id);
    changes.multiCurrencyEnabled = { from: multi, to: body.multiCurrencyEnabled };
    tx.audit(
      body.multiCurrencyEnabled ? "MULTI_CURRENCY_ENABLED" : "MULTI_CURRENCY_DISABLED",
      body.multiCurrencyEnabled ? "Allowed expenses in other currencies" : "Turned off expenses in other currencies",
      { roundId: round?.id ?? null, entityId: project.id },
    );
    tx.clearReadiness("ALL");
  }

  return projectResult(tx);
}

/** Built after finish() so the DTO carries the committed version. */
const projectResult = (tx: Tx) => () => ok(projectDto(tx.project));

function requireForeignCurrency(tx: Tx, code: string | undefined): string {
  const currency = code ? getCurrency(code) : undefined;
  if (!currency) throw invalid("currency", "Choose a supported currency");
  if (currency.code === tx.project.base_currency) {
    throw invalid("currency", "The settlement currency always converts at 1.");
  }
  return currency.code;
}

export function putRate(tx: Tx, req: DoRequest): DoResponse {
  const owner = tx.owner("Only the group owner can set exchange rates.");
  tx.requireNotSettling();
  const currency = requireForeignCurrency(tx, req.params.currency);
  const body = parseBody(PutRateSchema, req.body);
  const parsed = parseRate(body.rate);
  if (!parsed.ok) throw invalid("rate", rateErrorMessage(parsed.error));
  const rate = rateToString(parsed.value);
  const existing = tx.store.rate(currency);
  if (body.expectedRevision !== undefined && body.expectedRevision !== (existing?.revision ?? 0)) {
    throw conflict("STALE_VERSION", "This rate changed since you opened it.", { currentRevision: existing?.revision ?? 0 });
  }
  if (!existing && tx.store.count("SELECT COUNT(*) AS n FROM rate_defaults") >= LIMITS.rateDefaults) {
    throw limitExceeded("Too many saved rates.");
  }
  const revision = (existing?.revision ?? 0) + 1;
  tx.store.run(
    `INSERT INTO rate_defaults (currency, rate, set_by_member_id, set_at, revision) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate, set_by_member_id = excluded.set_by_member_id,
       set_at = excluded.set_at, revision = excluded.revision`,
    currency,
    rate,
    owner.id,
    tx.now,
    revision,
  );
  const base = tx.project.base_currency;
  tx.audit("RATE_DEFAULT_SET", `Set default rate 1 ${currency} = ${rate} ${base}`, {
    entityId: currency,
    revision,
    details: { currency, rate, previousRate: existing?.rate ?? null },
  });
  return ok(rateDto(tx.store.rate(currency)!));
}

export function rateErrorMessage(error: string): string {
  switch (error) {
    case "EMPTY":
      return "Enter an exchange rate";
    case "TOO_PRECISE":
      return "Use at most 12 decimal places";
    case "NOT_POSITIVE":
      return "The rate must be greater than zero";
    case "TOO_LARGE":
      return "That rate is too large";
    default:
      return "Enter a rate like 4.30";
  }
}

export function deleteRate(tx: Tx, req: DoRequest): DoResponse {
  tx.owner("Only the group owner can set exchange rates.");
  tx.requireNotSettling();
  const currency = requireForeignCurrency(tx, req.params.currency);
  const existing = tx.store.rate(currency);
  if (existing) {
    tx.store.run("DELETE FROM rate_defaults WHERE currency = ?", currency);
    tx.audit("RATE_DEFAULT_DELETED", `Removed the default rate for ${currency}`, {
      entityId: currency,
      details: { currency, rate: existing.rate },
    });
  }
  return ok(OK);
}

// ---------- invitations ----------

export function createInvite(tx: Tx, req: DoRequest, prepared: { secret: string; secretHash: string }, origin: string): DoResponse {
  tx.owner("Only the group owner can manage invitations.");
  if (tx.store.count("SELECT COUNT(*) AS n FROM invitations") >= LIMITS.invitations) {
    throw limitExceeded("Too many invitations for this group.");
  }
  const id = newId("inv");
  const expiresAt = new Date(Date.parse(tx.now) + INVITE_TTL_MS).toISOString();
  tx.store.run(
    "INSERT INTO invitations (id, secret_hash, created_by_member_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    id,
    prepared.secretHash,
    tx.member().id,
    tx.now,
    expiresAt,
  );
  tx.audit("INVITATION_CREATED", "Created an invitation link", { entityId: id, details: { expiresAt } });
  const row = tx.store.first<InvitationRow>("SELECT * FROM invitations WHERE id = ?", id)!;
  return ok({ ...invitationDto(row), url: `${origin}/join#${tx.project.id}.${prepared.secret}` }, 201);
}

export function revokeInvite(tx: Tx, req: DoRequest): DoResponse {
  tx.owner("Only the group owner can manage invitations.");
  const row = tx.store.first<InvitationRow>("SELECT * FROM invitations WHERE id = ?", req.params.inviteId ?? "");
  if (!row) throw notFound("This invitation isn't available.");
  if (!row.revoked_at) {
    tx.store.run("UPDATE invitations SET revoked_at = ? WHERE id = ?", tx.now, row.id);
    tx.audit("INVITATION_REVOKED", "Revoked an invitation link", { entityId: row.id });
  }
  return ok(invitationDto(tx.store.first<InvitationRow>("SELECT * FROM invitations WHERE id = ?", row.id)!));
}

type InviteStatus = InvitationPreviewDTO["status"];

function inviteStatus(tx: Tx, secretHash: string): { row: InvitationRow; status: InviteStatus } {
  const row = tx.store.first<InvitationRow>("SELECT * FROM invitations WHERE secret_hash = ?", secretHash);
  if (!row || !tx.store.project()) {
    throw new ApiError(404, "INVITE_INVALID", "This invitation link isn't valid.");
  }
  let status: InviteStatus = "OPEN";
  if (row.revoked_at) status = "REVOKED";
  else if (Date.parse(row.expires_at) <= Date.parse(tx.now)) status = "EXPIRED";
  else if (tx.activeRound()?.status === "SETTLING") status = "MEMBERSHIP_FROZEN";
  return { row, status };
}

export function previewInvite(tx: Tx, prepared: { secretHash: string }): DoResponse {
  const { status } = inviteStatus(tx, prepared.secretHash);
  const project = tx.project;
  const existing = tx.principal ? tx.store.memberByPrincipal(tx.principal.principalId) : undefined;
  const body: InvitationPreviewDTO = {
    projectName: project.name,
    baseCurrency: project.base_currency,
    status,
    alreadyMemberProjectId: existing && existing.status !== "REMOVED" ? project.id : null,
  };
  return ok(body);
}

const JoinBody = z.object({ displayName: DisplayNameSchema });

export function join(tx: Tx, req: DoRequest, prepared: { secretHash: string }): DoResponse {
  const principal = tx.principal;
  if (!principal) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  const { status } = inviteStatus(tx, prepared.secretHash);
  const project = tx.project;
  const existing = tx.store.memberByPrincipal(principal.principalId);
  if (existing && existing.status === "ACTIVE") {
    // Same principal joining again gets its existing identity back; nothing changes.
    tx.setActor(existing);
    const result: JoinResultDTO = { projectId: project.id, memberId: existing.id };
    return ok(result);
  }
  if (status === "REVOKED" || status === "EXPIRED") {
    throw conflict("INVITE_INVALID", status === "REVOKED" ? "This invitation was revoked." : "This invitation has expired.", {
      status,
    });
  }
  if (status === "MEMBERSHIP_FROZEN") {
    throw conflict("ROUND_NOT_COLLECTING", "Settlement is in progress, so nobody can join right now.", { status });
  }
  const body = parseBody(JoinBody, req.body);
  const activeCount = tx.store.count("SELECT COUNT(*) AS n FROM members WHERE status != 'REMOVED'");
  if (activeCount >= LIMITS.members) throw limitExceeded(`A group can have at most ${LIMITS.members} members.`);

  let member: MemberRow;
  if (existing) {
    tx.store.run(
      `UPDATE members SET status = 'ACTIVE', status_changed_at = ?, display_name = ?, has_recoverable_account = ?, is_guest = ?
       WHERE id = ?`,
      tx.now,
      body.displayName,
      principal.hasRecoverableAccount ? 1 : 0,
      principal.kind === "GUEST" ? 1 : 0,
      existing.id,
    );
    member = tx.store.member(existing.id)!;
  } else {
    if (tx.store.count("SELECT COUNT(*) AS n FROM members") >= LIMITS.memberRows) {
      throw limitExceeded("This group has reached its membership limit.");
    }
    const id = newId("m");
    insertMember(tx, id, principal, body.displayName);
    member = tx.store.member(id)!;
  }
  tx.setActor(member);
  tx.audit(existing ? "MEMBER_REJOINED" : "MEMBER_JOINED", `${member.display_name} joined`, {
    roundId: tx.activeRound()?.id ?? null,
    entityId: member.id,
  });
  tx.clearReadiness("ALL");
  const result: JoinResultDTO = { projectId: project.id, memberId: member.id };
  return ok(result);
}

// ---------- membership ----------

export function removeMember(tx: Tx, req: DoRequest): DoResponse {
  tx.owner("Only the group owner can remove members.");
  tx.requireNotSettling();
  const project = tx.project;
  const target = tx.store.member(req.params.memberId ?? "");
  if (!target) throw notFound("This member isn't available.");
  if (target.id === project.owner_member_id) {
    throw conflict("INVALID_TRANSITION", "Transfer ownership before removing the owner.");
  }
  if (target.status !== "REMOVED") {
    if (tx.store.isReferenced(target.id)) {
      throw conflict("MEMBER_REFERENCED", "This person appears in expenses or settlements, so they can't be removed.");
    }
    tx.store.run("UPDATE members SET status = 'REMOVED', status_changed_at = ? WHERE id = ?", tx.now, target.id);
    if (project.pending_owner_member_id === target.id) {
      tx.store.run("UPDATE project SET pending_owner_member_id = NULL WHERE id = ?", project.id);
    }
    tx.audit("MEMBER_REMOVED", `Removed ${target.display_name}`, {
      roundId: tx.activeRound()?.id ?? null,
      entityId: target.id,
    });
    tx.clearReadiness("ALL");
    tx.disconnect.push(target.id);
  }
  return ok(memberDto(tx.store.member(target.id)!, tx.project, false));
}

export function leave(tx: Tx): DoResponse {
  const me = tx.member();
  const project = tx.project;
  if (project.owner_member_id === me.id) {
    throw conflict("INVALID_TRANSITION", "Transfer ownership to someone else before leaving.");
  }
  tx.requireNotSettling();
  if (me.status === "ACTIVE") {
    tx.store.run("UPDATE members SET status = 'LEFT', status_changed_at = ? WHERE id = ?", tx.now, me.id);
    if (project.pending_owner_member_id === me.id) {
      tx.store.run("UPDATE project SET pending_owner_member_id = NULL WHERE id = ?", project.id);
    }
    tx.audit("MEMBER_LEFT", `${me.display_name} left the group`, { roundId: tx.activeRound()?.id ?? null, entityId: me.id });
    tx.clearReadiness("ALL");
  }
  return ok(memberDto(tx.store.member(me.id)!, tx.project, tx.store.isReferenced(me.id)));
}

export function transferOwnership(tx: Tx, req: DoRequest): OpResult {
  const owner = tx.owner("Only the group owner can transfer ownership.");
  tx.requireNotSettling();
  const body = parseBody(TransferOwnershipSchema, req.body);
  const target = tx.store.member(body.toMemberId);
  if (!target || target.status !== "ACTIVE") throw invalid("toMemberId", "Choose a current member");
  if (target.id === owner.id) throw invalid("toMemberId", "You already own this group");
  if (target.has_recoverable_account !== 1) {
    throw invalid("toMemberId", "This person needs to add a verified email before they can become the owner.");
  }
  tx.store.run("UPDATE project SET pending_owner_member_id = ? WHERE id = ?", target.id, tx.project.id);
  tx.audit("OWNERSHIP_OFFERED", `Offered ownership to ${target.display_name}`, { entityId: target.id });
  return projectResult(tx);
}

export function acceptOwnership(tx: Tx): OpResult {
  const me = tx.member();
  const project = tx.project;
  if (project.pending_owner_member_id !== me.id) {
    throw conflict("INVALID_TRANSITION", "There is no ownership offer for you.");
  }
  tx.requireNotSettling();
  if (me.has_recoverable_account !== 1 || me.status !== "ACTIVE") {
    throw forbidden("Add a verified email before accepting ownership.");
  }
  const previous = project.owner_member_id;
  tx.store.run(
    "UPDATE project SET owner_member_id = ?, pending_owner_member_id = NULL WHERE id = ?",
    me.id,
    project.id,
  );
  tx.audit("OWNERSHIP_TRANSFERRED", `${me.display_name} is now the owner`, {
    entityId: me.id,
    details: { fromMemberId: previous, toMemberId: me.id },
  });
  tx.clearReadiness("ALL");
  return projectResult(tx);
}

const PrincipalBody = z.object({
  principalId: z.string().min(1),
  kind: z.enum(["ACCOUNT", "GUEST"]),
  email: z.string().nullable(),
  hasRecoverableAccount: z.boolean(),
});

export function principalUpdated(tx: Tx, req: DoRequest): DoResponse {
  const body = parseBody(PrincipalBody, req.body);
  if (tx.principal && tx.principal.principalId !== body.principalId) throw forbidden("Principal mismatch.");
  tx.requireProject();
  const member = tx.store.memberByPrincipal(body.principalId);
  if (member) {
    const recoverable = body.hasRecoverableAccount ? 1 : 0;
    const guest = body.kind === "GUEST" ? 1 : 0;
    if (member.has_recoverable_account !== recoverable || member.is_guest !== guest) {
      tx.store.run(
        "UPDATE members SET has_recoverable_account = ?, is_guest = ? WHERE id = ?",
        recoverable,
        guest,
        member.id,
      );
      tx.setActor(member);
      tx.audit("MEMBER_ACCOUNT_UPDATED", `${member.display_name} ${recoverable ? "added a verified email" : "updated their account"}`, {
        entityId: member.id,
      });
    }
  }
  return ok(OK);
}
