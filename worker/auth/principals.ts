import type { Principal } from "../do/types";
import { newId } from "../lib/crypto";

export interface PrincipalRow {
  id: string;
  kind: "ACCOUNT" | "GUEST";
  email: string | null;
  display_name: string | null;
}

export function toPrincipal(row: PrincipalRow): Principal {
  return {
    principalId: row.id,
    kind: row.kind,
    email: row.email,
    hasRecoverableAccount: row.kind === "ACCOUNT" || row.email !== null,
  };
}

export async function getPrincipal(db: D1Database, id: string): Promise<PrincipalRow | null> {
  return db.prepare("SELECT id, kind, email, display_name FROM principals WHERE id = ?").bind(id).first<PrincipalRow>();
}

export async function findByEmail(db: D1Database, email: string): Promise<PrincipalRow | null> {
  return db
    .prepare("SELECT id, kind, email, display_name FROM principals WHERE email = ?")
    .bind(email)
    .first<PrincipalRow>();
}

export async function createGuest(db: D1Database): Promise<PrincipalRow> {
  const row: PrincipalRow = { id: newId("pr"), kind: "GUEST", email: null, display_name: null };
  const now = Date.now();
  await db
    .prepare("INSERT INTO principals (id, kind, email, display_name, created_at, updated_at) VALUES (?, 'GUEST', NULL, NULL, ?, ?)")
    .bind(row.id, now, now)
    .run();
  return row;
}

/** Finds the account for `email`, creating it if needed (race-safe via the unique index). */
export async function findOrCreateAccount(db: D1Database, email: string): Promise<PrincipalRow> {
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO principals (id, kind, email, display_name, created_at, updated_at) VALUES (?, 'ACCOUNT', ?, NULL, ?, ?) ON CONFLICT(email) DO NOTHING",
    )
    .bind(newId("pr"), email, now, now)
    .run();
  const row = await findByEmail(db, email);
  if (!row) throw new Error("account upsert failed");
  return row;
}

/**
 * Upgrades an un-emailed guest in place (kind → ACCOUNT, verified email attached).
 * Returns null when the principal is no longer an un-emailed guest or the email is taken.
 */
export async function upgradeGuest(db: D1Database, principalId: string, email: string): Promise<PrincipalRow | null> {
  try {
    const row = await db
      .prepare(
        "UPDATE principals SET kind = 'ACCOUNT', email = ?, updated_at = ? WHERE id = ? AND kind = 'GUEST' AND email IS NULL RETURNING id, kind, email, display_name",
      )
      .bind(email, Date.now(), principalId)
      .first<PrincipalRow>();
    return row ?? null;
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return null;
    throw err;
  }
}
