import { describe, expect, it } from "vitest";
import type { MemberDTO, ProjectDTO } from "@shared/api";
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
