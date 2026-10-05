import { describe, expect, it } from "vitest";
import type { JoinResultDTO, MemberDTO, MemberInvitePreviewDTO, ProjectDTO } from "@shared/api";
import { runInDurableObject } from "cloudflare:test";
import type { Principal } from "../../worker/do/types";
import { Client, createGroup, errorCode, expense, freezeNow, makePrincipal } from "./helpers";

describe("member contract defaults", () => {
  it("existing members are PERSONs without invites; renaming is allowed by default", async () => {
    const g = await createGroup({ members: 1 });
    const view = await g.owner.view();
    expect(view.project.membersCanRename).toBe(true);
    for (const m of view.members) {
      expect(m).toMatchObject({ kind: "PERSON", inviteState: null, inviteExpiresAt: null, invitedEmail: null });
    }
    const bobView = await g.members[0]!.view();
    expect("invitedEmail" in bobView.members[0]!).toBe(false);
  });
});

describe("placeholders", () => {
  it("owner adds a named placeholder usable in expenses but absent from readiness", async () => {
    const g = await createGroup({ members: 1 });
    const added = await g.owner.ok<MemberDTO>("addMember", {}, { displayName: "Zoe" });
    expect(added).toMatchObject({ displayName: "Zoe", kind: "PLACEHOLDER", inviteState: null, isOwner: false, status: "ACTIVE" });
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(added.id, [added.id, g.owner.memberId], "1000"));
    const view = await g.owner.view();
    expect(view.current.readiness.map((r) => r.memberId)).not.toContain(added.id);
    expect(view.current.balances.find((b) => b.memberId === added.id)?.net).toBe("500");
    const history = await g.owner.ok("getHistory", {}, null, null);
    expect(history.events.some((e: { action: string }) => e.action === "MEMBER_ADDED")).toBe(true);
  });

  it("only the owner adds people, and not while settling", async () => {
    const g = await createGroup({ members: 1 });
    expect((await errorCode(g.members[0]!.call("addMember", {}, { displayName: "X" }))).status).toBe(403);
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, g.members[0]!.memberId], "1000"));
    await freezeNow(g);
    expect((await errorCode(g.owner.call("addMember", {}, { displayName: "X" }))).code).toBe("ROUND_NOT_COLLECTING");
  });

  it("an unreferenced placeholder can be removed", async () => {
    const g = await createGroup({ members: 0 });
    const zoe = await g.owner.ok<MemberDTO>("addMember", {}, { displayName: "Zoe" });
    const removed = await g.owner.ok<MemberDTO>("removeMember", { memberId: zoe.id });
    expect(removed.status).toBe("REMOVED");
  });
});

