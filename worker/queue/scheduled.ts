import { logError, logInfo } from "../lib/log";
import { callProject, isOk } from "../lib/project";

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_CONCURRENCY = 5;

/** Daily cron: versioned R2 backups of every project, then D1 housekeeping. */
export async function handleScheduled(env: Env): Promise<void> {
  await backupAllProjects(env);
  await housekeeping(env);
}

export async function backupAllProjects(env: Env): Promise<{ ok: number; failed: number }> {
  const { results } = await env.DB.prepare("SELECT DISTINCT project_id FROM project_directory").all<{ project_id: string }>();
  const queue = results.map((r) => r.project_id);
  const stamp = new Date().toISOString();
  let ok = 0;
  let failed = 0;

  const worker = async () => {
    for (let projectId = queue.shift(); projectId; projectId = queue.shift()) {
      try {
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
        ok++;
      } catch (err) {
        failed++;
        logError("project backup failed", err, { projectId });
      }
    }
  };
  await Promise.all(Array.from({ length: BACKUP_CONCURRENCY }, worker));
  logInfo("backup finished", { ok, failed });
  return { ok, failed };
}

async function housekeeping(env: Env): Promise<void> {
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sign_in_tokens WHERE expires_at < ?").bind(now - DAY_MS),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?").bind(now, now - 30 * DAY_MS),
      env.DB.prepare("DELETE FROM processed_events WHERE processed_at < ?").bind(now - 30 * DAY_MS),
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
