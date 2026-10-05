import { Hono } from "hono";
import { JoinSchema } from "@shared/api";
import { getSession, requireIdempotencyKey } from "../auth/middleware";
import { toPrincipal } from "../auth/principals";
import type { AppEnv } from "../lib/context";
import { ApiError } from "../lib/errors";
import { clientIp, parseWith, readJsonBody } from "../lib/http";
import { callProject, isOk, PROJECT_ID_RE, toHttpResponse } from "../lib/project";
import { enforceLimit } from "../lib/ratelimit";
import { recordMembership } from "./projects";

const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Invitation tokens are `${projectId}.${secret}`. The edge routes by the prefix and forwards the
 * full token as params.tokenSecret; the DO checks the prefix matches and validates the secret.
 */
export function parseInviteToken(token: string): { projectId: string; tokenSecret: string } {
  const dot = token.indexOf(".");
  const projectId = dot > 0 ? token.slice(0, dot) : "";
  const tokenSecret = dot > 0 ? token.slice(dot + 1) : "";
  if (!PROJECT_ID_RE.test(projectId) || !SECRET_RE.test(tokenSecret)) {
    throw new ApiError("INVITE_INVALID", "This invitation link isn't valid.");
  }
  return { projectId, tokenSecret: token };
}

export const invitationRoutes = new Hono<AppEnv>();

invitationRoutes.post("/api/invitations/join", async (c) => {
  const ip = clientIp(c.req.raw);
  await enforceLimit(c.env.RL_JOIN, `ip:${ip}`);
  const idempotencyKey = requireIdempotencyKey(c);
  const input = parseWith(JoinSchema, await readJsonBody(c.req.raw));
  const { projectId, tokenSecret } = parseInviteToken(input.token);

  // Every new member has a verified email: the join page signs people in (magic link) first.
  // That sign-in already passed Turnstile, so the join itself doesn't need it.
  const session = await getSession(c);
  if (!session || !session.principal.email) {
    throw new ApiError("EMAIL_REQUIRED", "Confirm your email to join this group.");
  }
  const principal = session.principal;
  const requestId = c.get("requestId");
  const res = await callProject(c.env, {
    op: "join",
    projectId,
    principal: toPrincipal(principal),
    params: { tokenSecret },
    body: { displayName: input.displayName },
    idempotencyKey,
    requestId,
  });
  if (!isOk(res)) return toHttpResponse(c, res, "join");

  // Join returns { projectId }; fetch the member view to fill the directory row immediately.
  const view = await callProject(c.env, { op: "getProject", projectId, principal: toPrincipal(principal), requestId }).catch(
    () => null,
  );
  await recordMembership(c, principal.id, view && isOk(view) ? view.body : null, input.displayName);
  return toHttpResponse(c, res, "join");
});

invitationRoutes.get("/api/invitations/:token", async (c) => {
  const { projectId, tokenSecret } = parseInviteToken(c.req.param("token"));
  const session = await getSession(c);
  const res = await callProject(c.env, {
    op: "previewInvite",
    projectId,
    principal: session ? toPrincipal(session.principal) : null,
    params: { tokenSecret },
    requestId: c.get("requestId"),
  });
  return toHttpResponse(c, res, "previewInvite");
});
