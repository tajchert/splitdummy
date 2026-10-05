import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeletionPreviewDTO,
  EntryDTO,
  FreezeResultDTO,
  HistoryDTO,
  InvitationDTO,
  JoinResultDTO,
  MeDTO,
  MemberDTO,
  ProjectSummaryDTO,
  ProjectViewDTO,
  ReviewDTO,
  RoundDTO,
} from "@shared/api";
import type { OutboxMessage } from "../../worker/do/types";
import { processMessage } from "../../worker/queue/consumer";
import { call, mockTurnstile, signIn, testEnv, uniqueEmail } from "./helpers";

beforeEach(() => {
  mockTurnstile();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const me = async (cookie: string) => json<MeDTO>(await call("/api/me", { cookie }));

async function createGroup(cookie: string, name: string, ownerDisplayName: string): Promise<ProjectViewDTO> {
  return json<ProjectViewDTO>(await call("/api/projects", { cookie, body: { name, baseCurrency: "PLN", ownerDisplayName } }), 201);
}

/** Joins with `cookie` (or as a newly signed-in account when null); returns the member ID and the session cookie. */
async function join(owner: string, projectId: string, displayName: string, cookie: string | null) {
  cookie ??= await signIn(uniqueEmail(displayName.toLowerCase()));
  const invite = await json<InvitationDTO>(await call(`/api/projects/${projectId}/invitations`, { method: "POST", cookie: owner }), 201);
  const token = decodeURIComponent(new URL(invite.url ?? "").hash.slice(1));
  const res = await call("/api/invitations/join", { cookie, body: { token, displayName } });
  const joined = await json<JoinResultDTO>(res);
  return { memberId: joined.memberId, cookie };
}

const view = async (cookie: string, projectId: string) => json<ProjectViewDTO>(await call(`/api/projects/${projectId}`, { cookie }));
const preview = async (cookie: string) => json<DeletionPreviewDTO>(await call("/api/me/deletion-preview", { cookie }));
const deleteAccount = (cookie: string, body: unknown = { confirm: "DELETE" }, env?: Env) =>
  call("/api/me", { method: "DELETE", cookie, body, env });
const count = async (query: string, ...args: string[]) =>
  (await testEnv.DB.prepare(query).bind(...args).first<{ n: number }>())?.n ?? 0;

async function freeze(cookie: string, projectId: string, roundId: string): Promise<FreezeResultDTO> {
  const review = await json<ReviewDTO>(await call(`/api/projects/${projectId}/rounds/${roundId}/review`, { cookie }));
  return json<FreezeResultDTO>(
    await call(`/api/projects/${projectId}/rounds/${roundId}/freeze`, {
      cookie,
      body: { expectedReviewVersion: review.reviewVersion, acknowledgeNotReady: review.notReadyMemberIds },
    }),
  );
}

describe("PATCH /api/me", () => {
  it("sets and clears the account name without renaming group memberships", async () => {
    const cookie = await signIn(uniqueEmail("name"));
    const group = await createGroup(cookie, "Trip", "Ann");
    expect((await call("/api/me", { method: "PATCH", body: { displayName: "X" } })).status).toBe(401);
    expect((await call("/api/me", { method: "PATCH", cookie, body: { displayName: "X" }, origin: "https://evil.example" })).status).toBe(403);
    const bad = await call("/api/me", { method: "PATCH", cookie, body: { displayName: "   " } });
    expect(bad.status).toBe(422);

    const updated = await json<MeDTO>(await call("/api/me", { method: "PATCH", cookie, body: { displayName: "  Ann Smith " } }));
    expect(updated).toMatchObject({ kind: "ACCOUNT", displayName: "Ann Smith" });
    expect((await me(cookie)).displayName).toBe("Ann Smith");
    expect((await view(cookie, group.project.id)).members[0]?.displayName).toBe("Ann");

    const cleared = await json<MeDTO>(await call("/api/me", { method: "PATCH", cookie, body: { displayName: null } }));
    expect(cleared.displayName).toBeNull();
  });
});

describe("group rename and freeze schedule over HTTP", () => {
  it("renames self in one group and schedules the freeze", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const group = await createGroup(owner, "Trip", "Ann");
    const projectId = group.project.id;
    const bob = await join(owner, projectId, "Bob", null);

    const renamed = await json<MemberDTO>(await call(`/api/projects/${projectId}/members/me`, { method: "PATCH", cookie: bob.cookie, body: { displayName: "Bobby" } }));
    expect(renamed).toMatchObject({ id: bob.memberId, displayName: "Bobby", accountDeleted: false });
    const history = await json<HistoryDTO>(await call(`/api/projects/${projectId}/history`, { cookie: owner }));
    expect(history.events[0]).toMatchObject({ action: "MEMBER_RENAMED", summary: "Bob renamed themselves to Bobby" });

    const path = `/api/projects/${projectId}/rounds/${group.current.round.id}/freeze-schedule`;
    expect((await call(path, { method: "PUT", cookie: bob.cookie, body: { date: "2099-12-24", timeZone: "Europe/Warsaw" } })).status).toBe(403);
    const round = await json<RoundDTO>(await call(path, { method: "PUT", cookie: owner, body: { date: "2099-12-24", timeZone: "Europe/Warsaw" } }));
    expect(round).toMatchObject({ scheduledFreezeDate: "2099-12-24", scheduledFreezeAt: "2099-12-24T23:00:00.000Z", frozenBySchedule: false });
    const past = await call(path, { method: "PUT", cookie: owner, body: { date: "2001-01-01", timeZone: "Europe/Warsaw" } });
    expect(past.status).toBe(422);
    expect((await past.json<{ error: { field: string } }>()).error.field).toBe("date");
  });
});

describe("account deletion", () => {
  it("previews, blocks on unconfirmed transfers, then deletes owned groups and anonymizes joined ones", async () => {
    const ann = await signIn(uniqueEmail("ann"));
    const bob = await signIn(uniqueEmail("bob"));
    const annId = (await me(ann)).principalId;
    const owned = await createGroup(ann, "Ann's trip", "Ann");
    const ownedId = owned.project.id;
    const bobInOwned = await join(ann, ownedId, "Bob", bob);
    const guest = await join(ann, ownedId, "Gus", null);
    const joined = await createGroup(bob, "Bob's flat", "Bob");
    const joinedId = joined.project.id;
    const roundId = joined.current.round.id;
    const annInJoined = await join(bob, joinedId, "Ann", ann);
    await testEnv.BACKUPS.put(`projects/${ownedId}/2026-10-01T00:00:00.000Z.json`, "{}");
    await testEnv.BACKUPS.put(`projects/${joinedId}/2026-10-01T00:00:00.000Z.json`, "{}");
    await testEnv.ATTACHMENTS.put(`projects/${ownedId}/attachments/att_owned`, "x");
    await testEnv.ATTACHMENTS.put(`projects/${joinedId}/attachments/att_joined`, "y");

    expect(await preview(ann)).toEqual({
      ownedProjects: [{ id: ownedId, name: "Ann's trip", memberCount: 3 }],
      memberProjects: [{ id: joinedId, name: "Bob's flat" }],
      blockingProjects: [],
    });

    // Bob pays for both and freezes: Ann now owes Bob, which blocks deleting her account.
    await json<EntryDTO>(
      await call(`/api/projects/${joinedId}/rounds/${roundId}/entries`, {
        cookie: bob,
        body: {
          type: "EXPENSE",
          description: "Rent",
          occurredAt: "2026-10-01",
          originalAmount: "20000",
          originalCurrency: "PLN",
          conversion: { method: "IDENTITY" },
          payerMemberId: joined.me.memberId,
          splitMode: "EQUAL",
          participants: [{ memberId: joined.me.memberId }, { memberId: annInJoined.memberId }],
        },
      }),
      201,
    );
    const frozen = await freeze(bob, joinedId, roundId);
    expect((await preview(ann)).blockingProjects).toEqual([{ id: joinedId, name: "Bob's flat" }]);
    const blocked = await deleteAccount(ann);
    expect(blocked.status).toBe(409);
    expect((await blocked.json<{ error: { code: string; details: unknown } }>()).error).toMatchObject({
      code: "ACCOUNT_HAS_OPEN_TRANSFERS",
      details: { projects: [{ id: joinedId, name: "Bob's flat" }] },
    });
    expect((await view(ann, ownedId)).project.id).toBe(ownedId);
    expect((await view(bob, joinedId)).members.find((m) => m.id === annInJoined.memberId)?.accountDeleted).toBe(false);

    const transfer = frozen.instructions[0]!;
    await json(await call(`/api/projects/${joinedId}/rounds/${roundId}/instructions/${transfer.id}/sent`, { cookie: ann, body: {} }));
    await json(await call(`/api/projects/${joinedId}/rounds/${roundId}/instructions/${transfer.id}/received`, { cookie: bob, body: {} }));
    expect((await preview(ann)).blockingProjects).toEqual([]);

    expect((await deleteAccount(ann, {})).status).toBe(422);
    const res = await deleteAccount(ann);
    expect(await json(res)).toEqual({ ok: true });
    expect(res.headers.getSetCookie().some((c) => /sd_session=;/.test(c) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c))).toBe(true);

    // Ann is gone: session, sign-in tokens, principal, directory rows.
    expect((await call("/api/me", { cookie: ann })).status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE principal_id = ?", annId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM principals WHERE id = ?", annId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM project_directory WHERE principal_id = ?", annId)).toBe(0);

    // Her group is gone for everyone (DO, directory rows of all members, backups).
    expect((await call(`/api/projects/${ownedId}`, { cookie: bob })).status).toBe(404);
    expect((await call(`/api/projects/${ownedId}`, { cookie: guest.cookie })).status).toBe(404);
    expect(await count("SELECT COUNT(*) AS n FROM project_directory WHERE project_id = ?", ownedId)).toBe(0);
    const bobGroups = await json<ProjectSummaryDTO[]>(await call("/api/projects", { cookie: bob }));
    expect(bobGroups.map((g) => g.id)).toEqual([joinedId]);
    expect((await testEnv.BACKUPS.list({ prefix: `projects/${ownedId}/` })).objects).toHaveLength(0);
    expect((await testEnv.BACKUPS.list({ prefix: `projects/${joinedId}/` })).objects).toHaveLength(1);
    expect((await testEnv.ATTACHMENTS.list({ prefix: `projects/${ownedId}/` })).objects).toHaveLength(0);
    expect((await testEnv.ATTACHMENTS.list({ prefix: `projects/${joinedId}/` })).objects).toHaveLength(1);
    expect(bobInOwned.memberId).toMatch(/^m_/);

    // The joined group keeps her as an anonymous member with all money references intact.
    const after = await view(bob, joinedId);
    expect(after.members.find((m) => m.id === annInJoined.memberId)).toMatchObject({
      displayName: "Deleted account",
      accountDeleted: true,
      referenced: true,
    });
    const round = after.rounds.find((r) => r.id === roundId)!;
    expect(round.status).toBe("SETTLED");
    const roundView = await json<{ instructions: { fromMemberId: string; state: string }[]; balances: { memberId: string; net: string }[] }>(
      await call(`/api/projects/${joinedId}/rounds/${roundId}`, { cookie: bob }),
    );
    expect(roundView.instructions).toEqual([expect.objectContaining({ fromMemberId: annInJoined.memberId, state: "CONFIRMED" })]);
    expect(roundView.balances.find((b) => b.memberId === annInJoined.memberId)?.net).toBe("-10000");
    const history = await json<HistoryDTO>(await call(`/api/projects/${joinedId}/history`, { cookie: bob }));
    expect(history.events[0]).toMatchObject({ action: "MEMBER_ACCOUNT_DELETED", summary: "A member deleted their account" });

    // Late outbox deliveries can't bring rows back for the deleted group or the deleted account.
    const late = (projectId: string, principalId: string): OutboxMessage => ({
      id: `ev_${crypto.randomUUID()}`,
      type: "DIRECTORY_UPSERT",
      projectId,
      projectVersion: 999,
      payload: {
        name: "late",
        baseCurrency: "PLN",
        roundStatus: "COLLECTING",
        roundSequence: 1,
        members: [{ principalId, memberId: "m_x", isOwner: false, status: "ACTIVE", nextAction: null }],
      },
    });
    await processMessage(testEnv, late(ownedId, (await me(bob)).principalId));
    await processMessage(testEnv, late(joinedId, annId));
    expect(await count("SELECT COUNT(*) AS n FROM project_directory WHERE project_id = ?", ownedId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM project_directory WHERE principal_id = ?", annId)).toBe(0);
  });

  it("blocks collecting expenses before deleting any owned groups", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const bob = await signIn(uniqueEmail("bob"));
    const owned = await createGroup(bob, "Bob's group", "Bob");
    const joined = await createGroup(owner, "Trip", "Alice");
    const member = await join(owner, joined.project.id, "Bob", bob);
    await json(await call(`/api/projects/${joined.project.id}/rounds/${joined.current.round.id}/entries`, {
      cookie: owner,
      body: { type: "EXPENSE", description: "Dinner", occurredAt: "2026-10-01", originalAmount: "1000", originalCurrency: "PLN", conversion: { method: "IDENTITY" }, payerMemberId: joined.me.memberId, splitMode: "EQUAL", participants: [{ memberId: joined.me.memberId }, { memberId: member.memberId }] },
    }), 201);
    expect((await preview(bob)).blockingProjects).toEqual([{ id: joined.project.id, name: "Trip" }]);
    expect((await deleteAccount(bob)).status).toBe(409);
    expect((await view(bob, owned.project.id)).project.id).toBe(owned.project.id);
    expect((await me(bob)).principalId).toBeTruthy();
  });

  it("anonymizes removed memberships through account deletion", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const bob = await signIn(uniqueEmail("bob"));
    const group = await createGroup(owner, "Trip", "Alice");
    const member = await join(owner, group.project.id, "Bob", bob);
    await json(await call(`/api/projects/${group.project.id}/members/${member.memberId}`, { method: "DELETE", cookie: owner }));
    expect(await json(await deleteAccount(bob))).toEqual({ ok: true });
    const after = await view(owner, group.project.id);
    expect(after.members.find((m) => m.id === member.memberId)).toMatchObject({ displayName: "Deleted account", accountDeleted: true });
    const events = await json<HistoryDTO>(await call(`/api/projects/${group.project.id}/history`, { cookie: owner }));
    expect(JSON.stringify(events)).not.toContain("Bob");
  });

  it("is safe to retry after failing midway", async () => {
    const ann = await signIn(uniqueEmail("ann"));
    const owned = await createGroup(ann, "Trip", "Ann");
    const ownedId = owned.project.id;
    const gus = await join(ann, ownedId, "Gus", null);
    await testEnv.BACKUPS.put(`projects/${ownedId}/a.json`, "{}");

    // R2 is down right after the DO was wiped.
    const broken = {
      ...testEnv,
      BACKUPS: { list: async () => { throw new Error("r2 down"); }, delete: async () => undefined },
    } as unknown as Env;
    expect((await deleteAccount(ann, undefined, broken)).status).toBe(500);
    expect((await call(`/api/projects/${ownedId}`, { cookie: gus.cookie })).status).toBe(404);
    expect((await me(ann)).principalId).toBeTruthy();

    const retry = await deleteAccount(ann);
    expect(await json(retry)).toEqual({ ok: true });
    expect(await count("SELECT COUNT(*) AS n FROM project_directory WHERE project_id = ?", ownedId)).toBe(0);
    expect((await testEnv.BACKUPS.list({ prefix: `projects/${ownedId}/` })).objects).toHaveLength(0);
    expect((await call("/api/me", { cookie: ann })).status).toBe(401);
  });

  it("lets a joined member delete themselves; requires a session", async () => {
    expect((await call("/api/me", { method: "DELETE", body: { confirm: "DELETE" } })).status).toBe(401);
    expect((await call("/api/me/deletion-preview")).status).toBe(401);
    const owner = await signIn(uniqueEmail("owner"));
    const group = await createGroup(owner, "Trip", "Ann");
    const gus = await join(owner, group.project.id, "Gus", null);
    expect(await preview(gus.cookie)).toEqual({
      ownedProjects: [],
      memberProjects: [{ id: group.project.id, name: "Trip" }],
      blockingProjects: [],
    });
    expect(await json(await deleteAccount(gus.cookie))).toEqual({ ok: true });
    expect((await call("/api/me", { cookie: gus.cookie })).status).toBe(401);
    const after = await view(owner, group.project.id);
    expect(after.members.find((m) => m.id === gus.memberId)).toMatchObject({ displayName: "Deleted account", accountDeleted: true, status: "LEFT" });
    expect(after.current.readiness.map((r) => r.memberId)).not.toContain(gus.memberId);
  });
});
