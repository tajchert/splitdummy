import { ATTACHMENT_TRASH_BATCH } from "../do/limits";
import { attachmentKey } from "../lib/attachments";
import { logError, logInfo } from "../lib/log";
import { callProject, isOk } from "../lib/project";

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_CONCURRENCY = 5;

/** Daily cron: versioned R2 backups of every project, photo cleanup, then D1 housekeeping. */
export async function handleScheduled(env: Env): Promise<void> {
  await backupAllProjects(env);
  await purgeAttachments(env);
  await housekeeping(env);
}

/** Runs `fn` for every directory project, BACKUP_CONCURRENCY at a time; counts failures (logs each one itself). */
async function forEachProject(env: Env, fn: (projectId: string) => Promise<void>, label: string): Promise<{ ok: number; failed: number }> {
  const { results } = await env.DB.prepare("SELECT DISTINCT project_id FROM project_directory").all<{ project_id: string }>();
  const queue = results.map((r) => r.project_id);
  let ok = 0;
  let failed = 0;
  const worker = async () => {
    for (let projectId = queue.shift(); projectId; projectId = queue.shift()) {
      try {
        await fn(projectId);
        ok++;
      } catch (err) {
        failed++;
        logError(`${label} failed`, err, { projectId });
      }
    }
  };
  await Promise.all(Array.from({ length: BACKUP_CONCURRENCY }, worker));
  return { ok, failed };
}

export async function backupAllProjects(env: Env): Promise<{ ok: number; failed: number }> {
  const stamp = new Date().toISOString();
  const { ok, failed } = await forEachProject(
    env,
    async (projectId) => {
      const res = await callProject(env, {
        op: "backupSnapshot",
        projectId,
        principal: null,
        requestId: `cron_${stamp}`,
      });
      if (!isOk(res)) throw new Error(`backupSnapshot status ${res.status}`);
      await env.BACKUPS.put(`projects/${projectId}/${stamp}.json`, JSON.stringify(res.body), {
        httpMetadata: { contentType: "application/json" },
      });
    },
    "project backup",
  );
  logInfo("backup finished", { ok, failed });
  return { ok, failed };
}

/** Deletes trashed photos from R2 and only then lets the DO forget them, so a failed delete is retried tomorrow. */
export async function purgeAttachments(env: Env): Promise<{ deleted: number; failed: number }> {
  const requestId = `cron_${new Date().toISOString()}`;
  let deleted = 0;
  const { failed } = await forEachProject(
    env,
    async (projectId) => {
      for (;;) {
        const taken = await callProject(env, { op: "takeAttachmentTrash", projectId, principal: null, requestId });
        if (!isOk(taken)) throw new Error(`takeAttachmentTrash status ${taken.status}`);
        const { ids } = taken.body as { ids: string[] };
        if (ids.length === 0) return;
        await env.ATTACHMENTS.delete(ids.map((id) => attachmentKey(projectId, id)));
        const ack = await callProject(env, { op: "ackAttachmentTrash", projectId, principal: null, body: { ids }, requestId });
        if (!isOk(ack)) throw new Error(`ackAttachmentTrash status ${ack.status}`);
        deleted += ids.length;
        if (ids.length < ATTACHMENT_TRASH_BATCH) return;
      }
    },
    "photo purge",
  );
  logInfo("photo purge finished", { deleted, failed });
  return { deleted, failed };
}

async function housekeeping(env: Env): Promise<void> {
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sign_in_tokens WHERE expires_at < ?").bind(now - DAY_MS),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?").bind(now, now - 30 * DAY_MS),
      env.DB.prepare("DELETE FROM processed_events WHERE processed_at < ?").bind(now - 30 * DAY_MS),
      // Late outbox deliveries are long retried or dead-lettered by then.
      env.DB.prepare("DELETE FROM directory_tombstones WHERE deleted_at < ?").bind(now - 30 * DAY_MS),
      // Guests whose every session lapsed and who never joined anything are unreachable.
      env.DB.prepare(
        `DELETE FROM principals WHERE kind = 'GUEST' AND email IS NULL AND created_at < ?
           AND id NOT IN (SELECT principal_id FROM sessions) AND id NOT IN (SELECT principal_id FROM project_directory)`,
      ).bind(now - DAY_MS),
    ]);
  } catch (err) {
    logError("housekeeping failed", err);
  }
}
