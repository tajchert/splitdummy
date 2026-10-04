import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { InvitationPreviewDTO, MemberDTO, ProjectDTO } from "@shared/api";
import { PRINCIPAL_HEADER } from "../../worker/do/types";
import { Client, createGroup, errorCode, expense, freezeNow, inviteToken, joinGroup, makePrincipal, stubFor } from "./helpers";

describe("project creation", () => {
  it("creates a single-currency project with round 1 collecting (criterion 1)", async () => {
    const g = await createGroup({ members: 0 });
    const view = await g.owner.view();
    expect(view.project.multiCurrencyEnabled).toBe(false);
    expect(view.project.baseCurrency).toBe("PLN");
    expect(view.project.baseExponent).toBe(2);
    expect(view.project.baseCurrencyLocked).toBe(false);
    expect(view.current.round.status).toBe("COLLECTING");
    expect(view.current.round.sequence).toBe(1);
    expect(view.me.isOwner).toBe(true);
    expect(view.members).toHaveLength(1);
    expect(view.invitations).toEqual([]);
  });

  it("rejects unrecoverable owners, unknown currencies and a second create", async () => {
    const projectId = `p_${crypto.randomUUID()}`;
    const guest = new Client(stubFor(projectId), projectId, makePrincipal({ recoverable: false }));
    const body = { projectId, name: "X", baseCurrency: "PLN", ownerDisplayName: "G" };
    expect((await errorCode(guest.call("createProject", {}, body))).status).toBe(403);

    const owner = new Client(stubFor(projectId), projectId, makePrincipal());
    expect(await errorCode(owner.call("createProject", {}, { ...body, baseCurrency: "XXX" }))).toMatchObject({
      status: 422,
      field: "baseCurrency",
    });
    expect(await errorCode(owner.call("createProject", {}, { ...body, name: "" }))).toMatchObject({ status: 422, field: "name" });
    await owner.ok("createProject", {}, body);
    expect((await errorCode(owner.call("createProject", {}, body))).code).toBe("INVALID_TRANSITION");
  });

  it("hides the project from non-members and unauthenticated callers", async () => {
    const g = await createGroup({ members: 0 });
    const stranger = new Client(g.stub, g.projectId, makePrincipal());
    expect(await errorCode(stranger.call("getProject", {}, null, null))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect((await errorCode(stranger.call("createEntry", { roundId: g.roundId }, expense("x", ["x"], "100")))).status).toBe(404);
    const anon = new Client(g.stub, g.projectId, null);
    expect((await errorCode(anon.call("getProject", {}, null, null))).status).toBe(401);
    // Empty DO: 404, never created implicitly.
    const empty = new Client(stubFor(`p_${crypto.randomUUID()}`), "nope", makePrincipal());
    expect((await errorCode(empty.call("getProject", {}, null, null))).status).toBe(404);
  });

  it("requires idempotency keys on mutations", async () => {
    const g = await createGroup({ members: 0 });
    expect((await errorCode(g.owner.call("setReadiness", { roundId: g.roundId }, { ready: true }, null))).status).toBe(422);
  });
});

describe("invitations and joining", () => {
  it("previews, joins as a distinct member and returns the same member on re-join", async () => {
    const g = await createGroup({ members: 0 });
    const token = await inviteToken(g);
    expect(token.startsWith(`${g.projectId}.`)).toBe(true);

    const anon = new Client(g.stub, g.projectId, null);
    const preview = await anon.ok<InvitationPreviewDTO>("previewInvite", { tokenSecret: token }, null, null);
    expect(preview).toEqual({ projectName: "Trip", baseCurrency: "PLN", status: "OPEN", alreadyMemberProjectId: null });

    const p1 = new Client(g.stub, g.projectId, makePrincipal({ recoverable: false }));
    const p2 = new Client(g.stub, g.projectId, makePrincipal({ recoverable: false }));
    const a = await p1.ok("join", { tokenSecret: token }, { displayName: "Alice" }); // same name as owner
    const b = await p2.ok("join", { tokenSecret: token }, { displayName: "Alice" });
    expect(a.memberId).not.toBe(b.memberId);
    expect(a.memberId).not.toBe(g.owner.memberId);
    const again = await p1.ok("join", { tokenSecret: token }, { displayName: "Someone else" });
    expect(again.memberId).toBe(a.memberId);

    const view = await g.owner.view();
    expect(view.members.filter((m) => m.displayName === "Alice")).toHaveLength(3);
    expect(view.members.find((m) => m.id === a.memberId)).toMatchObject({ isGuest: true, isOwner: false });
    const previewMember = await p1.ok<InvitationPreviewDTO>("previewInvite", { tokenSecret: token }, null, null);
    expect(previewMember.alreadyMemberProjectId).toBe(g.projectId);
  });

  it("rejects bad, revoked and wrong-project tokens; only owners manage invites", async () => {
    const g = await createGroup({ members: 1 });
    const bob = g.members[0]!;
    const token = await inviteToken(g);
    const anon = new Client(g.stub, g.projectId, makePrincipal({ recoverable: false }));
    expect((await errorCode(anon.call("previewInvite", { tokenSecret: `${g.projectId}.bogus` }, null, null))).code).toBe("INVITE_INVALID");
    expect((await errorCode(anon.call("join", { tokenSecret: `other.${token.split(".")[1]}` }, { displayName: "X" }))).code).toBe(
      "INVITE_INVALID",
    );
    expect((await errorCode(bob.call("createInvite"))).status).toBe(403);

    const invites = (await g.owner.view()).invitations!;
    expect(invites.length).toBeGreaterThan(0);
    expect(invites.every((i) => i.url === undefined)).toBe(true);
    expect((await bob.view()).invitations).toBeNull();
    for (const inv of invites) await g.owner.ok("revokeInvite", { inviteId: inv.id });
    const preview = await anon.ok<InvitationPreviewDTO>("previewInvite", { tokenSecret: token }, null, null);
    expect(preview.status).toBe("REVOKED");
    expect(await errorCode(anon.call("join", { tokenSecret: token }, { displayName: "X" }))).toMatchObject({
      status: 409,
      code: "INVITE_INVALID",
    });
  });

  it("clears everyone's readiness on join and blocks joining while settling", async () => {
    const g = await createGroup({ members: 1 });
    const bob = g.members[0]!;
    await g.owner.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    await bob.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    const carol = await joinGroup(g, "Carol");
    const view = await g.owner.view();
    expect(view.current.readiness.every((r) => !r.ready)).toBe(true);
    expect(view.current.readiness.map((r) => r.memberId)).toContain(carol.memberId);

    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, bob.memberId], "1000"));
    const token = await inviteToken(g);
    await freezeNow(g);
    const dave = new Client(g.stub, g.projectId, makePrincipal({ recoverable: false }));
    expect((await dave.ok<InvitationPreviewDTO>("previewInvite", { tokenSecret: token }, null, null)).status).toBe("MEMBERSHIP_FROZEN");
    expect(await errorCode(dave.call("join", { tokenSecret: token }, { displayName: "Dave" }))).toMatchObject({
      status: 409,
      code: "ROUND_NOT_COLLECTING",
    });
    // An existing member re-joining still just gets their identity back.
    expect((await bob.ok("join", { tokenSecret: token }, { displayName: "Bob" })).memberId).toBe(bob.memberId);
  });
});

