/**
 * Expense digest: new expenses and refunds are queued as they're added and mailed as one email
 * per group once nobody has added anything for an hour (or at most a few hours after the first),
 * so a burst of entries from one or several people becomes a single message.
 */
import { money } from "../format";
import type { Store } from "../store";
import type { Tx } from "../tx";

export const DIGEST_DEBOUNCE_MS = 60 * 60 * 1000;
/** A group that keeps adding still gets its digest this long after the first queued entry. */
export const DIGEST_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
const DIGEST_MAX_LINES = 30;

export function queueDigest(tx: Tx, entryId: string): void {
  tx.store.run("INSERT INTO expense_digest (entry_id, added_at) VALUES (?, ?) ON CONFLICT (entry_id) DO NOTHING", entryId, Date.now());
}

/** When the pending digest is due, or null when nothing is queued. */
export function digestDueAt(store: Store): number | null {
  const row = store.first<{ first: number | null; last: number | null }>(
    "SELECT MIN(added_at) AS first, MAX(added_at) AS last FROM expense_digest",
  );
  if (row?.first === null || row?.first === undefined || row.last === null) return null;
  return Math.min(Number(row.last) + DIGEST_DEBOUNCE_MS, Number(row.first) + DIGEST_MAX_WAIT_MS);
}

/**
 * Sends the digest if it's due: each active member hears about the entries others added (still
 * present, as they read now); members who'd get the same list share one notification. Returns
 * whether anything was due.
 */
export function sendExpenseDigest(tx: Tx, now: number): boolean {
  const due = digestDueAt(tx.store);
  if (due === null || due > now) return false;
  const entries = tx.store.all<{
    id: string;
    type: "EXPENSE" | "REFUND";
    creator_member_id: string;
    description: string;
    original_amount: string;
    original_exponent: number;
    original_currency: string;
  }>(
    `SELECT e.id, e.type, e.creator_member_id, e.description, e.original_amount, e.original_exponent, e.original_currency
     FROM expense_digest d JOIN entries e ON e.id = d.entry_id
     WHERE e.deleted = 0 ORDER BY d.added_at, e.id`,
  );
  tx.store.run("DELETE FROM expense_digest");
  const project = tx.store.project();
  if (!project || entries.length === 0) return true;

  const members = tx.store.members();
  const names = new Map(members.map((m) => [m.id, m.display_name]));
  const groups = new Map<string, { memberIds: string[]; items: typeof entries }>();
  for (const m of members) {
    if (m.status !== "ACTIVE") continue;
    const items = entries.filter((e) => e.creator_member_id !== m.id);
    if (items.length === 0) continue;
    const key = items.map((e) => e.id).join(",");
    const group = groups.get(key) ?? { memberIds: [], items };
    group.memberIds.push(m.id);
    groups.set(key, group);
  }

  for (const { memberIds, items } of groups.values()) {
    const expenses = items.filter((e) => e.type === "EXPENSE").length;
    const refunds = items.length - expenses;
    const counts = [
      expenses > 0 ? `${expenses} new ${expenses === 1 ? "expense" : "expenses"}` : null,
      refunds > 0 ? `${refunds} new ${refunds === 1 ? "refund" : "refunds"}` : null,
    ].filter(Boolean);
    const summary = `${counts.join(" and ")} in “${project.name}”`;
    const lines = items.slice(0, DIGEST_MAX_LINES).map((e) => {
      const label = e.type === "REFUND" ? "refund " : "";
      const amount = money(e.original_amount, e.original_exponent, e.original_currency);
      return `${names.get(e.creator_member_id) ?? "Someone"} added ${label}“${e.description}” · ${amount}`;
    });
    if (items.length > DIGEST_MAX_LINES) lines.push(`…and ${items.length - DIGEST_MAX_LINES} more`);
    tx.notify("EXPENSES_ADDED", memberIds, summary, lines);
  }
  return true;
}
