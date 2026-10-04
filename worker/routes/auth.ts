import { Hono } from "hono";
import {
  AttachEmailSchema,
  RequestSignInSchema,
  type ConfigDTO,
  type MeDTO,
  type SignInRequestedDTO,
  type SignInVerifiedDTO,
  VerifySignInSchema,
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
import { environmentOf, isLocal } from "../lib/env";
import { ApiError } from "../lib/errors";
import { clientIp, parseWith, readJsonBody, safeNext } from "../lib/http";
import { logError, logInfo } from "../lib/log";
import { callProject } from "../lib/project";
import { enforceLimit } from "../lib/ratelimit";

/** Web route that explains an invalid/expired/used link (`?error=invalid`). */
export const SIGN_IN_PAGE = "/signin";
/** SPA page that reads `#token=` and POSTs it to /api/auth/verify. */
export const CONFIRM_PAGE = "/auth/confirm";
/** Landing page after sign-in when no `next` was given. */
export const DEFAULT_NEXT = "/groups";

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
  return c.json(await sendLink(c, { email: input.email, purpose: "SIGN_IN", principalId: guest, next: input.next ?? null }));
});

authRoutes.post("/api/me/email", async (c) => {
  const { principal } = await requireSession(c);
  const input = parseWith(AttachEmailSchema, await readJsonBody(c.req.raw));
  if (principal.email !== null) {
    throw new ApiError("INVALID_TRANSITION", "This account already has a verified email.");
  }
  await guardEmailRequest(c, input.email, input.turnstileToken);
  return c.json(await sendLink(c, { email: input.email, purpose: "ATTACH", principalId: principal.id, next: null }));
});

/**
 * Legacy `?token=` links (sent before /auth/confirm existed). Consumes nothing: mail scanners
 * prefetch GETs, so it only moves the token into the fragment of the SPA confirm page.
 */
authRoutes.get("/api/auth/verify", (c) => {
  c.header("Referrer-Policy", "no-referrer");
  const token = c.req.query("token") ?? "";
  return c.redirect(token ? confirmPath(token) : `${SIGN_IN_PAGE}?error=invalid`, 303);
});

/** The SPA confirm page POSTs the fragment token here (origin-checked like every mutation). */
authRoutes.post("/api/auth/verify", async (c) => {
  const { token: linkToken } = parseWith(VerifySignInSchema, await readJsonBody(c.req.raw));
  const row = await consumeSignInToken(c.env.DB, linkToken);
  if (!row) throw new ApiError("SIGNIN_LINK_INVALID", "This sign-in link has expired or was already used. Request a new one.");

  const next = safeNext(row.next, DEFAULT_NEXT);
  let target: PrincipalRow | null = null;
  let upgraded = false;

  if (row.purpose === "ATTACH") {
    target = row.principal_id ? await upgradeGuest(c.env.DB, row.principal_id, row.email) : null;
    // Email already belongs to another principal (or guest changed meanwhile): keep the session.
    if (!target) return c.json<SignInVerifiedDTO>({ next: withQuery(next, "error", "email_in_use") });
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
  return c.json<SignInVerifiedDTO>({ next });
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
  opts: { email: string; purpose: SignInPurpose; principalId: string | null; next: string | null },
): Promise<SignInRequestedDTO> {
  const token = await issueSignInToken(c.env.DB, opts);
  // Local dev serves the app from whatever localhost port the browser used.
  const origin = isLocal(c.env) ? new URL(c.req.url).origin : c.env.APP_ORIGIN;
  const link = `${origin}${confirmPath(token)}`;
  const sent = await sendEmail(c.env, opts.email, signInEmail(link, opts.purpose));
  if (!isLocal(c.env)) {
    // Staging/production have no devLink fallback, so an unsent email is a hard failure.
    if (!sent) throw new ApiError("INTERNAL", "We couldn't send the email. Please try again in a moment.");
    return { sent: true };
  }
  // Local dev/tests only: hand the link back (never logged) since there may be no inbox.
  return { sent: true, devLink: link };
}

/** Token lives in the fragment so it never reaches server logs, referrers, or link scanners. */
function confirmPath(token: string): string {
  return `${CONFIRM_PAGE}#token=${encodeURIComponent(token)}`;
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
          requestId,
        });
      } catch (err) {
        logError("principalUpdated failed", err, { projectId, requestId });
      }
    }),
  );
}
