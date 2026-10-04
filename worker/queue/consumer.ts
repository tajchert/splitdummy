import type { OutboxMessage } from "../do/types";
import { rowsFromOutbox, upsertStatement } from "../lib/directory";
import { notificationEmail, sendEmail } from "../lib/email";
import { logError, logInfo } from "../lib/log";

type Notify = Extract<OutboxMessage, { type: "NOTIFY" }>;

/**
 * Outbox consumer. Delivery is at-least-once and unordered, so:
 * - every event is deduped by ID in processed_events;
 * - directory rows only move forward in projectVersion;
 * - notifications dedupe per recipient, so a retry after a partial send doesn't re-mail anyone.
 * Nothing here can affect accounting; failures retry and finally land in the DLQ.
 */
export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processMessage(env, msg.body);
      msg.ack();
    } catch (err) {
      logError("queue message failed", err, { messageId: msg.id, attempts: msg.attempts });
      msg.retry({ delaySeconds: Math.min(300, 10 * 2 ** Math.max(0, msg.attempts - 1)) });
    }
  }
}

export async function processMessage(env: Env, body: unknown): Promise<void> {
  if (!isOutboxMessage(body)) {
    // Poison message: retrying can't fix it. Ack (by returning) and leave a trace.
    logError("queue message malformed", new Error("unrecognized outbox message"));
    return;
  }
  if (await isProcessed(env.DB, body.id)) return;

  if (body.type === "DIRECTORY_UPSERT") {
    const statements = rowsFromOutbox(body).map((row) => upsertStatement(env.DB, row, ">="));
    await env.DB.batch([...statements, markProcessed(env.DB, body.id)]);
    return;
  }
  await notify(env, body);
  await markProcessed(env.DB, body.id).run();
}

async function notify(env: Env, msg: Notify): Promise<void> {
  const ids = [...new Set(msg.payload.principalIds)].slice(0, 100);
  if (ids.length === 0) return;
  const { results } = await env.DB.prepare(
    `SELECT id, email FROM principals WHERE email IS NOT NULL AND id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<{ id: string; email: string }>();

  const content = notificationEmail({
    summary: msg.payload.summary,
    projectUrl: `${env.APP_ORIGIN}/projects/${encodeURIComponent(msg.projectId)}`,
  });
  let failures = 0;
  for (const recipient of results) {
    const key = `${msg.id}:${recipient.id}`;
    if (await isProcessed(env.DB, key)) continue;
    if (await sendEmail(env, recipient.email, content)) {
      await markProcessed(env.DB, key).run();
    } else {
      failures++;
    }
  }
  if (failures > 0) throw new Error(`${failures} notification(s) failed`);
  logInfo("notification sent", { eventId: msg.id, kind: msg.payload.kind, recipients: results.length });
}

async function isProcessed(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS hit FROM processed_events WHERE id = ?").bind(id).first()) !== null;
}

function markProcessed(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare("INSERT INTO processed_events (id, processed_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING").bind(id, Date.now());
}

function isOutboxMessage(body: unknown): body is OutboxMessage {
  if (typeof body !== "object" || body === null) return false;
  const m = body as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.projectId !== "string" || typeof m.projectVersion !== "number") return false;
  const payload = m.payload as Record<string, unknown> | null | undefined;
  if (typeof payload !== "object" || payload === null) return false;
  if (m.type === "DIRECTORY_UPSERT") return Array.isArray(payload.members) && typeof payload.name === "string";
  if (m.type === "NOTIFY") return Array.isArray(payload.principalIds) && typeof payload.summary === "string";
  return false;
}