describe("invitation expiry and limits", () => {
  it("reports expired invitations and enforces the member cap before mutating", async () => {
    const g = await createGroup({ members: 0 });
    const token = await inviteToken(g);
    const anon = new Client(g.stub, g.projectId, makePrincipal({ recoverable: false }));
    await runInDurableObject(g.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE invitations SET expires_at = '2000-01-01T00:00:00.000Z'");
    });
    expect((await anon.ok<InvitationPreviewDTO>("previewInvite", { tokenSecret: token }, null, null)).status).toBe("EXPIRED");
    expect(await errorCode(anon.call("join", { tokenSecret: token }, { displayName: "Late" }))).toMatchObject({
      status: 409,
      code: "INVITE_INVALID",
      details: { status: "EXPIRED" },
    });

    const fresh = await inviteToken(g);
    await runInDurableObject(g.stub, (_i, state) => {
      for (let i = 0; i < 49; i++) {
        state.storage.sql.exec(
          "INSERT INTO members (id, principal_id, display_name, is_guest, has_recoverable_account, joined_at, status) VALUES (?, ?, 'X', 1, 0, '2026-01-01', 'ACTIVE')",
          `m_fill_${i}`,
          `pr_fill_${i}`,
        );
      }
    });
    expect(await errorCode(anon.call("join", { tokenSecret: fresh }, { displayName: "One too many" }))).toMatchObject({
      status: 429,
      code: "LIMIT_EXCEEDED",
    });
    expect((await g.owner.view()).members).toHaveLength(50);
  });
});

