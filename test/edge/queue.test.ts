import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";
import type { OutboxMessage } from "../../worker/do/types";
import { processMessage } from "../../worker/queue/consumer";
import { testEnv } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

const uid = () => crypto.randomUUID().replace(/-/g, "");

function upsert(projectId: string, version: number, overrides: Partial<{ name: string; status: "ACTIVE" | "LEFT" | "REMOVED"; principalIds: string[] }> = {}): OutboxMessage {
  return {
    id: `ev_${uid()}`,
    type: "DIRECTORY_UPSERT",
    projectId,
    projectVersion: version,
    payload: {
      name: overrides.name ?? `v${version}`,
      baseCurrency: "EUR",
      roundStatus: "COLLECTING",
      roundSequence: 1,
      members: (overrides.principalIds ?? ["pr_a", "pr_b"]).map((principalId, i) => ({
        principalId,
        memberId: `m_${i}`,
        isOwner: i === 0,
        status: overrides.status ?? "ACTIVE",
        nextAction: "ADD_EXPENSES",
      })),
    },
  };
}

async function rows(projectId: string) {
  const { results } = await testEnv.DB.prepare(
    "SELECT principal_id, name, project_version, status, next_action FROM project_directory WHERE project_id = ? ORDER BY principal_id",
  )
    .bind(projectId)
    .all();
  return results;
}

async function runBatch(messages: OutboxMessage[], env: Env = testEnv) {
  const batch = createMessageBatch<unknown>(
    "splitdummy-events",
    messages.map((body, i) => ({ id: `msg-${i}`, timestamp: new Date(), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, ctx);
}

describe("DIRECTORY_UPSERT projection", () => {
  it("creates one row per member", async () => {
    const p = `p_${uid()}`;
    const result = await runBatch([upsert(p, 3)]);
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(await rows(p)).toEqual([
      { principal_id: "pr_a", name: "v3", project_version: 3, status: "ACTIVE", next_action: "ADD_EXPENSES" },
      { principal_id: "pr_b", name: "v3", project_version: 3, status: "ACTIVE", next_action: "ADD_EXPENSES" },
    ]);
  });

  it("duplicate delivery of the same event is a no-op (dedupe by id)", async () => {
    const p = `p_${uid()}`;
    const msg = upsert(p, 2);
    await processMessage(testEnv, msg);
    // Something newer lands, then the old duplicate is redelivered.
    await processMessage(testEnv, upsert(p, 5, { name: "newer" }));
    await processMessage(testEnv, msg);
    const r = await rows(p);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.project_version === 5 && x.name === "newer")).toBe(true);
  });

  it("out-of-order delivery never regresses the version", async () => {
    const p = `p_${uid()}`;
    await runBatch([upsert(p, 7, { name: "seven" }), upsert(p, 4, { name: "four" }), upsert(p, 6, { name: "six" })]);
    const r = await rows(p);
    expect(r.map((x) => [x.name, x.project_version])).toEqual([
      ["seven", 7],
      ["seven", 7],
    ]);
  });

  it("status changes (LEFT) apply and hide the project from GET /api/projects", async () => {
    const p = `p_${uid()}`;
    await processMessage(testEnv, upsert(p, 1));
    await processMessage(testEnv, upsert(p, 2, { status: "LEFT" }));
    expect((await rows(p)).map((x) => x.status)).toEqual(["LEFT", "LEFT"]);
  });

  it("a projection of the same version as a synchronous upsert fills in nextAction", async () => {
    const p = `p_${uid()}`;
    await testEnv.DB.prepare(
      `INSERT INTO project_directory (principal_id, project_id, member_id, is_owner, status, name, base_currency, project_version, updated_at)
       VALUES ('pr_a', ?, 'm_0', 1, 'ACTIVE', 'v1', 'EUR', 1, '2026-01-01T00:00:00.000Z')`,
    )
      .bind(p)
      .run();
    await processMessage(testEnv, upsert(p, 1, { principalIds: ["pr_a"] }));
    expect((await rows(p))[0]?.next_action).toBe("ADD_EXPENSES");
  });

  it("acks malformed messages instead of retrying forever", async () => {
    const result = await runBatch([{ nope: true } as unknown as OutboxMessage]);
    expect(result.explicitAcks).toEqual(["msg-0"]);
  });
});

describe("NOTIFY", () => {
  async function principal(email: string | null) {
    const id = `pr_${uid()}`;
    await testEnv.DB.prepare("INSERT INTO principals (id, kind, email, created_at, updated_at) VALUES (?, ?, ?, 0, 0)")
      .bind(id, email ? "ACCOUNT" : "GUEST", email)
      .run();
    return id;
  }
  function notify(principalIds: string[]): OutboxMessage {
    return {
      id: `ev_${uid()}`,
      type: "NOTIFY",
      projectId: `p_${uid()}`,
      projectVersion: 9,
      payload: { kind: "ROUND_FROZEN", principalIds, summary: "Trip: expenses are frozen" },
    };
  }

  it("emails only principals with a verified email, once per recipient across redeliveries", async () => {
    const a = await principal(`a-${uid()}@example.com`);
    const g = await principal(null);
    const send = vi.fn(async () => ({ messageId: "x" }));
    const env = { ...testEnv, EMAIL: { send } } as unknown as Env;
    const msg = notify([a, g, a]);
    await processMessage(env, msg);
    await processMessage(env, msg);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = (send.mock.calls[0] as unknown[])[0] as { to: string; subject: string; text: string; html: string };
    expect(sent.to).toMatch(/^a-/);
    expect(sent.subject).toContain("expenses are frozen");
    expect(sent.text).toContain("/projects/");
    expect(sent.html).toContain("<html");
  });

  it("retries on send failure without re-mailing recipients that already succeeded", async () => {
    const a = await principal(`a-${uid()}@example.com`);
    const b = await principal(`b-${uid()}@example.com`);
    let failB = true;
    const send = vi.fn(async (m: { to: string }) => {
      if (m.to.startsWith("b-") && failB) throw new Error("provider down");
      return { messageId: "x" };
    });
    const env = { ...testEnv, EMAIL: { send } } as unknown as Env;
    const msg = notify([a, b]);
    const first = await runBatch([msg], env);
    expect(first.retryMessages).toEqual([expect.objectContaining({ msgId: "msg-0" })]);
    failB = false;
    const second = await runBatch([msg], env);
    expect(second.explicitAcks).toEqual(["msg-0"]);
    const recipients = send.mock.calls.map((c) => (c[0] as { to: string }).to[0]);
    expect(recipients.sort()).toEqual(["a", "b", "b"]);
  });
});
