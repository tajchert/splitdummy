import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddMemberResultDTO, JoinResultDTO, MeDTO, MemberInvitePreviewDTO, ProjectSummaryDTO, ProjectViewDTO } from "@shared/api";
import { call, mockTurnstile, sessionCookie, signIn, uniqueEmail } from "./helpers";

beforeEach(() => {
  mockTurnstile();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function group(owner: string): Promise<ProjectViewDTO> {
  return json<ProjectViewDTO>(await call("/api/projects", { cookie: owner, body: { name: "Trip", baseCurrency: "PLN", ownerDisplayName: "Ann" } }), 201);
}

const tokenOf = (devLink: string) => decodeURIComponent(new URL(devLink).hash.slice(1));

describe("owner member routes", () => {
  it("adds a placeholder with an email, sends the invite, and a replay sends nothing", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const g = await group(owner);
    const path = `/api/projects/${g.project.id}/members`;
    const first = await json<AddMemberResultDTO>(await call(path, { cookie: owner, body: { displayName: "Zoe", email: "zoe@example.com" }, idempotencyKey: "add-zoe-1" }), 201);
    expect(first).toMatchObject({ displayName: "Zoe", kind: "PLACEHOLDER", inviteState: "INVITED", emailSent: true });
    expect(first.devLink).toMatch(/^http:\/\/localhost\/invite#p_[0-9a-f]{32}\./);
    const replay = await json<AddMemberResultDTO>(await call(path, { cookie: owner, body: { displayName: "Zoe", email: "zoe@example.com" }, idempotencyKey: "add-zoe-1" }), 201);
    expect(replay).toMatchObject({ id: first.id, emailSent: null });
    expect(replay.devLink).toBeUndefined();

    const plain = await json<AddMemberResultDTO>(await call(path, { cookie: owner, body: { displayName: "Kid" } }), 201);
    expect(plain.emailSent).toBeNull();
  });

  it("renames, resends and cancels through the generic routes", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const g = await group(owner);
    const added = await json<AddMemberResultDTO>(await call(`/api/projects/${g.project.id}/members`, { cookie: owner, body: { displayName: "Zoe" } }), 201);
    const base = `/api/projects/${g.project.id}/members/${added.id}`;
    expect((await json<{ displayName: string }>(await call(`${base}/name`, { method: "PATCH", cookie: owner, body: { displayName: "Zoë" } }))).displayName).toBe("Zoë");
    const invited = await json<AddMemberResultDTO>(await call(`${base}/invite`, { cookie: owner, body: { email: "z@example.com" } }));
    expect(invited).toMatchObject({ inviteState: "INVITED", emailSent: true });
    expect((await json<{ inviteState: null }>(await call(`${base}/invite`, { method: "DELETE", cookie: owner }))).inviteState).toBeNull();
  });
});

describe("accepting an email invite", () => {
  it("previews without the email, then signs in as the invited address and claims the spot", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const g = await group(owner);
    const zoeEmail = uniqueEmail("zoe");
    const added = await json<AddMemberResultDTO>(await call(`/api/projects/${g.project.id}/members`, { cookie: owner, body: { displayName: "Zoe", email: zoeEmail } }), 201);
    const token = tokenOf(added.devLink!);

    const preview = await json<MemberInvitePreviewDTO & Record<string, unknown>>(await call(`/api/member-invites/${encodeURIComponent(token)}`));
    expect(preview).toEqual({ projectName: "Trip", baseCurrency: "PLN", displayName: "Zoe", status: "OPEN", canRename: true, alreadyMemberProjectId: null });

    // A different person is signed in on this browser; accepting switches to Zoe's account.
    const someoneElse = await signIn(uniqueEmail("other"));
    const res = await call("/api/member-invites/accept", { cookie: someoneElse, body: { token, displayName: "Zoe K" } });
    const joined = await json<JoinResultDTO>(res);
    expect(joined).toEqual({ projectId: g.project.id, memberId: added.id });
    const cookie = sessionCookie(res)!;
    expect(cookie).toBeTruthy();
    expect((await json<MeDTO>(await call("/api/me", { cookie }))).email).toBe(zoeEmail);
    expect((await call("/api/me", { cookie: someoneElse })).status).toBe(401);
    const groups = await json<ProjectSummaryDTO[]>(await call("/api/projects", { cookie }));
    expect(groups).toEqual([expect.objectContaining({ id: g.project.id, isOwner: false })]);

    // Single use.
    const again = await call("/api/member-invites/accept", { body: { token } });
    expect(again.status).toBe(409);
    expect(sessionCookie(again)).toBeNull();
  });

  it("an expired-or-unknown link creates no account and no session", async () => {
    const res = await call("/api/member-invites/accept", { body: { token: `p_${"a".repeat(32)}.${"S".repeat(43)}` } });
    expect(res.status).toBe(404);
    expect(sessionCookie(res)).toBeNull();
  });
});
