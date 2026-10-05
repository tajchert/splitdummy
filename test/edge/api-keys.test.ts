import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryDTO, ProjectViewDTO } from "@shared/api";
import { sha256Hex } from "../../worker/lib/crypto";
import { createGuest } from "../../worker/auth/principals";
import { createSession } from "../../worker/auth/session";
import { call, mockTurnstile, signIn, testEnv, uniqueEmail } from "./helpers";

beforeEach(() => { mockTurnstile(); });
afterEach(() => vi.restoreAllMocks());

interface Key { id: string; name: string; scope: "READ" | "WRITE"; token: string; expiresAt: string }
async function issue(cookie: string, scope = "READ"): Promise<Key> {
  const res = await call("/api/me/api-keys", { cookie, body: { name: "My script", scope } });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json<Key>();
}
const bearer = (key: Key) => ({ authorization: `Bearer ${key.token}` });
async function group(cookie: string): Promise<ProjectViewDTO> {
  const res = await call("/api/projects", { cookie, body: { name: "API trip", baseCurrency: "PLN", ownerDisplayName: "Ann" } });
  expect(res.status).toBe(201);
  return res.json<ProjectViewDTO>();
}

describe("personal API keys", () => {
  it("reveals a secret once, stores only its hash, and authenticates without cookies", async () => {
    const cookie = await signIn(uniqueEmail());
    const key = await issue(cookie);
    expect(key.token).toMatch(/^sd_[A-Za-z0-9_-]{43}$/);
    const stored = await testEnv.DB.prepare("SELECT token_hash FROM api_keys WHERE id = ?").bind(key.id).first<{ token_hash: string }>();
    expect(stored?.token_hash).toBe(await sha256Hex(key.token));
    const listed = await call("/api/me/api-keys", { cookie });
    const listedText = await listed.text();
    expect(JSON.parse(listedText)).toEqual([expect.objectContaining({ id: key.id, name: "My script", scope: "READ" })]);
    expect(listedText).not.toContain(key.token);
    const me = await call("/api/me", { headers: bearer(key) });
    expect(me.status).toBe(200);
    expect(me.headers.get("set-cookie")).toBeNull();
    expect((await call("/api/projects", { headers: bearer(key) })).status).toBe(200);
  });

  it("supports writes without Origin and replays the same expense on retry", async () => {
    const cookie = await signIn(uniqueEmail());
    const key = await issue(cookie, "WRITE");
    const view = await group(cookie);
    const path = `/api/projects/${view.project.id}/rounds/${view.current.round.id}/entries`;
    const init = { headers: bearer(key), origin: null, idempotencyKey: crypto.randomUUID(), body: {
      type: "EXPENSE", description: "Lunch", occurredAt: "2026-10-05", originalAmount: "1250", originalCurrency: "PLN",
      conversion: { method: "IDENTITY" }, payerMemberId: view.me.memberId, splitMode: "EQUAL", participants: [{ memberId: view.me.memberId }],
    } };
    const first = await call(path, init);
    expect(first.status).toBe(201);
    const entry = await first.json<EntryDTO>();
    const retry = await call(path, init);
    expect(retry.status).toBe(201);
    expect((await retry.json<EntryDTO>()).id).toBe(entry.id);
    expect((await call(path, { ...init, body: { ...init.body, description: "Different" } })).status).toBe(409);
    expect((await call(path, { ...init, idempotencyKey: null })).status).toBe(422);
    const fetched = await call(`/api/projects/${view.project.id}`, { headers: bearer(key) });
    expect((await fetched.json<ProjectViewDTO>()).current.entries).toHaveLength(1);
  });

  it("read-only keys reject mutations even with a writable browser session", async () => {
    const cookie = await signIn(uniqueEmail());
    const key = await issue(cookie);
    expect((await call("/api/projects", { cookie, headers: bearer(key), body: { name: "No", baseCurrency: "PLN", ownerDisplayName: "Ann" } })).status).toBe(403);
  });

  it("API keys cannot manage keys, delete accounts, change identity or log out", async () => {
    const cookie = await signIn(uniqueEmail());
    const key = await issue(cookie, "WRITE");
    for (const [path, method, body] of [
      ["/api/me/api-keys", "GET", undefined], ["/api/me/api-keys", "POST", { name: "Escalation", scope: "WRITE" }],
      ["/api/me", "DELETE", { confirm: "DELETE" }], ["/api/me", "PATCH", { displayName: "Changed" }],
      ["/api/me/email", "POST", { email: uniqueEmail() }], ["/api/auth/logout", "POST", {}],
    ] as const) {
      expect((await call(path, { method, body, cookie, headers: bearer(key) })).status, path).toBe(403);
    }
    expect((await call("/api/me", { cookie })).status).toBe(200);
  });

  it("revocation is immediate and only the issuing account can revoke", async () => {
    const owner = await signIn(uniqueEmail());
    const other = await signIn(uniqueEmail());
    const key = await issue(owner);
    expect((await call(`/api/me/api-keys/${key.id}`, { method: "DELETE", cookie: other })).status).toBe(404);
    expect((await call("/api/me", { headers: bearer(key) })).status).toBe(200);
    expect((await call(`/api/me/api-keys/${key.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect((await call("/api/me", { headers: bearer(key) })).status).toBe(401);
    expect(await (await call("/api/me/api-keys", { cookie: owner })).json()).toEqual([]);
  });

  it("expired keys and invalid authorization never fall back to cookies", async () => {
    const cookie = await signIn(uniqueEmail());
    const key = await issue(cookie);
    await testEnv.DB.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, key.id).run();
    for (const authorization of [`Bearer ${key.token}`, "Bearer invalid", "Basic garbage", "Bearer"]) {
      expect((await call("/api/me", { cookie, headers: { authorization } })).status).toBe(401);
    }
  });

  it("preserves membership checks and does not weaken cookie CSRF protection", async () => {
    const owner = await signIn(uniqueEmail());
    const view = await group(owner);
    const stranger = await issue(await signIn(uniqueEmail()), "WRITE");
    expect((await call(`/api/projects/${view.project.id}`, { headers: bearer(stranger) })).status).toBe(404);
    expect((await call("/api/projects", { cookie: owner, origin: null, body: {} })).status).toBe(403);
    expect((await call("/api/me/api-keys", { cookie: owner, origin: "https://evil.example", body: { name: "Bad" } })).status).toBe(403);
  });

  it("account deletion also removes its API keys", async () => {
    const cookie = await signIn(uniqueEmail());
    const key = await issue(cookie);
    expect((await call("/api/me", { method: "DELETE", cookie, body: { confirm: "DELETE" } })).status).toBe(200);
    expect((await call("/api/me", { headers: bearer(key) })).status).toBe(401);
    expect(await testEnv.DB.prepare("SELECT id FROM api_keys WHERE id = ?").bind(key.id).first()).toBeNull();
  });

  it("requires a signed-in account and validates key names and scope", async () => {
    expect((await call("/api/me/api-keys", { body: { name: "Script" } })).status).toBe(401);
    const cookie = await signIn(uniqueEmail());
    for (const body of [{ name: "" }, { name: "x".repeat(81) }, { name: "Script", scope: "ADMIN" }]) {
      expect((await call("/api/me/api-keys", { cookie, body })).status).toBe(422);
    }
    const res = await call("/api/me/api-keys", { cookie, body: { name: "Default" } });
    expect(res.status).toBe(201);
    expect((await res.json<Key>()).scope).toBe("READ");
  });

  it("guests cannot create or list API keys", async () => {
    const guest = await createGuest(testEnv.DB);
    const { token } = await createSession(testEnv.DB, guest);
    const cookie = `sd_session=${token}`;
    expect((await call("/api/me/api-keys", { cookie })).status).toBe(403);
    expect((await call("/api/me/api-keys", { cookie, body: { name: "Guest key" } })).status).toBe(403);
  });

  it("enforces the active-key cap under concurrent creation and allows replacement after revocation", async () => {
    const cookie = await signIn(uniqueEmail());
    const results = await Promise.all(Array.from({ length: 22 }, (_, index) => call("/api/me/api-keys", {
      cookie, body: { name: `Script ${index}` },
    })));
    expect(results.filter((res) => res.status === 201)).toHaveLength(20);
    expect(results.filter((res) => res.status === 422)).toHaveLength(2);
    const key = await results.find((res) => res.status === 201)!.json<Key>();
    expect((await call(`/api/me/api-keys/${key.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await call("/api/me/api-keys", { cookie, body: { name: "Replacement" } })).status).toBe(201);
  });

  it("a write key creates a group without Origin and retries do not duplicate it", async () => {
    const cookie = await signIn(uniqueEmail());
    const key = await issue(cookie, "WRITE");
    const init = { origin: null, headers: bearer(key), idempotencyKey: crypto.randomUUID(),
      body: { name: "Script group", baseCurrency: "PLN", ownerDisplayName: "Ann" } };
    const first = await call("/api/projects", init);
    const retry = await call("/api/projects", init);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect((await first.json<ProjectViewDTO>()).project.id).toBe((await retry.json<ProjectViewDTO>()).project.id);
    expect(await (await call("/api/projects", { headers: bearer(key) })).json()).toHaveLength(1);
  });
});

it("publishes an unauthenticated OpenAPI schema with bearer security and real expense fields", async () => {
  const res = await call("/api/openapi.json");
  expect(res.status).toBe(200);
  const doc = await res.json<{ openapi: string; paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { properties: Record<string, unknown> } }> }; security: unknown[] }>>; components: { securitySchemes: Record<string, unknown> } }>();
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
  const expense = doc.paths["/api/projects/{projectId}/rounds/{roundId}/entries"]?.post;
  expect(expense?.security).toEqual([{ bearerAuth: [] }]);
  expect(expense?.requestBody?.content["application/json"]?.schema.properties).toHaveProperty("originalAmount");
  expect(doc.paths).not.toHaveProperty("/api/me/api-keys");
});

it("serves the guide to text-only clients without authentication", async () => {
  const res = await call("/api/docs");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  const guide = await res.text();
  expect(guide).toContain("http://localhost/api/openapi.json");
  expect(guide).toContain("Authorization: Bearer");
});
