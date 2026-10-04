import { Hono } from "hono";
import {
  AttachEmailSchema,
  RequestSignInSchema,
  type ConfigDTO,
  type MeDTO,
  type SignInRequestedDTO,
} from "@shared/api";
import type { Principal } from "../do/types";
import { getSession, requireSession } from "../auth/middleware";
import { findByEmail, findOrCreateAccount, toPrincipal, upgradeGuest, type PrincipalRow } from "../auth/principals";
import { clearSessionCookie, createSession, revokeSession, writeSessionCookie } from "../auth/session";
import { consumeSignInToken, issueSignInToken, type SignInPurpose } from "../auth/signin";
import { verifyTurnstile } from "../auth/turnstile";
import type { AppContext, AppEnv } from "../lib/context";
import { projectIdsForPrincipal } from "../lib/directory";
import { sendEmail, signInEmail } from "../lib/email";
import { environmentOf, isLocal, isProduction } from "../lib/env";
import { ApiError } from "../lib/errors";
import { clientIp, parseWith, readJsonBody, safeNext } from "../lib/http";
import { logError, logInfo } from "../lib/log";
import { callProject } from "../lib/project";
import { enforceLimit } from "../lib/ratelimit";

/** Web route that explains an invalid/expired link (query `error=`). */
export const SIGN_IN_PAGE = "/signin";

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/api/config", (c) => {
  const body: ConfigDTO = { turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null, environment: environmentOf(c.env) };
  return c.json(body);
});

authRoutes.get("/api/me", async (c) => {
  const { principal } = await requireSession(c);
  const body: MeDTO = {
    principalId: principal.id,
    kind: principal.kind,
    email: principal.email,
    displayName: principal.display_name,
  };
  return c.json(body);
});

authRoutes.post("/api/auth/email", async (c) => {
  const input = parseWith(RequestSignInSchema, await readJsonBody(c.req.raw));
  await guardEmailRequest(c, input.email, input.turnstileToken);
  const session = await getSession(c);
  // A link requested from an un-emailed guest session upgrades that guest on verify (unless the
  // email already has an account). Binding the target at request time stops a stranger's link
  // from attaching their email to whoever happens to click it.
  const guest = session && session.principal.kind === "GUEST" && session.principal.email === null ? session.principal.id : null;
  return c.json(await sendLink(c, { email: input.email, purpose: "SIGN_IN", principalId: guest, next: safeNext(input.next) }));
});

authRoutes.post("/api/me/email", async (c) => {
  const { principal } = await requireSession(c);
  const input = parseWith(AttachEmailSchema, await readJsonBody(c.req.raw));
  if (principal.email !== null) {
    throw new ApiError("INVALID_TRANSITION", "This account already has a verified email.");
  }
  await guardEmailRequest(c, input.email, input.turnstileToken);
  return c.json(await sendLink(c, { email: input.email, purpose: "ATTACH", principalId: principal.id, next: "/" }));
});

authRoutes.get("/api/auth/verify", async (c) => {
  c.header("Referrer-Policy", "no-referrer");
  const row = await consumeSignInToken(c.env.DB, c.req.query("token") ?? "");
  if (!row) return c.redirect(`${SIGN_IN_PAGE}?error=link_invalid`, 303);

  const next = safeNext(row.next);
  let target: PrincipalRow | null = null;
  let upgraded = false;

  if (row.purpose === "ATTACH") {
    target = row.principal_id ? await upgradeGuest(c.env.DB, row.principal_id, row.email) : null;
    // Email already belongs to another principal (or guest changed meanwhile): keep the session.
    if (!target) return c.redirect(withQuery(next, "error", "email_in_use"), 303);
    upgraded = true;
  } else {
    target = await findByEmail(c.env.DB, row.email);
    if (!target && row.principal_id) {
      target = await upgradeGuest(c.env.DB, row.principal_id, row.email);
      upgraded = target !== null;
    }
    target ??= await findOrCreateAccount(c.env.DB, row.email);
  }

  // Fresh session on every privilege change (no fixation); retire the one this browser held.
  const previous = await getSession(c);
  if (previous) await revokeSession(c.env.DB, previous.tokenHash);
  const { token, expiresAt } = await createSession(c.env.DB, target);
  writeSessionCookie(c, token, expiresAt);

  if (upgraded) c.executionCtx.waitUntil(notifyPrincipalUpdated(c.env, toPrincipal(target), c.get("requestId")));
  logInfo("signed in", { requestId: c.get("requestId"), purpose: row.purpose, upgraded });
  return c.redirect(next, 303);
});

authRoutes.post("/api/auth/logout", async (c) => {
  const session = await getSession(c);
  if (session) await revokeSession(c.env.DB, session.tokenHash);
  clearSessionCookie(c);
  return c.body(null, 204);
});

async function guardEmailRequest(c: AppContext, email: string, turnstileToken: string | undefined): Promise<void> {
  const ip = clientIp(c.req.raw);
  await enforceLimit(c.env.RL_SIGNIN_IP, `ip:${ip}`);
  await enforceLimit(c.env.RL_SIGNIN_EMAIL, `email:${email}`);
  await verifyTurnstile(c.env, turnstileToken, ip);
}

async function sendLink(
  c: AppContext,
  opts: { email: string; purpose: SignInPurpose; principalId: string | null; next: string },
): Promise<SignInRequestedDTO> {
  const token = await issueSignInToken(c.env.DB, opts);
  // Local dev serves the app from whatever localhost port the browser used.
  const origin = isLocal(c.env) ? new URL(c.req.url).origin : c.env.APP_ORIGIN;
  const link = `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  const sent = await sendEmail(c.env, opts.email, signInEmail(link, opts.purpose));
  if (!sent && isProduction(c.env)) {
    throw new ApiError("INTERNAL", "We couldn't send the email. Please try again in a moment.");
  }
  // Outside production the link is returned for local/staging testing; never logged.
  return isProduction(c.env) ? { sent: true } : { sent: true, devLink: link };
}

function withQuery(path: string, key: string, value: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

/** Tells every DO this principal belongs to that it now has a verified email (recoverable). */
export async function notifyPrincipalUpdated(env: Env, principal: Principal, requestId: string): Promise<void> {
  const projectIds = await projectIdsForPrincipal(env.DB, principal.principalId);
  await Promise.all(
    projectIds.map(async (projectId) => {
      try {
        await callProject(env, {
          op: "principalUpdated",
          projectId,
          principal,
          body: principal,
          idempotencyKey: `principalUpdated:${principal.principalId}`,
          requestId,
        });
      } catch (err) {
        logError("principalUpdated failed", err, { projectId, requestId });
      }
    }),
  );
}