describe("membership changes (criterion 22)", () => {
  it("removes only unreferenced members, and only the owner can", async () => {
    const g = await createGroup({ members: 2 });
    const [bob, carol] = g.members as [Client, Client];
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, bob.memberId], "1000"));
    expect((await errorCode(bob.call("removeMember", { memberId: carol.memberId }))).status).toBe(403);
    expect(await errorCode(g.owner.call("removeMember", { memberId: bob.memberId }))).toMatchObject({
      status: 409,
      code: "MEMBER_REFERENCED",
    });
    expect((await errorCode(g.owner.call("removeMember", { memberId: g.owner.memberId }))).status).toBe(409);
    const removed = await g.owner.ok<MemberDTO>("removeMember", { memberId: carol.memberId });
    expect(removed.status).toBe("REMOVED");
    // Removed members lose access entirely and cannot be named in entries.
    expect((await errorCode(carol.call("getProject", {}, null, null))).status).toBe(404);
    expect(
      await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [carol.memberId], "100"))),
    ).toMatchObject({ status: 422, field: "participants.0.memberId" });
    const view = await g.owner.view();
    expect(view.members.find((m) => m.id === bob.memberId)).toMatchObject({ referenced: true, status: "ACTIVE" });
  });

  it("lets referenced members leave while keeping their identity and obligations", async () => {
    const g = await createGroup({ members: 1 });
    const bob = g.members[0]!;
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, bob.memberId], "1000"));
    const left = await bob.ok<MemberDTO>("leave");
    expect(left).toMatchObject({ status: "LEFT", referenced: true });
    const view = await bob.view(); // still readable
    expect(view.current.balances.find((b) => b.memberId === bob.memberId)?.net).toBe("-500");
    expect(view.current.readiness.map((r) => r.memberId)).not.toContain(bob.memberId);
    expect((await errorCode(g.owner.call("leave"))).code).toBe("INVALID_TRANSITION");
  });

  it("transfers ownership only to a recoverable member who accepts", async () => {
    const g = await createGroup({ members: 2, guests: true });
    const [guest, other] = g.members as [Client, Client];
    expect(await errorCode(g.owner.call("transferOwnership", {}, { toMemberId: guest.memberId }))).toMatchObject({
      status: 422,
      field: "toMemberId",
    });
    expect((await errorCode(guest.call("transferOwnership", {}, { toMemberId: other.memberId }))).status).toBe(403);

    // The guest attaches a verified email; edge notifies the DO.
    const upgraded = { ...guest.principal!, kind: "ACCOUNT" as const, email: "g@example.com", hasRecoverableAccount: true };
    await new Client(g.stub, g.projectId, null).ok("principalUpdated", {}, upgraded, null);
    await g.owner.ok("setReadiness", { roundId: g.roundId }, { ready: true });

    const offered = await g.owner.ok<ProjectDTO>("transferOwnership", {}, { toMemberId: guest.memberId });
    expect(offered.pendingOwnerMemberId).toBe(guest.memberId);
    expect(offered.ownerMemberId).toBe(g.owner.memberId);
    expect((await errorCode(other.call("acceptOwnership"))).code).toBe("INVALID_TRANSITION");

    const accepted = await guest.ok<ProjectDTO>("acceptOwnership");
    expect(accepted.ownerMemberId).toBe(guest.memberId);
    expect(accepted.pendingOwnerMemberId).toBeNull();
    const view = await guest.view();
    expect(view.members.filter((m) => m.isOwner).map((m) => m.id)).toEqual([guest.memberId]);
    expect(view.current.readiness.every((r) => !r.ready)).toBe(true);
    expect(view.invitations).not.toBeNull();
    expect((await errorCode(g.owner.call("createInvite"))).status).toBe(403);
  });
});

describe("live updates", () => {
  it("rejects non-members and broadcasts changes after commits", async () => {
    const g = await createGroup({ members: 1 });
    const upgrade = (p: unknown) =>
      g.stub.fetch("https://do/live", {
        headers: { Upgrade: "websocket", [PRINCIPAL_HEADER]: JSON.stringify(p) },
      });
    expect((await upgrade(makePrincipal())).status).toBe(404);
    expect((await g.stub.fetch("https://do/live")).status).toBe(426);

    const res = await upgrade(g.members[0]!.principal);
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const messages: any[] = [];
    ws.accept();
    ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string)));
    await g.owner.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    await vi_waitFor(() => messages.length >= 2);
    expect(messages[0]).toMatchObject({ type: "hello" });
    expect(messages[1]).toMatchObject({ type: "changed", reason: "setReadiness", roundId: g.roundId });
    expect(messages[1].projectVersion).toBeGreaterThan(messages[0].projectVersion);
    ws.close();
  });
});

async function vi_waitFor(cond: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
