import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import { mockProjectDO, testEnv } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled backup", () => {
  it("snapshots every directory project into R2 as projects/<id>/<ISO>.json", async () => {
    const ids = [`p_${"1".repeat(32)}`, `p_${"2".repeat(32)}`];
    for (const [i, id] of ids.entries()) {
      for (const principal of ["pr_x", "pr_y"]) {
        await testEnv.DB.prepare(
          `INSERT INTO project_directory (principal_id, project_id, member_id, is_owner, status, name, base_currency, project_version, updated_at)
           VALUES (?, ?, 'm', 0, 'ACTIVE', 'n', 'EUR', ?, '2026-01-01T00:00:00Z')`,
        )
          .bind(principal, id, i + 1)
          .run();
      }
    }
    const { calls } = mockProjectDO((req) => ({ status: 200, body: { projectId: req.params.projectId, tables: { entries: [] } } }));

    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ cron: "17 3 * * *" }), testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(calls.map((c) => [c.op, c.principal, c.params.projectId]).sort()).toEqual(ids.map((id) => ["backupSnapshot", null, id]));
    for (const id of ids) {
      const listed = await testEnv.BACKUPS.list({ prefix: `projects/${id}/` });
      expect(listed.objects).toHaveLength(1);
      const key = listed.objects[0]?.key ?? "";
      expect(key).toMatch(new RegExp(`^projects/${id}/\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\\.json$`));
      const obj = await testEnv.BACKUPS.get(key);
      expect(await obj?.json()).toEqual({ projectId: id, tables: { entries: [] } });
      expect(obj?.httpMetadata?.contentType).toBe("application/json");
    }
  });

  it("purges expired sign-in tokens during housekeeping", async () => {
    await testEnv.DB.prepare(
      "INSERT INTO sign_in_tokens (token_hash, email, purpose, created_at, expires_at) VALUES ('old', 'x@example.com', 'SIGN_IN', 0, 1)",
    ).run();
    mockProjectDO(() => ({ status: 200, body: {} }));
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController(), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    const left = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sign_in_tokens WHERE token_hash = 'old'").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
