import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../worker/lib/crypto";
import { call, mockProjectDO, mockTurnstile, sessionCookie, signIn, testEnv, uniqueEmail } from "./helpers";

beforeEach(() => {
  mockTurnstile();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function requestLink(email: string, extra: Record<string, unknown> = {}, cookie?: string) {
  const res = await call("/api/auth/email", { body: { email, turnstileToken: "ok", ...extra }, cookie });
  expect(res.status).toBe(200);
  const body = await res.json<{ sent: true; devLink: string }>();
  expect(body.sent).toBe(true);
  const url = new URL(body.devLink);
  return { path: url.pathname + url.search, token: url.searchParams.get("token") ?? "" };
}

describe("magic-link sign-in", () => {
  it("returns a devLink outside production and stores only the token hash", async () => {
    const email = uniqueEmail();
    const { path, token } = await requestLink(email);
    expect(path).toMatch(/^\/api\/auth\/verify\?token=/);
    const raw = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sign_in_tokens WHERE token_hash = ?").bind(token).first<{ n: number }>();
    expect(raw?.n).toBe(0);
    const hashed = await testEnv.DB.prepare("SELECT email, purpose FROM sign_in_tokens WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .first<{ email: string; purpose: string }>();
    expect(hashed).toEqual({ email, purpose: "SIGN_IN" });
  });

  it("verify creates an ACCOUNT, sets a session cookie and redirects to next", async () => {
    const email = uniqueEmail();
    const { path } = await requestLink(email, { next: "/projects/p_1?tab=history" });
    const res = await call(path);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/projects/p_1?tab=history");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = sessionCookie(res);
    expect(cookie).not.toBeNull();

    const me = await call("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ kind: "ACCOUNT", email, displayName: null });
  });

  it("cookie is HttpOnly, SameSite=Lax, Path=/ and __Host-/Secure over HTTPS", async () => {
    const { path } = await requestLink(uniqueEmail());
    const res = await call(path, { base: "https://localhost" });
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-sd_session="));
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/; HttpOnly/i);
    expect(setCookie).toMatch(/; Secure/i);
    expect(setCookie).toMatch(/; SameSite=Lax/i);
    expect(setCookie).toMatch(/; Path=\//i);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it("tokens are single-use", async () => {
    const { path } = await requestLink(uniqueEmail());
    expect((await call(path)).status).toBe(303);
    const again = await call(path);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/signin?error=link_invalid");
    expect(sessionCookie(again)).toBeNull();
  });

  it("concurrent verification of one token yields exactly one session", async () => {
    const { path } = await requestLink(uniqueEmail());
    const results = await Promise.all([call(path), call(path), call(path)]);
    expect(results.filter((r) => sessionCookie(r) !== null)).toHaveLength(1);
  });

  it("expired tokens are rejected", async () => {
    const { path, token } = await requestLink(uniqueEmail());
    await testEnv.DB.prepare("UPDATE sign_in_tokens SET expires_at = ? WHERE token_hash = ?")
      .bind(Date.now() - 1, await sha256Hex(token))
      .run();
    const res = await call(path);
    expect(res.headers.get("location")).toBe("/signin?error=link_invalid");
  });

  it("garbage tokens are rejected", async () => {
    const res = await call("/api/auth/verify?token=nope");
    expect(res.headers.get("location")).toBe("/signin?error=link_invalid");
  });

  it("never redirects off-site, even with backslash tricks", async () => {
    const { path } = await requestLink(uniqueEmail(), { next: "/\\evil.example" });
    const res = await call(path);
    expect(res.headers.get("location")).toBe("/");
  });

  it("rejects protocol-relative next at validation", async () => {
    const res = await call("/api/auth/email", { body: { email: uniqueEmail(), next: "//evil.example" } });
    expect(res.status).toBe(422);
    expect((await res.json<{ error: { code: string; field: string } }>()).error).toMatchObject({ code: "VALIDATION", field: "next" });
  });

  it("signing in again finds the same account", async () => {
    const email = uniqueEmail();
    const a = await (await call("/api/me", { cookie: await signIn(email) })).json<{ principalId: string }>();
    const b = await (await call("/api/me", { cookie: await signIn(email) })).json<{ principalId: string }>();
    expect(a.principalId).toBe(b.principalId);
  });

  it("fails Turnstile with 403 TURNSTILE_FAILED", async () => {
    const res = await call("/api/auth/email", { body: { email: uniqueEmail(), turnstileToken: "fail" } });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("TURNSTILE_FAILED");
  });

  it("requires a Turnstile token when a secret is configured", async () => {
    const res = await call("/api/auth/email", { body: { email: uniqueEmail() } });
    expect(res.status).toBe(403);
  });

  it("rate-limits repeated requests for one email", async () => {
    const email = uniqueEmail("rl");
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await call("/api/auth/email", { body: { email, turnstileToken: "ok" } })).status);
    }
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
  });
});

describe("sessions", () => {
  it("/api/me without a session is 401", async () => {
    const res = await call("/api/me");
    expect(res.status).toBe(401);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("UNAUTHENTICATED");
  });

  it("logout revokes the session in D1", async () => {
    const cookie = await signIn(uniqueEmail());
    const out = await call("/api/auth/logout", { method: "POST", cookie });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().join()).toMatch(/sd_session=;/);
    expect((await call("/api/me", { cookie })).status).toBe(401);
  });

  it("a session revoked directly in D1 stops working immediately", async () => {
    const cookie = await signIn(uniqueEmail());
    const token = cookie.split("=")[1] ?? "";
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").bind(Date.now(), await sha256Hex(token)).run();
    expect((await call("/api/me", { cookie })).status).toBe(401);
  });

  it("an expired session is rejected", async () => {
    const cookie = await signIn(uniqueEmail());
    const token = cookie.split("=")[1] ?? "";
    await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(Date.now() - 1, await sha256Hex(token)).run();
    expect((await call("/api/me", { cookie })).status).toBe(401);
  });

  it("the session table stores hashes, not raw tokens", async () => {
    const cookie = await signIn(uniqueEmail());
    const token = cookie.split("=")[1] ?? "";
    const raw = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?").bind(token).first<{ n: number }>();
    expect(raw?.n).toBe(0);
  });
});

