import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummaryDTO } from "@shared/api";
import { call, mockProjectDO, mockTurnstile, projectView, sessionCookie, signIn, testEnv, uniqueEmail } from "./helpers";

beforeEach(() => {
  mockTurnstile();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const createBody = { name: "Trip", baseCurrency: "PLN", ownerDisplayName: "Ann", turnstileToken: "ok" };

async function guestCookie(): Promise<string> {
  mockProjectDO((req) => (req.op === "join" ? { status: 200, body: { projectId: req.params.projectId } } : { status: 500, body: null }));
  const res = await call("/api/invitations/join", {
    body: { token: `p_${"9".repeat(32)}.${"t".repeat(43)}`, displayName: "Gus", turnstileToken: "ok" },
  });
  vi.restoreAllMocks();
  mockTurnstile();
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error("no guest");
  return cookie;
}

describe("POST /api/projects", () => {
  it("401 without a session", async () => {
    const res = await call("/api/projects", { body: createBody });
    expect(res.status).toBe(401);
  });

  it("403 ACCOUNT_REQUIRED for guests (owners must be recoverable)", async () => {
    const cookie = await guestCookie();
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    const res = await call("/api/projects", { cookie, body: createBody });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: { code: string; details: { reason: string } } }>()).error).toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "ACCOUNT_REQUIRED" },
    });
    expect(calls).toHaveLength(0);
  });

  it("creates with a generated p_ id, strips the Turnstile token, and fills the directory immediately", async () => {
    const cookie = await signIn(uniqueEmail("owner"));
    const { calls } = mockProjectDO((req) => ({ status: 201, body: projectView(req.params.projectId ?? "", "m_owner", 1) }));
    const res = await call("/api/projects", { cookie, body: createBody, idempotencyKey: "create-key-1" });
    expect(res.status).toBe(201);
    const req = calls[0];
    expect(req?.op).toBe("createProject");
    const projectId = req?.params.projectId ?? "";
    expect(projectId).toMatch(/^p_[0-9a-f]{32}$/);
    expect(req?.body).toEqual({ name: "Trip", baseCurrency: "PLN", multiCurrencyEnabled: false, ownerDisplayName: "Ann", projectId });
    expect(req?.principal).toMatchObject({ kind: "ACCOUNT", hasRecoverableAccount: true });

    const list = await (await call("/api/projects", { cookie })).json<ProjectSummaryDTO[]>();
    expect(list).toEqual([
      expect.objectContaining({ id: projectId, name: "Trip", baseCurrency: "PLN", isOwner: true, roundStatus: "COLLECTING", roundSequence: 1 }),
    ]);
    const me = await (await call("/api/me", { cookie })).json<{ displayName: string }>();
    expect(me.displayName).toBe("Ann");
  });

  it("a retried create (same Idempotency-Key) targets the same project", async () => {
    const cookie = await signIn(uniqueEmail("owner"));
    const { calls } = mockProjectDO((req) => ({ status: 201, body: projectView(req.params.projectId ?? "") }));
    await call("/api/projects", { cookie, body: createBody, idempotencyKey: "same-key-123" });
    await call("/api/projects", { cookie, body: createBody, idempotencyKey: "same-key-123" });
    await call("/api/projects", { cookie, body: createBody, idempotencyKey: "other-key-123" });
    expect(calls[0]?.params.projectId).toBe(calls[1]?.params.projectId);
    expect(calls[2]?.params.projectId).not.toBe(calls[0]?.params.projectId);
  });

  it("does not touch the directory when the DO rejects", async () => {
    const cookie = await signIn(uniqueEmail("owner"));
    mockProjectDO(() => ({ status: 422, body: { error: { code: "VALIDATION", message: "nope" } } }));
    const res = await call("/api/projects", { cookie, body: createBody });
    expect(res.status).toBe(422);
    expect(await (await call("/api/projects", { cookie })).json()).toEqual([]);
  });

  it("Turnstile failure blocks creation", async () => {
    const cookie = await signIn(uniqueEmail("owner"));
    const { calls } = mockProjectDO(() => ({ status: 201, body: {} }));
    const res = await call("/api/projects", { cookie, body: { ...createBody, turnstileToken: "fail" } });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /api/projects", () => {
  it("lists only ACTIVE directory rows for the caller, newest first", async () => {
    const cookie = await signIn(uniqueEmail("lister"));
    const { principalId } = await (await call("/api/me", { cookie })).json<{ principalId: string }>();
    const insert = (projectId: string, status: string, updatedAt: string, owner = principalId) =>
      testEnv.DB.prepare(
        `INSERT INTO project_directory (principal_id, project_id, member_id, is_owner, status, name, base_currency, project_version, updated_at)
         VALUES (?, ?, 'm_1', 0, ?, ?, 'EUR', 1, ?)`,
      )
        .bind(owner, projectId, status, projectId, updatedAt)
        .run();
    await insert("p_old", "ACTIVE", "2026-01-01T00:00:00.000Z");
    await insert("p_new", "ACTIVE", "2026-02-01T00:00:00.000Z");
    await insert("p_left", "LEFT", "2026-03-01T00:00:00.000Z");
    await insert("p_someone_else", "ACTIVE", "2026-03-01T00:00:00.000Z", "pr_other");
    const list = await (await call("/api/projects", { cookie })).json<ProjectSummaryDTO[]>();
    expect(list.map((p) => p.id)).toEqual(["p_new", "p_old"]);
  });

  it("401 without a session", async () => {
    expect((await call("/api/projects")).status).toBe(401);
  });
});

