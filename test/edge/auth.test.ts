import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../worker/lib/crypto";
import type { SignInRequestedDTO, SignInVerifiedDTO } from "@shared/api";
import {
  call,
  guestSession,
  mockProjectDO,
  mockTurnstile,
  sessionCookie,
  signIn,
  testEnv,
  tokenFromLink,
  uniqueEmail,
  verifyToken,
} from "./helpers";

beforeEach(() => {
  mockTurnstile();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function requestLink(email: string, extra: Record<string, unknown> = {}, cookie?: string) {
  const res = await call("/api/auth/email", { body: { email, turnstileToken: "ok", ...extra }, cookie });
  expect(res.status).toBe(200);
  const body = await res.json<SignInRequestedDTO>();
  expect(body.sent).toBe(true);
  return { link: body.devLink ?? "", token: tokenFromLink(body.devLink ?? "") };
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json<{ error: { code: string } }>()).error.code;
}

describe("magic-link sign-in", () => {
  it("links to the SPA confirm page with the token in the fragment, storing only its hash", async () => {
    const email = uniqueEmail();
    const { link, token } = await requestLink(email);
    expect(link).toMatch(/^http:\/\/localhost\/auth\/confirm#token=[A-Za-z0-9_-]{43}$/);
    const raw = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sign_in_tokens WHERE token_hash = ?").bind(token).first<{ n: number }>();
    expect(raw?.n).toBe(0);
    const hashed = await testEnv.DB.prepare("SELECT email, purpose FROM sign_in_tokens WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .first<{ email: string; purpose: string }>();
    expect(hashed).toEqual({ email, purpose: "SIGN_IN" });
  });

  it("POST /api/auth/verify creates an ACCOUNT, sets a session cookie and returns next", async () => {
    const email = uniqueEmail();
    const { token } = await requestLink(email, { next: "/projects/p_1?tab=history" });
    const res = await verifyToken(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json<SignInVerifiedDTO>()).toEqual({ next: "/projects/p_1?tab=history" });
    const cookie = sessionCookie(res);
    expect(cookie).not.toBeNull();

    const me = await call("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ kind: "ACCOUNT", email, displayName: null });
  });

  it("returns /groups when no next was given", async () => {
    const { token } = await requestLink(uniqueEmail());
    expect(await (await verifyToken(token)).json<SignInVerifiedDTO>()).toEqual({ next: "/groups" });
  });

  it("legacy GET links only redirect to the confirm page and consume nothing (scanner-safe)", async () => {
    const { token } = await requestLink(uniqueEmail());
    for (let i = 0; i < 3; i++) {
      const res = await call(`/api/auth/verify?token=${token}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/auth/confirm#token=${token}`);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(sessionCookie(res)).toBeNull();
    }
    const consumed = await testEnv.DB.prepare("SELECT consumed_at FROM sign_in_tokens WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .first<{ consumed_at: number | null }>();
    expect(consumed?.consumed_at).toBeNull();
    expect((await verifyToken(token)).status).toBe(200);
  });

  it("legacy GET without a token goes to the sign-in page", async () => {
    const res = await call("/api/auth/verify");
    expect(res.headers.get("location")).toBe("/signin?error=invalid");
  });

  it("POST verify is origin-checked", async () => {
    const { token } = await requestLink(uniqueEmail());
    expect((await verifyToken(token, { origin: "https://evil.example" })).status).toBe(403);
    expect((await verifyToken(token, { origin: null })).status).toBe(403);
    // Rejected requests don't burn the token.
    expect((await verifyToken(token)).status).toBe(200);
  });

  it("cookie is HttpOnly, SameSite=Lax, Path=/ and __Host-/Secure over HTTPS", async () => {
    const { token } = await requestLink(uniqueEmail());
    const res = await verifyToken(token, { base: "https://localhost" });
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-sd_session="));
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/; HttpOnly/i);
    expect(setCookie).toMatch(/; Secure/i);
    expect(setCookie).toMatch(/; SameSite=Lax/i);
    expect(setCookie).toMatch(/; Path=\//i);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it("tokens are single-use (410 SIGNIN_LINK_INVALID)", async () => {
    const { token } = await requestLink(uniqueEmail());
    expect((await verifyToken(token)).status).toBe(200);
    const again = await verifyToken(token);
    expect(again.status).toBe(410);
    expect(await errorCode(again)).toBe("SIGNIN_LINK_INVALID");
    expect(sessionCookie(again)).toBeNull();
  });

  it("concurrent verification of one token yields exactly one session", async () => {
    const { token } = await requestLink(uniqueEmail());
    const results = await Promise.all([verifyToken(token), verifyToken(token), verifyToken(token)]);
    expect(results.filter((r) => sessionCookie(r) !== null)).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410, 410]);
  });

  it("expired tokens are rejected", async () => {
    const { token } = await requestLink(uniqueEmail());
    await testEnv.DB.prepare("UPDATE sign_in_tokens SET expires_at = ? WHERE token_hash = ?")
      .bind(Date.now() - 1, await sha256Hex(token))
      .run();
    const res = await verifyToken(token);
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe("SIGNIN_LINK_INVALID");
  });

  it("garbage tokens are rejected; a missing token is a 422", async () => {
    expect((await verifyToken("nope")).status).toBe(410);
    expect((await call("/api/auth/verify", { body: {} })).status).toBe(422);
  });

  it("never sends the browser off-site, even with backslash tricks", async () => {
    const { token } = await requestLink(uniqueEmail(), { next: "/\\evil.example" });
    expect(await (await verifyToken(token)).json<SignInVerifiedDTO>()).toEqual({ next: "/groups" });
  });

  it("returns no devLink on staging", async () => {
    vi.restoreAllMocks();
    mockTurnstile("localhost");
    const staging = { ...testEnv, ENVIRONMENT: "staging" } as unknown as Env;
    const res = await call("/api/auth/email", { body: { email: uniqueEmail(), turnstileToken: "ok" }, env: staging });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
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
    expect(out.headers.get("clear-site-data")).toBe('"cache"');
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
    const g = await guestSession();
    // Legacy guests were members of a group, which is what the upgrade notifies.
    const projectId = `p_${crypto.randomUUID().replace(/-/g, "")}`;
    await testEnv.DB.prepare(
      "INSERT INTO project_directory (principal_id, project_id, member_id, status, name, base_currency, project_version, updated_at) VALUES (?, ?, 'm_g', 'ACTIVE', 'Trip', 'PLN', 2, ?)",
    )
      .bind(g.principalId, projectId, new Date().toISOString())
      .run();
    return { cookie: g.cookie, principalId: g.principalId };
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
    const { devLink } = await res.json<SignInRequestedDTO>();
    const verify = await verifyToken(tokenFromLink(devLink ?? ""));
    const cookie = sessionCookie(verify);
    const me = await (await call("/api/me", { cookie })).json<{ principalId: string; kind: string; email: string }>();
    expect(me).toMatchObject({ principalId: guest.principalId, kind: "ACCOUNT", email });
  });

  it("attaching an email that already has an account keeps the guest session unchanged", async () => {
    const email = uniqueEmail("taken");
    await signIn(email);
    const guest = await joinAsGuest();
    const res = await call("/api/me/email", { body: { email, turnstileToken: "ok" }, cookie: guest.cookie });
    const { devLink } = await res.json<SignInRequestedDTO>();
    const verify = await verifyToken(tokenFromLink(devLink ?? ""), { cookie: guest.cookie });
    expect(await verify.json()).toEqual({ next: "/groups?error=email_in_use" });
    expect(sessionCookie(verify)).toBeNull();
    const me = await (await call("/api/me", { cookie: guest.cookie })).json<{ kind: string }>();
    expect(me.kind).toBe("GUEST");
  });

  it("a link requested by someone else never attaches their email to the guest who clicks it", async () => {
    const guest = await joinAsGuest();
    const attackerEmail = uniqueEmail("attacker");
    const { token } = await requestLink(attackerEmail); // requested without the guest's session
    await verifyToken(token, { cookie: guest.cookie });
    const row = await testEnv.DB.prepare("SELECT kind, email FROM principals WHERE id = ?").bind(guest.principalId).first();
    expect(row).toEqual({ kind: "GUEST", email: null });
  });

  it("accounts cannot attach another email", async () => {
    const cookie = await signIn(uniqueEmail());
    const res = await call("/api/me/email", { body: { email: uniqueEmail(), turnstileToken: "ok" }, cookie });
    expect(res.status).toBe(409);
  });
});
