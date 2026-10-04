import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDO } from "../../worker/do/ProjectDO";
import { PRINCIPAL_HEADER } from "../../worker/do/types";
import { call, mockTurnstile, signIn, uniqueEmail } from "./helpers";

const P = `p_${"d".repeat(32)}`;
const ws = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };
let seen: Request[];
let originalFetch: unknown;

beforeEach(() => {
  mockTurnstile();
  seen = [];
  const proto = ProjectDO.prototype as unknown as { fetch?: (req: Request) => Promise<Response> };
  originalFetch = proto.fetch;
  proto.fetch = async (req: Request) => {
    seen.push(req);
    return new Response("upgraded", { status: 200 });
  };
});
afterEach(() => {
  (ProjectDO.prototype as unknown as { fetch?: unknown }).fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("GET /api/projects/:id/live", () => {
  it("forwards an authenticated upgrade with an edge-set principal header and no cookie", async () => {
    const cookie = await signIn(uniqueEmail("ws"));
    const res = await call(`/api/projects/${P}/live`, {
      cookie,
      headers: { ...ws, origin: "http://localhost", [PRINCIPAL_HEADER]: JSON.stringify({ principalId: "pr_forged", kind: "ACCOUNT" }) },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const forwarded = seen[0];
    const principal = JSON.parse(forwarded?.headers.get(PRINCIPAL_HEADER) ?? "{}");
    expect(principal.principalId).not.toBe("pr_forged");
    expect(principal).toMatchObject({ kind: "ACCOUNT", hasRecoverableAccount: true });
    expect(forwarded?.headers.get("cookie")).toBeNull();
    expect(forwarded?.headers.get("upgrade")).toBe("websocket");
  });

  it("rejects upgrades without a session (401)", async () => {
    const res = await call(`/api/projects/${P}/live`, { headers: { ...ws, origin: "http://localhost" } });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("rejects cross-origin upgrades (403)", async () => {
    const cookie = await signIn(uniqueEmail("ws"));
    for (const origin of ["https://evil.example", undefined]) {
      const headers: Record<string, string> = { ...ws };
      if (origin) headers.origin = origin;
      const res = await call(`/api/projects/${P}/live`, { cookie, headers });
      expect(res.status).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it("requires an Upgrade header (426)", async () => {
    const cookie = await signIn(uniqueEmail("ws"));
    const res = await call(`/api/projects/${P}/live`, { cookie, headers: { origin: "http://localhost" } });
    expect(res.status).toBe(426);
  });

  it("404 for malformed project IDs", async () => {
    const cookie = await signIn(uniqueEmail("ws"));
    const res = await call(`/api/projects/p_nope/live`, { cookie, headers: { ...ws, origin: "http://localhost" } });
    expect(res.status).toBe(404);
  });
});
