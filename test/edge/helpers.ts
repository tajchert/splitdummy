import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../../worker/index";
import { ProjectDO } from "../../worker/do/ProjectDO";
import type { DoRequest, DoResponse } from "../../worker/do/types";
import { createGuest } from "../../worker/auth/principals";
import { createSession, sessionCookieName } from "../../worker/auth/session";

export const ORIGIN = "http://localhost";
export const testEnv = env as Env;

export interface CallInit {
  method?: string;
  body?: unknown;
  cookie?: string | null;
  origin?: string | null;
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
  base?: string;
  env?: Env;
}

/** Calls the Worker's fetch in-process with sensible same-origin defaults. */
export async function call(path: string, init: CallInit = {}): Promise<Response> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", `10.0.${rand255()}.${rand255()}`);
  if (init.origin !== null && method !== "GET") headers.set("origin", init.origin ?? ORIGIN);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.idempotencyKey !== null && method !== "GET") {
    headers.set("idempotency-key", init.idempotencyKey ?? crypto.randomUUID());
  }
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    headers.set("content-type", "application/json");
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${init.base ?? ORIGIN}${path}`, { method, headers, body }), init.env ?? testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const rand255 = () => Math.floor(Math.random() * 255);

/** `name=value` pair from the response's session Set-Cookie, for use as a Cookie header. */
export function sessionCookie(res: Response): string | null {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0] ?? "";
    if (/^(__Host-)?sd_session=./.test(pair)) return pair;
  }
  return null;
}

/** Sign-in via magic link (devLink); returns the session cookie. */
export async function signIn(email: string, cookie?: string | null): Promise<string> {
  const res = await call("/api/auth/email", { body: { email, turnstileToken: "ok" }, cookie });
  if (res.status !== 200) throw new Error(`sign-in request failed: ${res.status} ${await res.text()}`);
  const { devLink } = await res.json<{ devLink: string }>();
  const verify = await verifyToken(tokenFromLink(devLink), { cookie });
  const sc = sessionCookie(verify);
  if (!sc) throw new Error(`verify failed: ${verify.status} ${await verify.text()}`);
  return sc;
}

/** Token from a `/auth/confirm#token=…` link. */
export function tokenFromLink(link: string): string {
  return new URLSearchParams(new URL(link).hash.slice(1)).get("token") ?? "";
}

/** What the SPA confirm page does: POST the fragment token. */
export function verifyToken(token: string, init: Omit<CallInit, "body"> = {}): Promise<Response> {
  return call("/api/auth/verify", { ...init, body: { token } });
}

export function uniqueEmail(tag = "user"): string {
  return `${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

/** Replaces ProjectDO.handle for the test; records every DoRequest. */
export function mockProjectDO(impl: (req: DoRequest) => DoResponse | Promise<DoResponse>) {
  const calls: DoRequest[] = [];
  const spy = vi.spyOn(ProjectDO.prototype, "handle").mockImplementation(async (req: DoRequest) => {
    calls.push(structuredClone(req));
    return impl(req);
  });
  return { calls, spy };
}

/** Turnstile siteverify stub: token "fail" fails, anything else passes. */
export function mockTurnstile(hostname = "example.com") {
  const original = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
      const form = init?.body as FormData;
      const ok = form.get("response") !== "fail";
      return Response.json(ok ? { success: true, hostname } : { success: false, "error-codes": ["invalid-input-response"] });
    }
    return original(input, init);
  });
}

export function projectView(projectId: string, memberId = "m_owner", version = 1) {
  return {
    project: { id: projectId, name: "Trip", baseCurrency: "PLN", version, ownerMemberId: memberId },
    me: { memberId, isOwner: true },
    current: { round: { id: "r_1", sequence: 1, status: "COLLECTING" } },
  };
}

/** An un-emailed guest session, as created before joins required a verified email. */
export async function guestSession(): Promise<{ cookie: string; principalId: string }> {
  const guest = await createGuest(testEnv.DB);
  const { token } = await createSession(testEnv.DB, guest);
  return { cookie: `${sessionCookieName(ORIGIN)}=${token}`, principalId: guest.id };
}
