import type { MiddlewareHandler } from "hono";
import { ApiError, unauthenticated } from "../lib/errors";
import { isAllowedOrigin } from "../lib/env";
import type { AppContext, AppEnv } from "../lib/context";
import { lookupSession, readSessionCookie, type SessionRecord } from "./session";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/** Resolves the cookie session once per request (cached on the context). */
export async function getSession(c: AppContext): Promise<SessionRecord | null> {
  const cached = c.get("session");
  if (cached !== undefined) return cached;
  const token = readSessionCookie(c);
  const session = token ? await lookupSession(c.env.DB, token) : null;
  c.set("session", session);
  return session;
}

export async function requireSession(c: AppContext): Promise<SessionRecord> {
  const session = await getSession(c);
  if (!session) throw unauthenticated();
  return session;
}

export function requireIdempotencyKey(c: AppContext): string {
  const key = c.req.header("idempotency-key");
  if (!key) throw new ApiError("VALIDATION", "Missing Idempotency-Key header.", { field: "Idempotency-Key" });
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new ApiError("VALIDATION", "Invalid Idempotency-Key header.", { field: "Idempotency-Key" });
  }
  return key;
}

/** CSRF defence: every state-changing /api request must come from the app's own origin. */
export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (MUTATING.has(c.req.method) && !isAllowedOrigin(c.env, c.req.header("origin"))) {
    throw new ApiError("FORBIDDEN", "Cross-site request blocked.");
  }
  await next();
};
