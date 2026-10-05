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
    const { calls } = mockProjectDO((req) =>
      req.op === "backupSnapshot" ? { status: 200, body: { projectId: req.params.projectId, tables: { entries: [] } } } : { status: 200, body: { ids: [] } },
    );

    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ cron: "17 3 * * *" }), testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(calls.filter((c) => c.op === "backupSnapshot").map((c) => [c.op, c.principal, c.params.projectId]).sort()).toEqual(ids.map((id) => ["backupSnapshot", null, id]));
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
    mockProjectDO(() => ({ status: 200, body: { ids: [] } }));
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController(), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    const left = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sign_in_tokens WHERE token_hash = 'old'").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("scheduled photo purge", () => {
  const projectId = `p_${"3".repeat(32)}`;
  const key = (id: string) => `projects/${projectId}/attachments/${id}`;

  async function seedDirectory() {
    await testEnv.DB.prepare(
      `INSERT OR IGNORE INTO project_directory (principal_id, project_id, member_id, is_owner, status, name, base_currency, project_version, updated_at)
       VALUES ('pr_z', ?, 'm', 1, 'ACTIVE', 'n', 'EUR', 1, '2026-01-01T00:00:00Z')`,
    ).bind(projectId).run();
  }

  it("deletes trashed photos from R2, then acknowledges them", async () => {
    await seedDirectory();
    await testEnv.ATTACHMENTS.put(key("att_gone"), "x");
    await testEnv.ATTACHMENTS.put(key("att_kept"), "y");
    const { calls } = mockProjectDO((req) =>
      req.op === "takeAttachmentTrash" ? { status: 200, body: { ids: ["att_gone"] } } : { status: 200, body: { ok: true, tables: {} } },
    );
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController(), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(await testEnv.ATTACHMENTS.head(key("att_gone"))).toBeNull();
    expect(await testEnv.ATTACHMENTS.head(key("att_kept"))).not.toBeNull();
    expect(calls.find((c) => c.op === "ackAttachmentTrash")).toMatchObject({ principal: null, body: { ids: ["att_gone"] } });
  });

  it("does not acknowledge when the R2 delete fails", async () => {
    await seedDirectory();
    const { calls } = mockProjectDO((req) =>
      req.op === "takeAttachmentTrash" ? { status: 200, body: { ids: ["att_x"] } } : { status: 200, body: { ok: true, tables: {} } },
    );
    const broken = { ...testEnv, ATTACHMENTS: { delete: async () => { throw new Error("r2 down"); } } } as unknown as Env;
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController(), broken, ctx);
    await waitOnExecutionContext(ctx);
    expect(calls.some((c) => c.op === "ackAttachmentTrash")).toBe(false);
  });
});
