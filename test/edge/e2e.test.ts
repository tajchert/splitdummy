import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EntryDTO,
  FreezeResultDTO,
  InstructionResultDTO,
  InvitationDTO,
  JoinResultDTO,
  ProjectSummaryDTO,
  ProjectViewDTO,
  ReviewDTO,
} from "@shared/api";
import { projectStub } from "../../worker/lib/project";
import { call, guestSession, mockTurnstile, signIn, testEnv, uniqueEmail } from "./helpers";

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

/** Full lifecycle through the HTTP routes against the real ProjectDO. */
describe("end to end: create → invite → join → expense → ready → freeze → settle", () => {
  it("settles a two-person group", async () => {
    const owner = await signIn(uniqueEmail("owner"));

    const created = await json<ProjectViewDTO>(
      await call("/api/projects", {
        cookie: owner,
        body: { name: "Weekend", baseCurrency: "PLN", ownerDisplayName: "Ann", turnstileToken: "ok" },
      }),
      201,
    );
    const projectId = created.project.id;
    expect(projectId).toMatch(/^p_[0-9a-f]{32}$/);
    const roundId = created.current.round.id;
    const ownerMemberId = created.me.memberId;

    // "My groups" is filled synchronously.
    const ownerGroups = await json<ProjectSummaryDTO[]>(await call("/api/projects", { cookie: owner }));
    expect(ownerGroups).toEqual([expect.objectContaining({ id: projectId, isOwner: true, roundStatus: "COLLECTING" })]);

    const invite = await json<InvitationDTO>(await call(`/api/projects/${projectId}/invitations`, { method: "POST", cookie: owner }), 201);
    const token = decodeURIComponent(new URL(invite.url ?? "").hash.slice(1));
    expect(token.startsWith(`${projectId}.`)).toBe(true);

    const preview = await json<{ projectName: string; status: string }>(await call(`/api/invitations/${encodeURIComponent(token)}`));
    expect(preview).toMatchObject({ projectName: "Weekend", status: "OPEN" });

    const guest = await signIn(uniqueEmail("bob"));
    const joinRes = await call("/api/invitations/join", { cookie: guest, body: { token, displayName: "Bob" } });
    const joined = await json<JoinResultDTO>(joinRes);
    expect(joined.projectId).toBe(projectId);
    const guestMemberId = joined.memberId;
    const guestGroups = await json<ProjectSummaryDTO[]>(await call("/api/projects", { cookie: guest }));
    expect(guestGroups).toEqual([expect.objectContaining({ id: projectId, isOwner: false })]);

    // Non-members can't see the project.
    const stranger = await signIn(uniqueEmail("stranger"));
    expect((await call(`/api/projects/${projectId}`, { cookie: stranger })).status).toBe(404);

    const entry = await json<EntryDTO>(
      await call(`/api/projects/${projectId}/rounds/${roundId}/entries`, {
        cookie: owner,
        body: {
          type: "EXPENSE",
          description: "Groceries",
          occurredAt: "2026-10-03",
          originalAmount: "10000",
          originalCurrency: "PLN",
          conversion: { method: "IDENTITY" },
          payerMemberId: ownerMemberId,
          splitMode: "EQUAL",
          participants: [{ memberId: ownerMemberId }, { memberId: guestMemberId }],
        },
      }),
      201,
    );
    expect(entry.baseAmount).toBe("10000");

    for (const cookie of [owner, guest]) {
      await json(await call(`/api/projects/${projectId}/rounds/${roundId}/readiness/me`, { method: "PUT", cookie, body: { ready: true } }));
    }

    const review = await json<ReviewDTO>(await call(`/api/projects/${projectId}/rounds/${roundId}/review`, { cookie: owner }));
    expect(review.notReadyMemberIds).toEqual([]);
    expect(review.proposedTransfers).toEqual([{ fromMemberId: guestMemberId, toMemberId: ownerMemberId, amount: "5000" }]);

    // Participants can't freeze.
    expect(
      (await call(`/api/projects/${projectId}/rounds/${roundId}/freeze`, { cookie: guest, body: { expectedReviewVersion: review.reviewVersion } })).status,
    ).toBe(403);

    const frozen = await json<FreezeResultDTO>(
      await call(`/api/projects/${projectId}/rounds/${roundId}/freeze`, { cookie: owner, body: { expectedReviewVersion: review.reviewVersion } }),
    );
    expect(frozen.round.status).toBe("SETTLING");
    const [instruction] = frozen.instructions;
    expect(instruction).toMatchObject({ fromMemberId: guestMemberId, toMemberId: ownerMemberId, amount: "5000", state: "PROPOSED" });
    const base = `/api/projects/${projectId}/rounds/${roundId}/instructions/${instruction?.id}`;

    // Only the recipient may confirm; only the sender may mark sent.
    expect((await call(`${base}/sent`, { cookie: owner, body: {} })).status).toBe(403);
    const sent = await json<InstructionResultDTO>(await call(`${base}/sent`, { cookie: guest, body: {} }));
    expect(sent.instruction.state).toBe("SENT");
    const received = await json<InstructionResultDTO>(await call(`${base}/received`, { cookie: owner, body: {} }));
    expect(received.instruction.state).toBe("CONFIRMED");
    expect(received.round.status).toBe("SETTLED");

    const view = await json<ProjectViewDTO>(await call(`/api/projects/${projectId}`, { cookie: guest }));
    expect(view.current.round.status).toBe("SETTLED");

    const csv = await call(`/api/projects/${projectId}/export`, { cookie: owner });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/attachment/);
    expect(await csv.text()).toContain("Groceries");

    // Outbox → queue → directory projection: flush the DO alarm, then wait for the consumer.
    await runDurableObjectAlarm(projectStub(testEnv, projectId));
    await expect
      .poll(
        async () => (await json<ProjectSummaryDTO[]>(await call("/api/projects", { cookie: owner })))[0]?.roundStatus,
        { timeout: 10_000, interval: 200 },
      )
      .toBe("SETTLED");
  });

  it("a legacy guest member becomes recoverable after signing in", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const created = await json<ProjectViewDTO>(
      await call("/api/projects", { cookie: owner, body: { name: "Flat", baseCurrency: "EUR", ownerDisplayName: "Ann", turnstileToken: "ok" } }),
      201,
    );
    const projectId = created.project.id;
    const invite = await json<InvitationDTO>(await call(`/api/projects/${projectId}/invitations`, { method: "POST", cookie: owner }), 201);
    const token = new URL(invite.url ?? "").hash.slice(1);
    const g = await guestSession();
    const guest = g.cookie;
    const joinRes = await projectStub(testEnv, projectId).handle({
      op: "join",
      principal: { principalId: g.principalId, kind: "GUEST", email: null, hasRecoverableAccount: false },
      params: { projectId, tokenSecret: token },
      body: { displayName: "Bob" },
      idempotencyKey: crypto.randomUUID(),
      requestId: "req_test",
    });
    const { memberId } = (joinRes as unknown as { body: JoinResultDTO }).body;
    await testEnv.DB.prepare(
      "INSERT INTO project_directory (principal_id, project_id, member_id, status, name, base_currency, project_version, updated_at) VALUES (?, ?, ?, 'ACTIVE', 'Flat', 'EUR', 0, ?)",
    )
      .bind(g.principalId, projectId, memberId, new Date().toISOString())
      .run();

    const memberOf = async () =>
      (await json<ProjectViewDTO>(await call(`/api/projects/${projectId}`, { cookie: owner }))).members.find((m) => m.id === memberId);
    expect(await memberOf()).toMatchObject({ isGuest: true, hasRecoverableAccount: false });

    await signIn(uniqueEmail("bob"), guest);
    await expect.poll(async () => (await memberOf())?.hasRecoverableAccount, { timeout: 5_000 }).toBe(true);
  });

  it("members get a live socket with hello; non-members are refused", async () => {
    const owner = await signIn(uniqueEmail("owner"));
    const created = await json<ProjectViewDTO>(
      await call("/api/projects", { cookie: owner, body: { name: "Live", baseCurrency: "EUR", ownerDisplayName: "Ann", turnstileToken: "ok" } }),
      201,
    );
    const ws = { upgrade: "websocket", origin: "http://localhost" };
    const res = await call(`/api/projects/${created.project.id}/live`, { cookie: owner, headers: ws });
    expect(res.status).toBe(101);
    const socket = res.webSocket;
    if (!socket) throw new Error("no socket");
    const first = new Promise<string>((resolve) => socket.addEventListener("message", (e) => resolve(String(e.data))));
    socket.accept();
    expect(JSON.parse(await first)).toEqual({ type: "hello", projectVersion: created.project.version });
    socket.close(1000, "done");

    const stranger = await signIn(uniqueEmail("stranger"));
    const refused = await call(`/api/projects/${created.project.id}/live`, { cookie: stranger, headers: ws });
    expect(refused.status).toBe(404);
    expect(refused.headers.get("cache-control")).toBe("no-store");
  });

  it("guests cannot create groups; the DO is never asked", async () => {
    const guest = (await guestSession()).cookie;
    const res = await call("/api/projects", { cookie: guest, body: { name: "Mine", baseCurrency: "EUR", ownerDisplayName: "Bob", turnstileToken: "ok" } });
    expect(res.status).toBe(403);
  });
});