describe("renaming", () => {
  it("owner renames anyone, audited with byMemberId", async () => {
    const g = await createGroup({ members: 1 });
    const bob = g.members[0]!;
    const renamed = await g.owner.ok<MemberDTO>("renameMember", { memberId: bob.memberId }, { displayName: "Robert" });
    expect(renamed.displayName).toBe("Robert");
    const history = await g.owner.ok("getHistory", {}, null, null);
    expect(history.events[0]).toMatchObject({ action: "MEMBER_RENAMED", details: { from: "Bob", to: "Robert", byMemberId: g.owner.memberId } });
    expect((await errorCode(bob.call("renameMember", { memberId: g.owner.memberId }, { displayName: "X" }))).status).toBe(403);
  });

  it("owner can lock self-renaming; the owner can still rename themselves", async () => {
    const g = await createGroup({ members: 1 });
    const bob = g.members[0]!;
    const before = await g.owner.view();
    const p = await g.owner.ok<ProjectDTO>("updateSettings", {}, { expectedVersion: before.project.version, membersCanRename: false });
    expect(p.membersCanRename).toBe(false);
    expect(await errorCode(bob.call("renameMe", {}, { displayName: "Bobby" }))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    await g.owner.ok("renameMe", {}, { displayName: "Alicia" });
    const history = await g.owner.ok("getHistory", {}, null, null);
    expect(history.events.some((e: { action: string }) => e.action === "MEMBER_RENAME_POLICY_CHANGED")).toBe(true);
  });
});

/** Adds a placeholder with an email invite; returns it plus the token from the mailed URL. */
async function invite(g: Awaited<ReturnType<typeof createGroup>>, displayName: string, email: string) {
  const res = await g.owner.call("addMember", {}, { displayName, email });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const url = res.transient!.inviteMail!.url;
  return { member: res.body as MemberDTO, token: url.split("#")[1]!, res };
}

const accountFor = (email: string): Principal => ({ ...makePrincipal(), email });

describe("email invites", () => {
  it("issues a 7-day invite; the URL travels only in transient and is never stored", async () => {
    const g = await createGroup({ members: 0 });
    const { member, token, res } = await invite(g, "Zoe", "Zoe@Example.com");
    expect(member).toMatchObject({ kind: "PLACEHOLDER", inviteState: "INVITED", invitedEmail: "zoe@example.com" });
    const days = (Date.parse(member.inviteExpiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    expect(res.transient!.inviteMail).toMatchObject({ to: "zoe@example.com", projectName: "Trip", inviterName: "Alice", displayName: "Zoe" });
    expect(token.startsWith(`${g.projectId}.`)).toBe(true);
    const secret = token.split(".")[1]!;
    const stored = await runInDurableObject(g.stub, (_i, state) =>
      state.storage.sql.exec("SELECT response_json FROM idempotency").toArray().map((r) => String(r.response_json)).join(""),
    );
    expect(stored).not.toContain(secret);
    const history = await g.owner.ok("getHistory", {}, null, null);
    expect(JSON.stringify(history)).not.toContain("zoe@example.com");
  });

  it("a replayed add returns the member without transient", async () => {
    const g = await createGroup({ members: 0 });
    const key = crypto.randomUUID();
    const first = await g.owner.call("addMember", {}, { displayName: "Zoe", email: "z@example.com" }, key);
    const again = await g.owner.call("addMember", {}, { displayName: "Zoe", email: "z@example.com" }, key);
    expect(first.transient?.inviteMail).toBeDefined();
    expect(again.transient).toBeUndefined();
    expect((again.body as MemberDTO).id).toBe((first.body as MemberDTO).id);
  });

  it("non-owners see no invited email; one live invite per address", async () => {
    const g = await createGroup({ members: 1 });
    const { member } = await invite(g, "Zoe", "z@example.com");
    const seen = (await g.members[0]!.view()).members.find((m) => m.id === member.id)!;
    expect(seen.inviteState).toBe("INVITED");
    expect("invitedEmail" in seen).toBe(false);
    expect(await errorCode(g.owner.call("addMember", {}, { displayName: "Z2", email: "z@example.com" }))).toMatchObject({ status: 422, field: "email" });
  });

  it("previews without leaking the email to the body", async () => {
    const g = await createGroup({ members: 0 });
    const { token } = await invite(g, "Zoe", "z@example.com");
    const anon = new Client(g.stub, g.projectId, null);
    const res = await anon.call("previewMemberInvite", { tokenSecret: token }, null, null);
    expect(res.body).toEqual({ projectName: "Trip", baseCurrency: "PLN", displayName: "Zoe", status: "OPEN", canRename: true, alreadyMemberProjectId: null } satisfies MemberInvitePreviewDTO);
    expect(res.transient).toEqual({ invitedEmail: "z@example.com" });
  });

  it("accept claims the placeholder, keeping its id, entries and balance", async () => {
    const g = await createGroup({ members: 0 });
    const { member, token } = await invite(g, "Zoe", "z@example.com");
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, member.id], "1000"));
    const zoe = new Client(g.stub, g.projectId, accountFor("z@example.com"));
    const joined = await zoe.ok<JoinResultDTO>("acceptMemberInvite", { tokenSecret: token }, { displayName: "Zoë" });
    expect(joined).toEqual({ projectId: g.projectId, memberId: member.id });
    const view = await zoe.view();
    expect(view.me.memberId).toBe(member.id);
    expect(view.members.find((m) => m.id === member.id)).toMatchObject({ kind: "PERSON", displayName: "Zoë", inviteState: null, hasRecoverableAccount: true, isGuest: false });
    expect(view.current.balances.find((b) => b.memberId === member.id)?.net).toBe("-500");
    expect(view.current.readiness.map((r) => r.memberId)).toContain(member.id);
    const preview = await new Client(g.stub, g.projectId, null).ok<MemberInvitePreviewDTO>("previewMemberInvite", { tokenSecret: token }, null, null);
    expect(preview.status).toBe("CLAIMED");
    // Single use: a second accept (different key) fails.
    expect(await errorCode(zoe.call("acceptMemberInvite", { tokenSecret: token }, {}))).toMatchObject({ status: 409, code: "INVITE_INVALID" });
  });

  it("ignores the new name when renaming is locked", async () => {
    const g = await createGroup({ members: 0 });
    const v = await g.owner.view();
    await g.owner.ok("updateSettings", {}, { expectedVersion: v.project.version, membersCanRename: false });
    const { member, token } = await invite(g, "Zoe", "z@example.com");
    const zoe = new Client(g.stub, g.projectId, accountFor("z@example.com"));
    await zoe.ok("acceptMemberInvite", { tokenSecret: token }, { displayName: "Other" });
    expect((await zoe.view()).members.find((m) => m.id === member.id)?.displayName).toBe("Zoe");
  });

  it("rejects expired, cancelled and rotated links, other emails and existing members", async () => {
    const g = await createGroup({ members: 1 });
    const { member, token } = await invite(g, "Zoe", "z@example.com");
    const zoe = new Client(g.stub, g.projectId, accountFor("z@example.com"));

    // Resend rotates: old link is gone.
    const resent = await g.owner.call("inviteMember", { memberId: member.id }, { email: "z@example.com" });
    const fresh = resent.transient!.inviteMail!.url.split("#")[1]!;
    expect(await errorCode(zoe.call("acceptMemberInvite", { tokenSecret: token }, {}))).toMatchObject({ status: 404, code: "INVITE_INVALID" });

    // Wrong email.
    const other = new Client(g.stub, g.projectId, accountFor("x@example.com"));
    expect((await errorCode(other.call("acceptMemberInvite", { tokenSecret: fresh }, {}))).status).toBe(403);

    // Already in the group under another identity.
    const bob = g.members[0]!;
    const bobAsZoe = new Client(g.stub, g.projectId, { ...bob.principal!, email: "z@example.com" });
    expect(await errorCode(bobAsZoe.call("acceptMemberInvite", { tokenSecret: fresh }, {}))).toMatchObject({ status: 409, code: "ALREADY_MEMBER" });

    // Expired.
    await runInDurableObject(g.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE members SET invite_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", member.id);
    });
    expect((await g.owner.view()).members.find((m) => m.id === member.id)?.inviteState).toBe("INVITE_EXPIRED");
    expect(await errorCode(zoe.call("acceptMemberInvite", { tokenSecret: fresh }, {}))).toMatchObject({ status: 409, code: "INVITE_INVALID", details: { status: "EXPIRED" } });

    // Cancel: back to a plain placeholder, link unknown.
    const cancelled = await g.owner.ok<MemberDTO>("cancelMemberInvite", { memberId: member.id });
    expect(cancelled).toMatchObject({ kind: "PLACEHOLDER", inviteState: null, invitedEmail: null });
    expect((await errorCode(zoe.call("acceptMemberInvite", { tokenSecret: fresh }, {}))).status).toBe(404);
  });

  it("accept is allowed while settling (claiming changes no accounting)", async () => {
    const g = await createGroup({ members: 0 });
    const { member, token } = await invite(g, "Zoe", "z@example.com");
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, member.id], "1000"));
    await freezeNow(g);
    const zoe = new Client(g.stub, g.projectId, accountFor("z@example.com"));
    expect((await zoe.ok<JoinResultDTO>("acceptMemberInvite", { tokenSecret: token }, {})).memberId).toBe(member.id);
    expect((await errorCode(g.owner.call("inviteMember", { memberId: member.id }, { email: "q@example.com" }))).status).toBe(409);
  });

  it("re-claim after the account was removed earlier retires the old row instead of colliding", async () => {
    const g = await createGroup({ members: 0 });
    const zoeAccount = accountFor("z@example.com");
    const inviteToken = (await g.owner.ok<{ url: string }>("createInvite")).url.split("#")[1]!;
    const zoe = new Client(g.stub, g.projectId, zoeAccount);
    const first = await zoe.ok<JoinResultDTO>("join", { tokenSecret: inviteToken }, { displayName: "Zoe" });
    await g.owner.ok("removeMember", { memberId: first.memberId });
    const { member, token } = await invite(g, "Zoe again", "z@example.com");
    expect((await zoe.ok<JoinResultDTO>("acceptMemberInvite", { tokenSecret: token }, {})).memberId).toBe(member.id);
  });
});