describe("guest upgrade", () => {
  async function joinAsGuest(): Promise<{ cookie: string; principalId: string }> {
    mockProjectDO((req) =>
      req.op === "join"
        ? { status: 200, body: { projectId: req.params.projectId } }
        : { status: 200, body: { project: { id: req.params.projectId, name: "Trip", baseCurrency: "PLN", version: 2 }, me: { memberId: "m_g", isOwner: false }, current: { round: { status: "COLLECTING", sequence: 1 } } } },
    );
    const projectId = `p_${crypto.randomUUID().replace(/-/g, "")}`;
    const res = await call("/api/invitations/join", { body: { token: `${projectId}.${"s".repeat(43)}`, displayName: "Guest", turnstileToken: "ok" } });
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    if (!cookie) throw new Error("no guest cookie");
    const me = await (await call("/api/me", { cookie })).json<{ principalId: string; kind: string }>();
    expect(me.kind).toBe("GUEST");
    return { cookie, principalId: me.principalId };
  }

  it("sign-in from an un-emailed guest session upgrades that principal in place and notifies its DOs", async () => {
    const guest = await joinAsGuest();
    vi.restoreAllMocks();
    mockTurnstile();
    const { calls } = mockProjectDO(() => ({ status: 200, body: { ok: true } }));
    const email = uniqueEmail("guest");
    const cookie = await signIn(email, guest.cookie);
    const me = await (await call("/api/me", { cookie })).json<{ principalId: string; kind: string; email: string }>();
    expect(me).toMatchObject({ principalId: guest.principalId, kind: "ACCOUNT", email });
    const updated = calls.filter((c) => c.op === "principalUpdated");
    expect(updated).toHaveLength(1);
    expect(updated[0]?.body).toEqual({ principalId: guest.principalId, kind: "ACCOUNT", email, hasRecoverableAccount: true });
    // The old guest session was rotated out.
    expect((await call("/api/me", { cookie: guest.cookie })).status).toBe(401);
  });

  it("POST /api/me/email attaches a verified email to the guest", async () => {
    const guest = await joinAsGuest();
    const email = uniqueEmail("attach");
    const res = await call("/api/me/email", { body: { email, turnstileToken: "ok" }, cookie: guest.cookie });
    expect(res.status).toBe(200);
    const { devLink } = await res.json<{ devLink: string }>();
    const verify = await call(new URL(devLink).pathname + new URL(devLink).search);
    const cookie = sessionCookie(verify);
    const me = await (await call("/api/me", { cookie })).json<{ principalId: string; kind: string; email: string }>();
    expect(me).toMatchObject({ principalId: guest.principalId, kind: "ACCOUNT", email });
  });

  it("attaching an email that already has an account keeps the guest session unchanged", async () => {
    const email = uniqueEmail("taken");
    await signIn(email);
    const guest = await joinAsGuest();
    const res = await call("/api/me/email", { body: { email, turnstileToken: "ok" }, cookie: guest.cookie });
    const { devLink } = await res.json<{ devLink: string }>();
    const verify = await call(new URL(devLink).pathname + new URL(devLink).search, { cookie: guest.cookie });
    expect(verify.headers.get("location")).toBe("/?error=email_in_use");
    expect(sessionCookie(verify)).toBeNull();
    const me = await (await call("/api/me", { cookie: guest.cookie })).json<{ kind: string }>();
    expect(me.kind).toBe("GUEST");
  });

  it("a link requested by someone else never attaches their email to the guest who clicks it", async () => {
    const guest = await joinAsGuest();
    const attackerEmail = uniqueEmail("attacker");
    const { path } = await requestLink(attackerEmail); // requested without the guest's session
    await call(path, { cookie: guest.cookie });
    const row = await testEnv.DB.prepare("SELECT kind, email FROM principals WHERE id = ?").bind(guest.principalId).first();
    expect(row).toEqual({ kind: "GUEST", email: null });
  });

  it("accounts cannot attach another email", async () => {
    const cookie = await signIn(uniqueEmail());
    const res = await call("/api/me/email", { body: { email: uniqueEmail(), turnstileToken: "ok" }, cookie });
    expect(res.status).toBe(409);
  });
});