describe("invitations", () => {
  const P = `p_${"c".repeat(32)}`;
  const token = `${P}.${"S".repeat(43)}`;

  it("join without a session creates a GUEST principal + session and routes by token prefix", async () => {
    const { calls } = mockProjectDO((req) =>
      req.op === "join" ? { status: 200, body: { projectId: P } } : { status: 200, body: projectView(P, "m_guest", 4) },
    );
    const res = await call("/api/invitations/join", { body: { token, displayName: " Bob ", turnstileToken: "ok" }, idempotencyKey: "join-key-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projectId: P });
    const cookie = sessionCookie(res);
    expect(cookie).not.toBeNull();

    const join = calls.find((c) => c.op === "join");
    expect(join).toMatchObject({
      params: { projectId: P, tokenSecret: "S".repeat(43) },
      body: { displayName: "Bob" },
      idempotencyKey: "join-key-1",
      principal: { kind: "GUEST", email: null, hasRecoverableAccount: false },
    });
    const me = await (await call("/api/me", { cookie })).json<{ principalId: string; kind: string; displayName: string }>();
    expect(me).toMatchObject({ principalId: join?.principal?.principalId, kind: "GUEST", displayName: "Bob" });

    const list = await (await call("/api/projects", { cookie })).json<ProjectSummaryDTO[]>();
    expect(list).toEqual([expect.objectContaining({ id: P, isOwner: true })]);
  });

  it("join with a session reuses the principal and sets no new cookie", async () => {
    const cookie = await signIn(uniqueEmail("joiner"));
    const { principalId } = await (await call("/api/me", { cookie })).json<{ principalId: string }>();
    const { calls } = mockProjectDO((req) => (req.op === "join" ? { status: 200, body: { projectId: P } } : { status: 200, body: projectView(P) }));
    const res = await call("/api/invitations/join", { cookie, body: { token, displayName: "Bob", turnstileToken: "ok" } });
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeNull();
    expect(calls[0]?.principal?.principalId).toBe(principalId);
  });

  it("a rejected join issues no cookie and leaves no guest principal behind", async () => {
    const before = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM principals WHERE kind = 'GUEST'").first<{ n: number }>();
    mockProjectDO(() => ({ status: 404, body: { error: { code: "INVITE_INVALID", message: "Invalid" } } }));
    const res = await call("/api/invitations/join", { body: { token, displayName: "Bob", turnstileToken: "ok" } });
    expect(res.status).toBe(404);
    expect(sessionCookie(res)).toBeNull();
    const after = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM principals WHERE kind = 'GUEST'").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("malformed tokens are INVITE_INVALID without reaching a DO", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    for (const bad of ["no-dot-token-at-all-here", `p_bad.${"S".repeat(43)}`, `${P}.short`, `${P}.${"S".repeat(40)}!!!`]) {
      const res = await call("/api/invitations/join", { body: { token: bad, displayName: "Bob", turnstileToken: "ok" } });
      expect(res.status).toBe(404);
      expect((await res.json<{ error: { code: string } }>()).error.code).toBe("INVITE_INVALID");
    }
    expect((await call(`/api/invitations/garbage`)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("join Turnstile can come from the X-Turnstile-Token header", async () => {
    mockProjectDO((req) => (req.op === "join" ? { status: 200, body: { projectId: P } } : { status: 200, body: projectView(P) }));
    const ok = await call("/api/invitations/join", { body: { token, displayName: "Bob" }, headers: { "x-turnstile-token": "ok" } });
    expect(ok.status).toBe(200);
    const bad = await call("/api/invitations/join", { body: { token, displayName: "Bob" }, headers: { "x-turnstile-token": "fail" } });
    expect(bad.status).toBe(403);
  });

  it("preview works without a session (principal null)", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: { projectName: "Trip", baseCurrency: "PLN", status: "OPEN", alreadyMemberProjectId: null } }));
    const res = await call(`/api/invitations/${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ op: "previewInvite", principal: null, params: { projectId: P, tokenSecret: "S".repeat(43) } });
  });

  it("preview passes the principal when signed in", async () => {
    const cookie = await signIn(uniqueEmail("viewer"));
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    await call(`/api/invitations/${token}`, { cookie });
    expect(calls[0]?.principal?.kind).toBe("ACCOUNT");
  });
});
