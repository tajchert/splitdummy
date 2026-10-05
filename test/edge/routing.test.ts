import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS } from "@shared/api";
import { PROJECT_ROUTES } from "../../worker/routes/projects";
import { call, mockProjectDO, mockTurnstile, signIn, uniqueEmail } from "./helpers";

const P = `p_${"0123456789abcdef".repeat(2)}`;
let cookie: string;

beforeEach(async () => {
  mockTurnstile();
  cookie = await signIn(uniqueEmail("route"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const validEntry = {
  type: "EXPENSE",
  description: "Dinner",
  occurredAt: "2026-10-01",
  originalAmount: "43000",
  originalCurrency: "PLN",
  conversion: { method: "IDENTITY" },
  payerMemberId: "m_a",
  splitMode: "EQUAL",
  participants: [{ memberId: "m_a" }, { memberId: "m_b" }],
};

describe("project routing", () => {
  it("every ENDPOINTS entry is routed (edge-handled or DO-mapped)", () => {
    const edgeHandled = [
      "config",
      "me",
      "updateMe",
      "deletionPreview",
      "deleteAccount",
      "signIn",
      "verify",
      "verifySignIn",
      "signOut",
      "attachEmail",
      "listProjects",
      "createProject",
      "previewInvite",
      "join",
      "live",
      // Member invites: custom edge handlers in routes/members.ts (renameMember/cancelMemberInvite are DO-mapped).
      "addMember",
      "inviteMember",
      "previewMemberInvite",
      "acceptMemberInvite",
    ];
    const mapped = Object.keys(PROJECT_ROUTES);
    expect([...edgeHandled, ...mapped].sort()).toEqual(Object.keys(ENDPOINTS).sort());
  });

  it("maps a mutation to its DoOp with params, parsed body, idempotency key, principal and request id", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: { id: "e_1" } }));
    const res = await call(`/api/projects/${P}/rounds/r_1/entries/e_1`, {
      method: "PATCH",
      cookie,
      idempotencyKey: "idem-key-123",
      body: { ...validEntry, description: "  Dinner  ", expectedRevision: 2, extra: "dropped" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    const req = calls[0];
    expect(req).toMatchObject({
      op: "updateEntry",
      params: { projectId: P, roundId: "r_1", entryId: "e_1" },
      idempotencyKey: "idem-key-123",
      principal: { kind: "ACCOUNT", hasRecoverableAccount: true },
    });
    expect(req?.requestId).toBe(res.headers.get("x-request-id"));
    expect(req?.body).toMatchObject({ description: "Dinner", expectedRevision: 2 });
    expect(req?.body).not.toHaveProperty("extra");
  });

  it.each([
    ["GET", `/api/projects/${P}`, "getProject", {}],
    ["PATCH", `/api/projects/${P}/settings`, "updateSettings", {}],
    ["PUT", `/api/projects/${P}/rates/EUR`, "putRate", { currency: "EUR" }],
    ["DELETE", `/api/projects/${P}/rates/EUR`, "deleteRate", { currency: "EUR" }],
    ["POST", `/api/projects/${P}/invitations`, "createInvite", {}],
    ["DELETE", `/api/projects/${P}/invitations/inv_1`, "revokeInvite", { inviteId: "inv_1" }],
    ["DELETE", `/api/projects/${P}/members/m_2`, "removeMember", { memberId: "m_2" }],
    ["POST", `/api/projects/${P}/leave`, "leave", {}],
    ["PATCH", `/api/projects/${P}/members/me`, "renameMe", {}],
    ["PATCH", `/api/projects/${P}/members/m_2/name`, "renameMember", { memberId: "m_2" }],
    ["DELETE", `/api/projects/${P}/members/m_2/invite`, "cancelMemberInvite", { memberId: "m_2" }],
    ["POST", `/api/projects/${P}/ownership`, "transferOwnership", {}],
    ["POST", `/api/projects/${P}/ownership/accept`, "acceptOwnership", {}],
    ["POST", `/api/projects/${P}/rounds/r_1/entries`, "createEntry", { roundId: "r_1" }],
    ["DELETE", `/api/projects/${P}/rounds/r_1/entries/e_1`, "deleteEntry", { roundId: "r_1", entryId: "e_1" }],
    ["POST", `/api/projects/${P}/rounds/r_1/adjustments`, "createAdjustment", { roundId: "r_1" }],
    ["PUT", `/api/projects/${P}/rounds/r_1/readiness/me`, "setReadiness", { roundId: "r_1" }],
    ["GET", `/api/projects/${P}/rounds/r_1/review`, "getReview", { roundId: "r_1" }],
    ["POST", `/api/projects/${P}/rounds/r_1/freeze`, "freeze", { roundId: "r_1" }],
    ["PUT", `/api/projects/${P}/rounds/r_1/freeze-schedule`, "setFreezeSchedule", { roundId: "r_1" }],
    ["GET", `/api/projects/${P}/rounds/r_1`, "getRound", { roundId: "r_1" }],
    ["POST", `/api/projects/${P}/rounds/r_1/instructions/i_1/sent`, "markSent", { instructionId: "i_1" }],
    ["POST", `/api/projects/${P}/rounds/r_1/instructions/i_1/received`, "markReceived", { instructionId: "i_1" }],
    ["POST", `/api/projects/${P}/rounds/r_1/instructions/i_1/dispute`, "markDisputed", { instructionId: "i_1" }],
    ["POST", `/api/projects/${P}/rounds`, "startRound", {}],
    ["GET", `/api/projects/${P}/history`, "getHistory", {}],
    ["GET", `/api/projects/${P}/export`, "exportCsv", {}],
  ])("%s %s → %s", async (method, path, op, params) => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    const bodies: Record<string, unknown> = {
      updateSettings: { expectedVersion: 1 },
      putRate: { rate: "4.3" },
      transferOwnership: { toMemberId: "m_2" },
      createEntry: validEntry,
      deleteEntry: { expectedRevision: 1 },
      createAdjustment: {
        correctedEntryId: "e_1",
        correctedRoundId: "r_0",
        description: "Fix",
        occurredAt: "2026-10-01",
        effects: [
          { memberId: "m_a", baseAmount: "100" },
          { memberId: "m_b", baseAmount: "-100" },
        ],
      },
      setReadiness: { ready: true },
      freeze: { expectedReviewVersion: 3 },
      renameMe: { displayName: "Ann P." },
      renameMember: { displayName: "Zoe" },
      setFreezeSchedule: { date: "2026-12-24", timeZone: "Europe/Warsaw" },
    };
    const res = await call(path, { method, cookie, body: method === "GET" ? undefined : (bodies[op] ?? {}) });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe(op);
    expect(calls[0]?.params).toMatchObject({ projectId: P, ...params });
    expect(calls[0]?.idempotencyKey === null).toBe(method === "GET");
  });

  it("routes PATCH members/me to renameMe, not removeMember, and validates the schedule body", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    await call(`/api/projects/${P}/members/me`, { method: "PATCH", cookie, body: { displayName: "  Ann  " } });
    expect(calls[0]).toMatchObject({ op: "renameMe", body: { displayName: "Ann" } });
    expect(calls[0]?.params).not.toHaveProperty("memberId");
    const bad = await call(`/api/projects/${P}/rounds/r_1/freeze-schedule`, { method: "PUT", cookie, body: { date: "24.12.2026", timeZone: "UTC" } });
    expect(bad.status).toBe(422);
    expect((await bad.json<{ error: { field: string } }>()).error.field).toBe("date");
    await call(`/api/projects/${P}/rounds/r_1/freeze-schedule`, { method: "PUT", cookie, body: { date: null, timeZone: "UTC" } });
    expect(calls[1]).toMatchObject({ op: "setFreezeSchedule", body: { date: null, timeZone: "UTC" } });
  });

  it("applies schema defaults before calling the DO", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    await call(`/api/projects/${P}/rounds/r_1/freeze`, { cookie, body: { expectedReviewVersion: 3 } });
    expect(calls[0]?.body).toEqual({ expectedReviewVersion: 3, acknowledgeNotReady: [] });
  });

  it("passes DO status and error bodies through", async () => {
    const error = { error: { code: "REVIEW_STALE", message: "Review changed", details: { currentReviewVersion: 7 } } };
    mockProjectDO(() => ({ status: 409, body: error }));
    const res = await call(`/api/projects/${P}/rounds/r_1/freeze`, { cookie, body: { expectedReviewVersion: 3 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(error);
  });

  it("serves CSV export with a CSV content type", async () => {
    mockProjectDO(() => ({ status: 200, body: "a,b\r\n1,2\r\n", headers: { "content-disposition": 'attachment; filename="trip.csv"' } }));
    const res = await call(`/api/projects/${P}/export`, { cookie });
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("trip.csv");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("a,b\r\n1,2\r\n");
  });

  it("returns 204 bodies empty", async () => {
    mockProjectDO(() => ({ status: 204, body: null }));
    const res = await call(`/api/projects/${P}/rates/EUR`, { method: "DELETE", cookie });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("validates input with shared schemas (422 with field path)", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    const res = await call(`/api/projects/${P}/rounds/r_1/entries`, {
      cookie,
      body: { ...validEntry, originalAmount: "12.50" },
    });
    expect(res.status).toBe(422);
    expect((await res.json<{ error: { code: string; field: string } }>()).error).toMatchObject({ code: "VALIDATION", field: "originalAmount" });
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed project IDs with 404 without reaching a DO", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    for (const id of ["p_short", "x_0123456789abcdef0123456789abcdef", "p_0123456789ABCDEF0123456789ABCDEF"]) {
      expect((await call(`/api/projects/${id}`, { cookie })).status).toBe(404);
    }
    expect((await call(`/api/projects/${P}/rates/eur`, { method: "PUT", cookie, body: { rate: "1" } })).status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("requires a session (401) for member routes", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    const res = await call(`/api/projects/${P}`);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("maps DO transport failures to 500 INTERNAL with a request id", async () => {
    mockProjectDO(() => {
      throw new Error("boom with secret payload");
    });
    const res = await call(`/api/projects/${P}`, { cookie });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string; details: { requestId: string } } }>();
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("secret");
    expect(body.error.details.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("unknown /api paths are JSON 404s", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("NOT_FOUND");
  });
});
