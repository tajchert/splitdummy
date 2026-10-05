import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryDTO, FreezeResultDTO, HistoryDTO, MemberDTO, OkDTO, RoundViewDTO } from "@shared/api";
import type { AccountDeletionInfo } from "../../worker/do/ops/account";
import type { OutboxMessage } from "../../worker/do/types";
import { Client, createGroup, errorCode, expense, freezeNow, listen, makePrincipal, sqlIn, stubFor, waitFor, type Group } from "./helpers";

const info = (c: Client) => c.call("accountDeletionInfo", {}, null, null);
const anonymize = (c: Client) => c.call("anonymizeMember", {}, null, null);
const history = (g: Group) => g.owner.ok<HistoryDTO>("getHistory", {}, null, null);

/** Owner pays for everyone → each member owes the owner 10.00. */
async function ownerPaysForAll(g: Group) {
  const ids = [g.owner.memberId, ...g.members.map((m) => m.memberId)];
  return g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, ids, String(1000 * ids.length)));
}

async function settleAll(g: Group, frozen: FreezeResultDTO) {
  for (const i of frozen.instructions) {
    const from = [g.owner, ...g.members].find((c) => c.memberId === i.fromMemberId)!;
    const to = [g.owner, ...g.members].find((c) => c.memberId === i.toMemberId)!;
    await from.ok("markSent", { roundId: g.roundId, instructionId: i.id }, {});
    await to.ok("markReceived", { roundId: g.roundId, instructionId: i.id }, {});
  }
}

describe("rename self", () => {
  it("renames only the caller, audits before/after, broadcasts, and allows duplicate names", async () => {
    const g = await createGroup({ members: 2 });
    const [bob, carol] = g.members as [Client, Client];
    const live = await listen(g.stub, carol.principal);
    const before = (await g.owner.view()).project.version;

    const member = await bob.ok<MemberDTO>("renameMe", {}, { displayName: "  Bob P.  " });
    expect(member).toMatchObject({ id: bob.memberId, displayName: "Bob P.", accountDeleted: false, isOwner: false });
    const view = await g.owner.view();
    expect(view.project.version).toBe(before + 1);
    expect(view.members.find((m) => m.id === bob.memberId)?.displayName).toBe("Bob P.");
    expect(view.members.every((m) => m.accountDeleted === false)).toBe(true);

    const event = (await history(g)).events[0]!;
    expect(event).toMatchObject({
      action: "MEMBER_RENAMED",
      actorMemberId: bob.memberId,
      entityId: bob.memberId,
      roundId: g.roundId,
      summary: "Bob renamed themselves to Bob P.",
      details: { from: "Bob", to: "Bob P." },
    });
    await waitFor(() => live.messages.some((m) => m.type === "changed" && m.reason === "renameMe"));
    live.ws.close();

    // Same name as someone else is fine; identity is the member ID.
    await carol.ok("renameMe", {}, { displayName: "Alice" });
    expect((await g.owner.view()).members.filter((m) => m.displayName === "Alice")).toHaveLength(2);

    // Unchanged name: no audit, no version bump.
    const v = (await g.owner.view()).project.version;
    await carol.ok("renameMe", {}, { displayName: "Alice" });
    expect((await g.owner.view()).project.version).toBe(v);

    expect(await errorCode(bob.call("renameMe", {}, { displayName: "" }))).toMatchObject({ status: 422, field: "displayName" });
    const stranger = new Client(g.stub, g.projectId, makePrincipal());
    expect((await errorCode(stranger.call("renameMe", {}, { displayName: "X" }))).status).toBe(404);
  });

  it("works in any round state, including settlement, without touching money", async () => {
    const g = await createGroup();
    await ownerPaysForAll(g);
    const frozen: FreezeResultDTO = await freezeNow(g);
    const bob = g.members[0]!;
    await bob.ok("renameMe", {}, { displayName: "Robert" });
    const round = await g.owner.ok<RoundViewDTO>("getRound", { roundId: g.roundId }, null, null);
    expect(round.round.status).toBe("SETTLING");
    expect(round.round.reviewVersion).toBe(frozen.round.reviewVersion);
    expect(round.instructions.map((i) => i.fromMemberId)).toEqual([bob.memberId]);
  });
});

