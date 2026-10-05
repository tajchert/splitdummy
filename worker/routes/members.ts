import { Hono } from "hono";
import type { z } from "zod";
import { AcceptMemberInviteSchema, AddMemberSchema, InviteMemberSchema, type AddMemberResultDTO, type MemberDTO, type ProjectViewDTO } from "@shared/api";
import type { DoOp, DoResponse } from "../do/types";
import { getSession, requireIdempotencyKey, requireSession } from "../auth/middleware";
import { findOrCreateAccount, toPrincipal } from "../auth/principals";
import { createSession, revokeSession, writeSessionCookie } from "../auth/session";
import type { AppContext, AppEnv } from "../lib/context";
import { memberInviteEmail, sendEmail } from "../lib/email";
import { isLocal } from "../lib/env";
import { ApiError, notFound } from "../lib/errors";
import { clientIp, parseWith, readJsonBody } from "../lib/http";
import { callProject, isOk, toHttpResponse } from "../lib/project";
import { enforceLimit } from "../lib/ratelimit";
import { parseInviteToken } from "./invitations";
import { recordMembership, validateParams } from "./projects";

export const memberRoutes = new Hono<AppEnv>();

/** Edge-only fields never leave the Worker. */
const forBrowser = (res: DoResponse): DoResponse => ({ status: res.status, body: res.body, headers: res.headers });

/** Owner op that may hand back an invitation email (addMember / inviteMember). */
async function ownerInviteOp(c: AppContext, op: DoOp, schema: z.ZodType<{ email?: string }>): Promise<Response> {
  const { principal } = await requireSession(c);
  const params = c.req.param() as Record<string, string>;
  validateParams(params);
  const projectId = params.projectId;
  if (!projectId) throw notFound();
  const idempotencyKey = requireIdempotencyKey(c);
  await enforceLimit(c.env.RL_MUTATION, `principal:${principal.id}`);
  const body = parseWith(schema, await readJsonBody(c.req.raw));
  if (body.email) await enforceLimit(c.env.RL_SIGNIN_EMAIL, `email:${body.email}`);
  const res = await callProject(c.env, { op, projectId, principal: toPrincipal(principal), params, body, idempotencyKey, requestId: c.get("requestId") });
  if (!isOk(res)) return toHttpResponse(c, forBrowser(res), op);

  const mail = res.transient?.inviteMail;
  let emailSent: boolean | null = null;
  let devLink: string | undefined;
  if (mail) {
    // Local dev serves the app from whatever localhost port the browser used.
    const url = isLocal(c.env) ? mail.url.replace(c.env.APP_ORIGIN, new URL(c.req.url).origin) : mail.url;
    emailSent = await sendEmail(c.env, mail.to, memberInviteEmail({ ...mail, url }));
    if (isLocal(c.env)) devLink = url;
  }
  const out: AddMemberResultDTO = { ...(res.body as MemberDTO), emailSent, ...(devLink ? { devLink } : {}) };
  return c.json(out, res.status as 200 | 201);
}

memberRoutes.post("/api/projects/:projectId/members", (c) => ownerInviteOp(c, "addMember", AddMemberSchema));
memberRoutes.post("/api/projects/:projectId/members/:memberId/invite", (c) => ownerInviteOp(c, "inviteMember", InviteMemberSchema));

memberRoutes.get("/api/member-invites/:token", async (c) => {
  const { projectId, tokenSecret } = parseInviteToken(c.req.param("token"));
  const session = await getSession(c);
  const res = await callProject(c.env, {
    op: "previewMemberInvite",
    projectId,
    principal: session ? toPrincipal(session.principal) : null,
    params: { tokenSecret },
    requestId: c.get("requestId"),
  });
  return toHttpResponse(c, forBrowser(res), "previewMemberInvite");
});

/**
 * Possession of the emailed link proves the address (like a magic link): find or create that
 * account, claim the placeholder, then replace whatever session this browser had.
 */
memberRoutes.post("/api/member-invites/accept", async (c) => {
  await enforceLimit(c.env.RL_JOIN, `ip:${clientIp(c.req.raw)}`);
  const idempotencyKey = requireIdempotencyKey(c);
  const input = parseWith(AcceptMemberInviteSchema, await readJsonBody(c.req.raw));
  const { projectId, tokenSecret } = parseInviteToken(input.token);
  const requestId = c.get("requestId");

  const preview = await callProject(c.env, { op: "previewMemberInvite", projectId, principal: null, params: { tokenSecret }, requestId });
  const email = preview.transient?.invitedEmail;
  if (!isOk(preview) || !email) return toHttpResponse(c, forBrowser(preview), "previewMemberInvite");
  const status = (preview.body as { status: string }).status;
  if (status !== "OPEN") {
    throw new ApiError(
      "INVITE_INVALID",
      status === "EXPIRED" ? "This invitation has expired. Ask the owner to send a new one." : "This invitation was already used.",
      { status: 409, details: { status } },
    );
  }

  const account = await findOrCreateAccount(c.env.DB, email);
  const principal = toPrincipal(account);
  const res = await callProject(c.env, {
    op: "acceptMemberInvite",
    projectId,
    principal,
    params: { tokenSecret },
    body: input.displayName ? { displayName: input.displayName } : {},
    idempotencyKey,
    requestId,
  });
  if (!isOk(res)) return toHttpResponse(c, forBrowser(res), "acceptMemberInvite");

  const previous = await getSession(c);
  if (previous) await revokeSession(c.env.DB, previous.tokenHash);
  const { token, expiresAt } = await createSession(c.env.DB, account);
  writeSessionCookie(c, token, expiresAt);

  const view = await callProject(c.env, { op: "getProject", projectId, principal, requestId }).catch(() => null);
  const body = view && isOk(view) ? (view.body as ProjectViewDTO) : null;
  const name = body?.members.find((m) => m.id === body.me.memberId)?.displayName ?? input.displayName ?? "";
  await recordMembership(c, account.id, body, name);
  return toHttpResponse(c, forBrowser(res), "acceptMemberInvite");
});
