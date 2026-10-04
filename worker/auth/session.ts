import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, sha256Hex } from "../lib/crypto";
import type { PrincipalRow } from "./principals";

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = { ACCOUNT: 90 * DAY_MS, GUEST: 400 * DAY_MS } as const;

/**
 * `__Host-` prefix (Secure, Path=/, no Domain) on HTTPS. Plain-HTTP localhost dev cannot set
 * Secure cookies in every browser, so it falls back to an unprefixed, non-Secure name.
 */
export function sessionCookieName(url: string): string {
  return new URL(url).protocol === "https:" ? "__Host-sd_session" : "sd_session";
}

export interface SessionRecord {
  tokenHash: string;
  principal: PrincipalRow;
}

export async function createSession(db: D1Database, principal: PrincipalRow): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS[principal.kind];
  await db
    .prepare("INSERT INTO sessions (token_hash, principal_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), principal.id, now, expiresAt)
    .run();
  return { token, expiresAt };
}

/** D1 is authoritative: revoked or expired sessions never authenticate. */
export async function lookupSession(db: D1Database, token: string): Promise<SessionRecord | null> {
  if (token.length < 20 || token.length > 100) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT p.id, p.kind, p.email, p.display_name FROM sessions s JOIN principals p ON p.id = s.principal_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .bind(tokenHash, Date.now())
    .first<PrincipalRow>();
  return row ? { tokenHash, principal: row } : null;
}

export async function revokeSession(db: D1Database, tokenHash: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(Date.now(), tokenHash)
    .run();
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, sessionCookieName(c.req.url));
}

export function writeSessionCookie(c: Context, token: string, expiresAt: number): void {
  const name = sessionCookieName(c.req.url);
  const secure = name.startsWith("__Host-");
  setCookie(c, name, token, {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "Lax",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context): void {
  const name = sessionCookieName(c.req.url);
  const secure = name.startsWith("__Host-");
  deleteCookie(c, name, { path: "/", secure, httpOnly: true, sameSite: "Lax" });
}