describe("account deletion ops", () => {
  it("reports role, member count and open transfers; 404 only when the project doesn't exist", async () => {
    const g = await createGroup({ members: 2 });
    const [bob] = g.members as [Client, Client];
    expect((await info(g.owner)).body).toEqual({ role: "OWNER", name: "Trip", memberCount: 3, hasOpenTransfers: false });
    expect((await info(bob)).body).toEqual({ role: "MEMBER", name: "Trip", memberCount: 3, hasOpenTransfers: false });
    expect((await info(new Client(g.stub, g.projectId, makePrincipal()))).body).toMatchObject({ role: "NONE" });
    expect((await errorCode(info(new Client(g.stub, g.projectId, null)))).status).toBe(401);
    const empty = new Client(stubFor("p_never_created"), "p_never_created", makePrincipal());
    expect((await errorCode(info(empty))).status).toBe(404);

    await ownerPaysForAll(g);
    const frozen: FreezeResultDTO = await freezeNow(g);
    expect((await info(bob)).body).toMatchObject({ role: "MEMBER", hasOpenTransfers: true });
    expect((await info(g.owner)).body).toMatchObject({ role: "OWNER", hasOpenTransfers: true });
    // Sent but not yet confirmed still blocks.
    const bobsTransfer = frozen.instructions.find((i) => i.fromMemberId === bob.memberId)!;
    await bob.ok("markSent", { roundId: g.roundId, instructionId: bobsTransfer.id }, {});
    expect((await info(bob)).body).toMatchObject({ hasOpenTransfers: true });
    await g.owner.ok("markReceived", { roundId: g.roundId, instructionId: bobsTransfer.id }, {});
    expect((await info(bob)).body).toMatchObject({ hasOpenTransfers: false });
  });

  it("anonymizes a joined member while settling only once their transfers are confirmed; references stay intact", async () => {
    const g = await createGroup({ members: 2 });
    const [bob, carol] = g.members as [Client, Client];
    await ownerPaysForAll(g);
    await bob.ok("createEntry", { roundId: g.roundId }, expense(bob.memberId, [bob.memberId, carol.memberId], "500"));
    const frozen: FreezeResultDTO = await freezeNow(g);
    expect(await errorCode(anonymize(bob))).toMatchObject({
      status: 409,
      code: "ACCOUNT_HAS_OPEN_TRANSFERS",
      details: { projects: [{ id: g.projectId, name: "Trip" }] },
    });
    expect((await g.owner.view()).members.find((m) => m.id === bob.memberId)?.accountDeleted).toBe(false);

    for (const i of frozen.instructions.filter((x) => x.fromMemberId === bob.memberId || x.toMemberId === bob.memberId)) {
      const from = [g.owner, bob, carol].find((c) => c.memberId === i.fromMemberId)!;
      const to = [g.owner, bob, carol].find((c) => c.memberId === i.toMemberId)!;
      await from.ok("markSent", { roundId: g.roundId, instructionId: i.id }, {});
      await to.ok("markReceived", { roundId: g.roundId, instructionId: i.id }, {});
    }
    const roundBefore = await g.owner.ok<RoundViewDTO>("getRound", { roundId: g.roundId }, null, null);
    const live = await listen(g.stub, bob.principal);

    expect((await anonymize(bob)).body).toEqual({ ok: true } satisfies OkDTO);
    const view = await g.owner.view();
    const anon = view.members.find((m) => m.id === bob.memberId)!;
    expect(anon).toMatchObject({ displayName: "Deleted account", accountDeleted: true, hasRecoverableAccount: false, referenced: true });
    // Membership is frozen while settling, so the status stays; balances and transfers are untouched.
    expect(anon.status).toBe("ACTIVE");
    const roundAfter = await g.owner.ok<RoundViewDTO>("getRound", { roundId: g.roundId }, null, null);
    expect(roundAfter.balances).toEqual(roundBefore.balances);
    expect(roundAfter.instructions).toEqual(roundBefore.instructions);
    expect(roundAfter.entries.some((e) => e.payerMemberId === bob.memberId)).toBe(true);
    const transfers = await sqlIn<{ n: number }>(
      g.stub,
      "SELECT COUNT(*) AS n FROM confirmed_transfers WHERE from_member_id = ?1 OR to_member_id = ?1",
      bob.memberId,
    );
    expect(transfers[0]!.n).toBeGreaterThan(0);
    const snap = await sqlIn<{ snapshot_json: string }>(g.stub, "SELECT snapshot_json FROM settlement_snapshots");
    expect(snap[0]!.snapshot_json).not.toContain('"Bob"');

    const event = (await history(g)).events[0]!;
    expect(event).toMatchObject({ action: "MEMBER_ACCOUNT_DELETED", summary: "A member deleted their account", entityId: bob.memberId });
    await waitFor(() => live.closes.length > 0);

    // The old principal no longer matches anything; a retry is a no-op.
    expect((await errorCode(bob.call("getProject", {}, null, null))).status).toBe(404);
    expect((await info(bob)).body).toMatchObject({ role: "NONE" });
    const v = view.project.version;
    expect((await anonymize(bob)).status).toBe(200);
    expect((await g.owner.view()).project.version).toBe(v);

    // Directory projection no longer lists the deleted principal.
    const outbox = await sqlIn<{ message_json: string }>(g.stub, "SELECT message_json FROM outbox WHERE type = 'DIRECTORY_UPSERT' ORDER BY seq DESC LIMIT 1");
    const dir = JSON.parse(outbox[0]!.message_json) as Extract<OutboxMessage, { type: "DIRECTORY_UPSERT" }>;
    expect(dir.payload.members.map((m) => m.principalId)).not.toContain(bob.principal!.principalId);
    expect(dir.payload.members.map((m) => m.memberId)).not.toContain(bob.memberId);

    // Settling finishes normally; the next round doesn't expect the deleted member to be ready.
    await settleAll(g, { round: frozen.round, instructions: roundAfter.instructions.filter((i) => i.state !== "CONFIRMED") });
    const next = await g.owner.ok<{ id: string }>("startRound");
    const nextView = await g.owner.ok<RoundViewDTO>("getRound", { roundId: next.id }, null, null);
    expect(nextView.readiness.map((r) => r.memberId)).not.toContain(bob.memberId);
    expect((await g.owner.view()).members.find((m) => m.id === bob.memberId)?.status).toBe("LEFT");
  });

  it("anonymizing while collecting makes the member LEFT and drops them from readiness", async () => {
    const g = await createGroup({ members: 2 });
    const [bob, carol] = g.members as [Client, Client];
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, carol.memberId], "500"));
    await bob.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    await carol.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    await anonymize(bob);
    const view = await g.owner.view();
    expect(view.members.find((m) => m.id === bob.memberId)).toMatchObject({ status: "LEFT", accountDeleted: true });
    expect(view.current.readiness.map((r) => r.memberId)).not.toContain(bob.memberId);
    // Only Bob's readiness was cleared; Carol stays ready.
    expect(view.current.readiness.find((r) => r.memberId === carol.memberId)?.ready).toBe(true);
    const ready = await sqlIn<{ ready: number }>(g.stub, "SELECT ready FROM readiness WHERE member_id = ?", bob.memberId);
    expect(ready[0]!.ready).toBe(0);
    expect(view.current.balances.find((b) => b.memberId === bob.memberId)?.net).toBe("0");
    expect(view.current.entries).toHaveLength(1);
  });

  it.each(["sender", "recipient", "zero net"])("blocks deletion with collecting expenses: %s", async (role) => {
    const g = await createGroup();
    const bob = g.members[0]!;
    const payer = role === "sender" ? g.owner : bob;
    await payer.ok("createEntry", { roundId: g.roundId }, expense(payer.memberId, [g.owner.memberId, bob.memberId], "1000"));
    if (role === "zero net") {
      await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, bob.memberId], "1000"));
    }
    expect((await info(bob)).body).toMatchObject({ hasOpenTransfers: true });
    expect(await errorCode(anonymize(bob))).toMatchObject({ status: 409, code: "ACCOUNT_HAS_OPEN_TRANSFERS" });
    expect((await g.owner.view()).members.find((m) => m.id === bob.memberId)?.accountDeleted).toBe(false);
    const frozen = await freezeNow(g);
    await settleAll(g, frozen);
    expect((await anonymize(bob)).status).toBe(200);
    expect((await g.owner.ok("startRound"))).toHaveProperty("id");
  });

  it("allows deletion after the last collecting expense reference is deleted", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    const entry = await ownerPaysForAll(g);
    expect((await info(bob)).body).toMatchObject({ hasOpenTransfers: true });
    await g.owner.ok("deleteEntry", { roundId: g.roundId, entryId: entry.id }, { expectedRevision: entry.revision });
    expect((await info(bob)).body).toMatchObject({ hasOpenTransfers: false });
    expect((await anonymize(bob)).status).toBe(200);
    expect((await freezeNow(g)).instructions).toEqual([]);
  });

  it("anonymizes removed memberships and their historical names", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    await g.owner.ok("removeMember", { memberId: bob.memberId });
    expect((await info(bob)).body).toMatchObject({ role: "MEMBER" });
    expect((await anonymize(bob)).status).toBe(200);
    const rows = await sqlIn<{ display_name: string; principal_id: string; account_deleted: number }>(g.stub, "SELECT * FROM members WHERE id = ?", bob.memberId);
    expect(rows[0]).toMatchObject({ display_name: "Deleted account", account_deleted: 1 });
    expect(rows[0]!.principal_id).not.toBe(bob.principal!.principalId);
    expect(JSON.stringify(await history(g))).not.toContain("Bob");
  });

  it("removes historical audit names while preserving financial details and unrelated members", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    await bob.ok("renameMe", {}, { displayName: "Robert" });
    const entry = await bob.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(bob.memberId, [g.owner.memberId, bob.memberId], "1000"));
    const frozen = await freezeNow(g);
    const transfer = frozen.instructions[0]!;
    await g.owner.ok("markSent", { roundId: g.roundId, instructionId: transfer.id }, {});
    await bob.ok("markDisputed", { roundId: g.roundId, instructionId: transfer.id }, { note: "Still pending" });
    await settleAll(g, frozen);
    const before = await history(g);
    await anonymize(bob);
    const after = await history(g);
    expect(JSON.stringify(after)).not.toContain("Bob");
    expect(JSON.stringify(after)).not.toContain("Robert");
    const beforeEntry = before.events.find((e) => e.action === "ENTRY_CREATED")!;
    const afterEntry = after.events.find((e) => e.id === beforeEntry.id)!;
    expect(afterEntry.details).toEqual(beforeEntry.details);
    expect(afterEntry.entityId).toBe(entry.id);
    const transferEvents = after.events.filter((e) => e.action.startsWith("INSTRUCTION_"));
    expect(transferEvents).toHaveLength(4);
    for (const event of transferEvents) {
      expect(event.summary).toContain("5.00 PLN");
      expect(event.summary).toContain("Alice");
      expect(event.summary).toContain("Deleted account");
    }
    expect(after.events.find((e) => e.action === "INSTRUCTION_DISPUTED")?.details).toEqual({ note: "Still pending" });
    expect(after.events.find((e) => e.action === "ROUND_FROZEN")?.summary).toContain("Alice");
    expect((await g.owner.view()).members.find((m) => m.id === g.owner.memberId)?.displayName).toBe("Alice");
  });

  it("rejects new financial references to a deleted member", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    const entry = await ownerPaysForAll(g);
    await settleAll(g, await freezeNow(g));
    await anonymize(bob);
    const next = await g.owner.ok<{ id: string }>("startRound");
    expect(await errorCode(g.owner.call("createEntry", { roundId: next.id }, expense(bob.memberId, [g.owner.memberId], "1000")))).toMatchObject({ status: 422, field: "payerMemberId" });
    expect(await errorCode(g.owner.call("createEntry", { roundId: next.id }, expense(g.owner.memberId, [bob.memberId], "1000")))).toMatchObject({ status: 422, field: "participants.0.memberId" });
    expect(await errorCode(g.owner.call("createAdjustment", { roundId: next.id }, {
      correctedRoundId: g.roundId, correctedEntryId: entry.id, description: "Correction", occurredAt: "2026-10-01",
      effects: [{ memberId: bob.memberId, baseAmount: "100" }, { memberId: g.owner.memberId, baseAmount: "-100" }],
    }))).toMatchObject({ status: 422, field: "effects.0.memberId" });
  });

  it("refuses to anonymize the owner", async () => {
    const g = await createGroup();
    expect(await errorCode(anonymize(g.owner))).toMatchObject({ status: 409, code: "INVALID_TRANSITION" });
  });

  it("deletes an owned project: owner only, wipes storage and alarm, closes sockets, and never resurrects", async () => {
    const g = await createGroup({ members: 2 });
    const [bob] = g.members as [Client, Client];
    await ownerPaysForAll(g);
    await g.owner.ok("setFreezeSchedule", { roundId: g.roundId }, { date: "2099-01-01", timeZone: "UTC" });
    expect((await errorCode(bob.call("deleteProject", {}, null, null))).status).toBe(403);
    expect((await errorCode(new Client(g.stub, g.projectId, makePrincipal()).call("deleteProject", {}, null, null))).status).toBe(404);
    const live = await listen(g.stub, bob.principal);

    const res = await g.owner.call("deleteProject", {}, null, null);
    expect(res.status).toBe(200);
    expect((res.body as { memberPrincipalIds: string[] }).memberPrincipalIds.sort()).toEqual(
      [g.owner, ...g.members].map((c) => c.principal!.principalId).sort(),
    );
    await waitFor(() => live.closes.length > 0);

    for (const c of [g.owner, bob]) {
      expect((await errorCode(c.call("getProject", {}, null, null))).status).toBe(404);
      expect((await errorCode(c.call("createEntry", { roundId: g.roundId }, expense(c.memberId, [c.memberId], "1")))).status).toBe(404);
    }
    expect((await errorCode(info(g.owner))).status).toBe(404);
    expect((await errorCode(g.owner.call("deleteProject", {}, null, null))).status).toBe(404);
    expect((await new Client(g.stub, g.projectId, null).call("backupSnapshot", {}, null, null)).status).toBe(404);
    expect(await runInDurableObject(g.stub, (_i, state) => state.storage.getAlarm())).toBeNull();
    const rows = await sqlIn<{ n: number }>(g.stub, "SELECT (SELECT COUNT(*) FROM project) + (SELECT COUNT(*) FROM members) + (SELECT COUNT(*) FROM entries) + (SELECT COUNT(*) FROM audit_events) AS n");
    expect(rows[0]!.n).toBe(0);
    // Same after the object is evicted and rebuilt from storage.
    const fresh = new Client(stubFor(g.projectId), g.projectId, g.owner.principal);
    expect((await errorCode(fresh.call("getProject", {}, null, null))).status).toBe(404);
    expect((await g.stub.fetch("https://do/live", { headers: { Upgrade: "websocket", "X-Splitdummy-Principal": JSON.stringify(bob.principal) } })).status).toBe(404);
  });
});
