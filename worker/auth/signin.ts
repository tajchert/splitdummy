import { randomToken, sha256Hex } from "../lib/crypto";

export const SIGN_IN_TTL_MS = 15 * 60 * 1000;

export type SignInPurpose = "SIGN_IN" | "ATTACH";

export interface SignInTokenRow {
  email: string;
  purpose: SignInPurpose;
  principal_id: string | null;
  next: string | null;
}

/** Stores only SHA-256(token); the raw token goes into the emailed link and nowhere else. */
export async function issueSignInToken(
  db: D1Database,
  opts: { email: string; purpose: SignInPurpose; principalId: string | null; next: string | null },
): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO sign_in_tokens (token_hash, email, purpose, principal_id, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(await sha256Hex(token), opts.email, opts.purpose, opts.principalId, opts.next, now, now + SIGN_IN_TTL_MS)
    .run();
  return token;
}

/** Atomic single-use consume: one UPDATE … RETURNING, so concurrent clicks can't both succeed. */
export async function consumeSignInToken(db: D1Database, token: string): Promise<SignInTokenRow | null> {
  if (token.length < 20 || token.length > 100) return null;
  const now = Date.now();
  return db
    .prepare(
      `UPDATE sign_in_tokens SET consumed_at = ?
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
       RETURNING email, purpose, principal_id, next`,
    )
    .bind(now, await sha256Hex(token), now)
    .first<SignInTokenRow>();
}
