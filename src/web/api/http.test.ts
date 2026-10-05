import { describe, expect, it, vi } from "vitest";
import { ApiError, fieldErrors } from "./errors";
import { backoffDelay, connectLive, createHttpApi } from "./http";
import { IdempotentSubmit } from "./idempotency";
import type { LiveStatus } from "./types";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const entryBody = {
  type: "EXPENSE" as const,
  description: "Dinner",
  occurredAt: "2026-09-15",
  originalAmount: "21280",
  originalCurrency: "EUR",
  conversion: { method: "IDENTITY" as const },
  payerMemberId: "m_kai",
  splitMode: "EQUAL" as const,
  participants: [{ memberId: "m_kai" }, { memberId: "m_ana" }],
};

describe("http client", () => {
  it("uploads a photo as its raw bytes and retries with the same key", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(json(201, { id: "att_1", contentType: "image/webp", bytes: 3, width: 1, height: 1 }));
    const api = createHttpApi({ fetch, retryDelayMs: () => 0 });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
    await expect(api.uploadAttachment("p_1", blob, { idempotencyKey: "key-photo" })).resolves.toMatchObject({ id: "att_1" });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe("/api/projects/p_1/attachments");
      expect(init?.body).toBe(blob);
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("image/webp");
      expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-photo");
    }
    expect(api.attachmentUrl("p_1", "att_1")).toBe("/api/projects/p_1/attachments/att_1");
  });
  it("does not retry API key creation when the response is lost", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("offline"));
    const api = createHttpApi({ fetch, retryDelayMs: () => 0 });
    await expect(api.createApiKey({ name: "Script", scope: "READ" })).rejects.toMatchObject({ code: "NETWORK" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("sends the Idempotency-Key, same-origin credentials and JSON body on mutations", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(201, { id: "e_1" }));
    const api = createHttpApi({ fetch });
    await api.createEntry("p_1", "r_1", entryBody, { idempotencyKey: "key-1" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/projects/p_1/rounds/r_1/entries");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-1");
    expect(JSON.parse(String(init?.body))).toEqual(entryBody);
  });

  it("retries a mutation after a network failure with the same key", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const api = createHttpApi({ fetch, retryDelayMs: () => 0 });
    await api.setReadiness("p_1", "r_1", { ready: true }, { idempotencyKey: "k-ready" });
    expect(fetch).toHaveBeenCalledTimes(3);
    const keys = fetch.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys).toEqual(["k-ready", "k-ready", "k-ready"]);
  });

  it("gives up after maxAttempts and reports a NETWORK error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("offline"));
    const api = createHttpApi({ fetch, retryDelayMs: () => 0, maxAttempts: 2 });
    const err = await api.startRound("p_1", { idempotencyKey: "k" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("NETWORK");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry definitive errors and parses ApiErrorBody with field and details", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(409, { error: { code: "REVIEW_STALE", message: "Something changed during review.", details: { currentReviewVersion: 7 } } }),
    );
    const api = createHttpApi({ fetch, retryDelayMs: () => 0 });
    const err = (await api
      .freeze("p_1", "r_1", { expectedReviewVersion: 6, acknowledgeNotReady: [] }, { idempotencyKey: "k" })
      .catch((e) => e)) as ApiError;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err.status).toBe(409);
    expect(err.code).toBe("REVIEW_STALE");
    expect(err.details).toEqual({ currentReviewVersion: 7 });
  });

  it("maps validation errors to form fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(422, { error: { code: "VALIDATION", message: "Amount must be positive", field: "originalAmount" } }),
    );
    const api = createHttpApi({ fetch });
    const err = await api.createEntry("p", "r", entryBody, { idempotencyKey: "k" }).catch((e) => e);
    expect(fieldErrors(err)).toEqual({ originalAmount: "Amount must be positive" });
  });

  it("falls back to a status-based error for non-JSON bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("<html>", { status: 429 }));
    const api = createHttpApi({ fetch });
    const err = await api.getProject("p").catch((e) => e);
    expect(err.code).toBe("RATE_LIMITED");
    expect(fieldErrors(err)).toEqual({ _form: err.message });
  });

  it("returns null from getMe on 401 and accepts a bare array from listProjects", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(401, { error: { code: "UNAUTHENTICATED", message: "Sign in" } }))
      .mockResolvedValueOnce(json(200, [{ id: "p_1" }]));
    const api = createHttpApi({ fetch });
    expect(await api.getMe()).toBeNull();
    expect(await api.listProjects()).toEqual([{ id: "p_1" }]);
  });

  it("refuses to send a mutation without a key", async () => {
    const api = createHttpApi({ fetch: vi.fn() });
    await expect(api.leave("p", { idempotencyKey: "" })).rejects.toThrow(/idempotency key/);
  });
});

