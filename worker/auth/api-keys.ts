import type { ApiKeyDTO } from "@shared/api";
import { newId, randomToken, sha256Hex } from "../lib/crypto";
import type { PrincipalRow } from "./principals";
import type { SessionRecord } from "./session";
import { ApiError } from "../lib/errors";

export const API_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
interface ApiKeyRow {
  id: string; name: string; prefix: string; scope: "READ" | "WRITE"; created_at: number; expires_at: number;
}
function dto(row: ApiKeyRow): ApiKeyDTO {
  return { id: row.id, name: row.name, prefix: row.prefix, scope: row.scope,
    createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
}

export async function issueApiKey(db: D1Database, principalId: string, name: string, scope: "READ" | "WRITE") {
  const token = `sd_${randomToken(32)}`;
  const now = Date.now();
  const row: ApiKeyRow = { id: newId("ak"), name, prefix: token.slice(0, 11), scope, created_at: now, expires_at: now + API_KEY_TTL_MS };
  // Single statement makes the per-account active-key cap race-safe.
  const result = await db.prepare(
    `INSERT INTO api_keys (id, principal_id, token_hash, name, prefix, scope, created_at, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM api_keys WHERE principal_id = ? AND expires_at > ?) < 20`,
  ).bind(row.id, principalId, await sha256Hex(token), name, row.prefix, scope, now, row.expires_at, principalId, now).run();
  if (result.meta.changes !== 1) throw new ApiError("LIMIT_EXCEEDED", "You can have up to 20 active API keys. Revoke an unused key first.");
  return { ...dto(row), token };
}

export async function listApiKeys(db: D1Database, principalId: string): Promise<ApiKeyDTO[]> {
  const rows = await db.prepare("SELECT id, name, prefix, scope, created_at, expires_at FROM api_keys WHERE principal_id = ? ORDER BY created_at DESC, id")
    .bind(principalId).all<ApiKeyRow>();
  return rows.results.map(dto);
}

export async function lookupApiKey(db: D1Database, authorization: string): Promise<SessionRecord | null> {
  const token = /^Bearer[ \t]+(sd_[A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1];
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT p.id, p.kind, p.email, p.display_name, k.id AS key_id, k.scope
     FROM api_keys k JOIN principals p ON p.id = k.principal_id
     WHERE k.token_hash = ? AND k.expires_at > ? AND p.kind = 'ACCOUNT'`,
  ).bind(tokenHash, Date.now()).first<PrincipalRow & { key_id: string; scope: "READ" | "WRITE" }>();
  if (!row) return null;
  const { key_id, scope, ...principal } = row;
  return { tokenHash, principal, apiKey: { id: key_id, scope } };
}
