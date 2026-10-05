import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentOf, isAllowedOrigin, isLocal } from "../../worker/lib/env";
import { call, mockProjectDO, mockTurnstile, signIn, uniqueEmail } from "./helpers";

const P = `p_${"ab".repeat(16)}`;
let cookie: string;

beforeEach(async () => {
  mockTurnstile();
  cookie = await signIn(uniqueEmail("sec"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("origin / CSRF", () => {
  it("rejects cookie-authenticated mutations without an Origin", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    const res = await call(`/api/projects/${P}/leave`, { method: "POST", cookie, origin: null });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("FORBIDDEN");
    expect(calls).toHaveLength(0);
  });

  it("rejects a foreign Origin", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    const res = await call(`/api/projects/${P}/leave`, { method: "POST", cookie, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("rejects cross-site logout and sign-in requests too", async () => {
    expect((await call("/api/auth/logout", { method: "POST", cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/me", { cookie })).status).toBe(200);
    expect((await call("/api/auth/email", { body: { email: uniqueEmail() }, origin: "https://evil.example" })).status).toBe(403);
  });

  it("allows any localhost port in test/dev", async () => {
    mockProjectDO(() => ({ status: 200, body: {} }));
    const res = await call(`/api/projects/${P}/leave`, { method: "POST", cookie, origin: "http://localhost:5173" });
    expect(res.status).toBe(200);
  });

  it("GETs don't need an Origin", async () => {
    mockProjectDO(() => ({ status: 200, body: {} }));
    expect((await call(`/api/projects/${P}`, { cookie })).status).toBe(200);
  });
});

describe("idempotency keys", () => {
  it("are required on DO mutations (422)", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    const res = await call(`/api/projects/${P}/rounds/r_1/readiness/me`, { method: "PUT", cookie, idempotencyKey: null, body: { ready: true } });
    expect(res.status).toBe(422);
    expect((await res.json<{ error: { field: string } }>()).error.field).toBe("Idempotency-Key");
    expect(calls).toHaveLength(0);
  });

  it("are required on create project and join", async () => {
    mockProjectDO(() => ({ status: 200, body: {} }));
    const create = await call("/api/projects", {
      cookie,
      idempotencyKey: null,
      body: { name: "Trip", baseCurrency: "PLN", ownerDisplayName: "Ann", turnstileToken: "ok" },
    });
    expect(create.status).toBe(422);
    const join = await call("/api/invitations/join", { idempotencyKey: null, body: { token: `${P}.${"x".repeat(43)}`, displayName: "Bo", turnstileToken: "ok" } });
    expect(join.status).toBe(422);
  });

  it("reject malformed keys", async () => {
    mockProjectDO(() => ({ status: 200, body: {} }));
    const res = await call(`/api/projects/${P}/leave`, { method: "POST", cookie, idempotencyKey: "short" });
    expect(res.status).toBe(422);
  });
});

describe("body limits", () => {
  it("rejects oversized JSON bodies with 413 before reaching the DO", async () => {
    const { calls } = mockProjectDO(() => ({ status: 200, body: {} }));
    const res = await call(`/api/projects/${P}/rounds/r_1/entries`, { cookie, body: JSON.stringify({ pad: "x".repeat(70_000) }) });
    expect(res.status).toBe(413);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("LIMIT_EXCEEDED");
    expect(calls).toHaveLength(0);
  });

  it("rejects invalid JSON with 422", async () => {
    mockProjectDO(() => ({ status: 200, body: {} }));
    const res = await call(`/api/projects/${P}/rounds/r_1/entries`, { cookie, body: "{nope" });
    expect(res.status).toBe(422);
  });
});

describe("caching", () => {
  it("marks private responses no-store", async () => {
    mockProjectDO(() => ({ status: 200, body: {} }));
    for (const path of [`/api/projects/${P}`, "/api/projects", "/api/me"]) {
      const res = await call(path, { cookie });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const unauth = await call("/api/me");
    expect(unauth.headers.get("cache-control")).toBe("no-store");
  });
});

describe("environment", () => {
  const envOf = (ENVIRONMENT: string | undefined) => ({ ENVIRONMENT, APP_ORIGIN: "https://splitdummy.example" }) as unknown as Env;

  it("only enables local-dev behaviour when explicitly asked for", () => {
    expect(isLocal(envOf("development"))).toBe(true);
    expect(isLocal(envOf("test"))).toBe(true);
    expect(isLocal(envOf("staging"))).toBe(false);
  });

  it("treats a missing or mistyped ENVIRONMENT as production", () => {
    for (const value of [undefined, "", "prod", "Development", "dev"]) {
      expect(environmentOf(envOf(value))).toBe("production");
      expect(isLocal(envOf(value))).toBe(false);
      expect(isAllowedOrigin(envOf(value), "http://localhost:5173")).toBe(false);
    }
  });
});
