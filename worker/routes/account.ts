import { Hono } from "hono";
import { DeleteAccountSchema, type DeletionPreviewDTO, type OkDTO } from "@shared/api";
import type { AccountDeletionInfo } from "../do/ops/account";
import { requireSession } from "../auth/middleware";
import { toPrincipal, type PrincipalRow } from "../auth/principals";
import { clearSessionCookie } from "../auth/session";
import type { AppEnv } from "../lib/context";
import { attachmentPrefix, deletePrefix } from "../lib/attachments";
import { directoryEntries } from "../lib/directory";
import { ApiError } from "../lib/errors";
import { parseWith, readJsonBody } from "../lib/http";
import { logInfo } from "../lib/log";
import { callProject, isOk, toHttpResponse } from "../lib/project";
import { enforceLimit } from "../lib/ratelimit";

const INSPECT_CONCURRENCY = 5;

interface ProjectState {
  projectId: string;
  /** What the directory says; only used for projects that no longer exist. */
  directoryOwner: boolean;
  /** Authoritative answer from the project's DO; null when the project no longer exists. */
  info: AccountDeletionInfo | null;
}

/** Asks every project in the principal's directory what deleting the account means there. */
async function inspect(env: Env, principal: PrincipalRow, requestId: string): Promise<ProjectState[]> {
  const queue = await directoryEntries(env.DB, principal.id);
  const states: ProjectState[] = [];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const res = await callProject(env, {
        op: "accountDeletionInfo",
        projectId: entry.projectId,
        principal: toPrincipal(principal),
        requestId,
      });
      if (res.status !== 404 && !isOk(res)) {
        throw new ApiError("INTERNAL", "Something went wrong. Nothing was deleted.", { details: { requestId } });
      }
      states.push({
        projectId: entry.projectId,
        directoryOwner: entry.isOwner,
        info: res.status === 404 ? null : (res.body as AccountDeletionInfo),
      });
    }
  };
  await Promise.all(Array.from({ length: INSPECT_CONCURRENCY }, worker));
  return states.sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
}

function preview(states: ProjectState[]): DeletionPreviewDTO {
  const body: DeletionPreviewDTO = { ownedProjects: [], memberProjects: [], blockingProjects: [] };
  for (const { projectId: id, info } of states) {
    if (info?.role === "OWNER") body.ownedProjects.push({ id, name: info.name, memberCount: info.memberCount });
    if (info?.role === "MEMBER") {
      body.memberProjects.push({ id, name: info.name });
      if (info.hasOpenTransfers) body.blockingProjects.push({ id, name: info.name });
    }
  }
  return body;
}

/** A deleted project: its stored files (owner's deletion only: backups, photos), then every member's directory row behind a tombstone. */
async function forgetProject(env: Env, projectId: string, purgeStorage: boolean): Promise<void> {
  if (purgeStorage) {
    await deletePrefix(env.BACKUPS, `projects/${projectId}/`);
    await deletePrefix(env.ATTACHMENTS, attachmentPrefix(projectId));
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO directory_tombstones (kind, id, deleted_at) VALUES ('PROJECT', ?, ?) ON CONFLICT (kind, id) DO NOTHING",
    ).bind(projectId, now),
    env.DB.prepare("DELETE FROM project_directory WHERE project_id = ?").bind(projectId),
  ]);
}

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.get("/api/me/deletion-preview", async (c) => {
  const { principal } = await requireSession(c);
  await enforceLimit(c.env.RL_MUTATION, `principal:${principal.id}`);
  return c.json(preview(await inspect(c.env, principal, c.get("requestId"))));
});

/**
 * Deletes the signed-in account (guests too). Every step is idempotent, so a retry after a
 * partial failure resumes: anonymized groups answer role NONE, deleted groups answer 404, and
 * the session (needed to retry) is only revoked at the very end.
 */
accountRoutes.delete("/api/me", async (c) => {
  const { principal } = await requireSession(c);
  await enforceLimit(c.env.RL_MUTATION, `principal:${principal.id}`);
  parseWith(DeleteAccountSchema, await readJsonBody(c.req.raw));
  const requestId = c.get("requestId");
  const states = await inspect(c.env, principal, requestId);

  const { blockingProjects } = preview(states);
  if (blockingProjects.length > 0) {
    throw new ApiError("ACCOUNT_HAS_OPEN_TRANSFERS", "Settle your expenses and confirm your transfers before deleting your account.", {
      details: { projects: blockingProjects },
    });
  }

  const asPrincipal = toPrincipal(principal);
  for (const s of states) {
    if (s.info?.role !== "MEMBER") continue;
    // The DO re-checks open transfers inside its transaction (a freeze may have happened since).
    const res = await callProject(c.env, { op: "anonymizeMember", projectId: s.projectId, principal: asPrincipal, requestId });
    if (!isOk(res)) return toHttpResponse(c, res, "anonymizeMember");
  }
  for (const s of states) {
    if (s.info?.role === "OWNER") {
      const res = await callProject(c.env, { op: "deleteProject", projectId: s.projectId, principal: asPrincipal, requestId });
      if (!isOk(res) && res.status !== 404) return toHttpResponse(c, res, "deleteProject");
      await forgetProject(c.env, s.projectId, true);
    } else if (s.info === null) {
      // Already gone (e.g. a retry after the DO was wiped): finish its cleanup.
      await forgetProject(c.env, s.projectId, s.directoryOwner);
    }
  }

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO directory_tombstones (kind, id, deleted_at) VALUES ('PRINCIPAL', ?, ?) ON CONFLICT (kind, id) DO NOTHING",
    ).bind(principal.id, now),
    c.env.DB.prepare("DELETE FROM project_directory WHERE principal_id = ?").bind(principal.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE principal_id = ?").bind(principal.id),
    c.env.DB.prepare("DELETE FROM api_keys WHERE principal_id = ?").bind(principal.id),
    c.env.DB.prepare("DELETE FROM sign_in_tokens WHERE principal_id = ? OR email = ?").bind(principal.id, principal.email),
    c.env.DB.prepare("DELETE FROM principals WHERE id = ?").bind(principal.id),
  ]);
  clearSessionCookie(c);
  c.header("Clear-Site-Data", '"cache"');
  logInfo("account deleted", {
    requestId,
    ownedProjects: states.filter((s) => s.info?.role === "OWNER").length,
    memberProjects: states.filter((s) => s.info?.role === "MEMBER").length,
  });
  return c.json<OkDTO>({ ok: true });
});