describe("IdempotentSubmit", () => {
  it("reuses the key for the same payload until the server answers", () => {
    const s = new IdempotentSubmit();
    const a = s.keyFor({ ready: true, round: "r" });
    expect(s.keyFor({ round: "r", ready: true })).toBe(a); // key order doesn't matter
    s.settle(new ApiError(0, "NETWORK", "offline"));
    expect(s.keyFor({ ready: true, round: "r" })).toBe(a); // retry after a network error
    s.settle(); // success
    expect(s.keyFor({ ready: true, round: "r" })).not.toBe(a);
  });

  it("starts a new submit when the payload changes or after a definitive rejection", () => {
    const s = new IdempotentSubmit();
    const a = s.keyFor({ amount: "100" });
    const b = s.keyFor({ amount: "120" });
    expect(b).not.toBe(a);
    s.settle(new ApiError(422, "VALIDATION", "bad", "amount"));
    expect(s.keyFor({ amount: "120" })).not.toBe(b);
  });
});

describe("live updates", () => {
  class FakeSocket {
    static all: FakeSocket[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      FakeSocket.all.push(this);
    }
    close() {}
  }

  it("refetches on changed messages and after reconnecting, with backoff", () => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    const changes: string[] = [];
    const statuses: LiveStatus[] = [];
    const sub = connectLive(
      "/api/projects/p_1/live",
      { onChange: (r) => changes.push(r), onStatus: (s) => statuses.push(s) },
      { WebSocket: FakeSocket as unknown as typeof WebSocket, location: { protocol: "https:", host: "splitdummy.app" } },
    );
    const first = FakeSocket.all[0]!;
    expect(first.url).toBe("wss://splitdummy.app/api/projects/p_1/live");
    first.onopen!();
    first.onmessage!({ data: JSON.stringify({ type: "hello", projectVersion: 3 }) });
    first.onmessage!({ data: JSON.stringify({ type: "changed", projectVersion: 4, roundId: "r", reason: "ENTRY_CREATED" }) });
    expect(changes).toEqual(["ENTRY_CREATED"]);

    first.onclose!();
    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(30_000);
    const second = FakeSocket.all[1]!;
    second.onopen!();
    expect(statuses.at(-1)).toBe("open");
    expect(changes).toEqual(["ENTRY_CREATED", "reconnected"]);
    sub.close();
    vi.useRealTimers();
  });

  it("member endpoints hit the documented paths", async () => {
    const seen: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      seen.push(`${init?.method ?? "GET"} ${new URL(String(input instanceof Request ? input.url : input), "http://x").pathname}`);
      return json(200, {});
    });
    const api = createHttpApi({ fetch });
    const o = { idempotencyKey: "k-123456789" };
    await api.addMember("p_1", { displayName: "Zoe" }, o);
    await api.renameMember("p_1", "m_1", { displayName: "Z" }, o);
    await api.inviteMember("p_1", "m_1", { email: "z@example.com" }, o);
    await api.cancelMemberInvite("p_1", "m_1", o);
    await api.previewMemberInvite("p_1.secret");
    await api.acceptMemberInvite({ token: "p_1.secretsecretsecret" }, o);
    expect(seen).toEqual([
      "POST /api/projects/p_1/members",
      "PATCH /api/projects/p_1/members/m_1/name",
      "POST /api/projects/p_1/members/m_1/invite",
      "DELETE /api/projects/p_1/members/m_1/invite",
      "GET /api/member-invites/p_1.secret",
      "POST /api/member-invites/accept",
    ]);
  });

  it("caps the reconnect delay at 30 seconds plus jitter", () => {
    expect(backoffDelay(1, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, () => 0.5)).toBe(4000);
    expect(backoffDelay(20, () => 1)).toBe(37_500);
    expect(backoffDelay(20, () => 0)).toBe(22_500);
  });
});
