import type { MiddlewareHandler } from "hono";
import { ApiError, unauthenticated } from "../lib/errors";
import { isAllowedOrigin } from "../lib/env";
import type { AppContext, AppEnv } from "../lib/context";
import { lookupSession, readSessionCookie, type SessionRecord } from "./session";
import { lookupApiKey } from "./api-keys";
import { isPublicApiOperation } from "@shared/public-api";
import { enforceLimit } from "../lib/ratelimit";

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

/** A supplied Authorization header is authoritative; invalid keys never fall back to cookies. */
export const apiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authorization = c.req.header("authorization");
  if (authorization !== undefined) {
    const session = await lookupApiKey(c.env.DB, authorization);
    if (!session) throw new ApiError("UNAUTHENTICATED", "Invalid, expired, or revoked API key.");
    c.set("session", session);
    if (!isPublicApiOperation(c.req.method, c.req.path)) {
      throw new ApiError("FORBIDDEN", "API keys can access group endpoints and GET /api/me only. Use the website to manage your account.");
    }
    if (c.req.method !== "GET" && session.apiKey?.scope !== "WRITE") {
      throw new ApiError("FORBIDDEN", "This API key has read-only access.");
    }
    // Mutations are limited by their existing route; add the same budget to API reads.
    if (c.req.method === "GET") await enforceLimit(c.env.RL_MUTATION, `principal:${session.principal.id}`);
  }
  await next();
};

/** Cookie mutations need same-origin Origin. A validated API key supplies explicit credentials. */
export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (MUTATING.has(c.req.method) && !c.get("session")?.apiKey && !isAllowedOrigin(c.env, c.req.header("origin"))) {
    throw new ApiError("FORBIDDEN", "Cross-site request blocked.");
  }
  await next();
};
