import { describe, expect, it } from "vitest";
import type { EntryDTO, ProjectViewDTO, ReviewDTO } from "@shared/api";
import { Client, createGroup, errorCode, expense, type Group } from "./helpers";

const readyMap = async (c: Client) =>
  Object.fromEntries((await c.view()).current.readiness.map((r) => [r.memberId, r.ready]));

async function allReady(g: Group) {
  for (const c of [g.owner, ...g.members]) await c.ok("setReadiness", { roundId: g.roundId }, { ready: true });
}

describe("entries", () => {
  it("splits 100 PLN three ways as 33.34/33.33/33.33 and refunds reverse effects", async () => {
    const g = await createGroup({ members: 2 });
    const ids = [g.owner.memberId, ...g.members.map((m) => m.memberId)];
    const entry = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, ids, "10000"));
    const sorted = [...ids].sort();
    const byMember = Object.fromEntries(entry.allocations.map((a) => [a.memberId, a.baseAmount]));
    expect(byMember[sorted[0]!]).toBe("3334");
    expect(byMember[sorted[1]!]).toBe("3333");
    expect(byMember[sorted[2]!]).toBe("3333");

    const bob = g.members[0]!;
    await bob.ok<EntryDTO>(
      "createEntry",
      { roundId: g.roundId },
      { ...expense(g.owner.memberId, [g.owner.memberId, bob.memberId], "2000"), type: "REFUND", description: "Deposit back" },
    );
    const view = await g.owner.view();
    expect(view.current.totals).toEqual({ expenses: "10000", refunds: "2000", adjustments: "0" });
    const net = view.current.balances.reduce((s, b) => s + BigInt(b.net), 0n);
    expect(net).toBe(0n);
    const owner = view.current.balances.find((b) => b.memberId === g.owner.memberId)!;
    // paid 100 − refund received 20; share depends on tie-break but net = paid − share.
    expect(BigInt(owner.paid)).toBe(8000n);
  });

  it("validates exact splits with field paths", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    const exact = (amounts: (string | undefined)[]) =>
      g.owner.call("createEntry", { roundId: g.roundId }, {
        ...expense(g.owner.memberId, [], "1000"),
        splitMode: "EXACT",
        participants: [
          { memberId: g.owner.memberId, amount: amounts[0] },
          { memberId: bob.memberId, amount: amounts[1] },
        ],
      });
    expect(await errorCode(exact(["600", "300"]))).toMatchObject({ status: 422, field: "participants" });
    expect(await errorCode(exact(["600", undefined]))).toMatchObject({ status: 422, field: "participants.1.amount" });
    expect(await errorCode(exact(["1100", "-100"]))).toMatchObject({ status: 422, field: "participants.1.amount" });
    expect((await exact(["1000", "0"])).status).toBe(201);
    expect(
      await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [bob.memberId, bob.memberId], "100"))),
    ).toMatchObject({ field: "participants.1.memberId" });
    expect(await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, expense("m_nobody", [bob.memberId], "100")))).toMatchObject({
      field: "payerMemberId",
    });
    expect(await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, { ...expense(g.owner.memberId, [bob.memberId], "100"), description: " " }))).toMatchObject({
      field: "description",
    });
    expect((await errorCode(g.owner.call("createEntry", { roundId: "r_missing" }, expense(g.owner.memberId, [bob.memberId], "100")))).status).toBe(404);
  });

  it("enforces amount and round total limits before mutating", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    expect(
      await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [bob.memberId], "1000000000001"))),
    ).toMatchObject({ status: 422, field: "originalAmount" });
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [bob.memberId], "1000000000000"));
    expect(await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [bob.memberId], "1")))).toMatchObject({
      status: 422,
      code: "LIMIT_EXCEEDED",
    });
    expect((await g.owner.view()).current.entries).toHaveLength(1);
  });

  it("lets owners edit anyone's entry (audited) but participants only their own", async () => {
    const g = await createGroup({ members: 2 });
    const [bob, carol] = g.members as [Client, Client];
    const entry = await bob.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(bob.memberId, [bob.memberId, carol.memberId], "1000"));
    const edit = (c: Client, rev: number, amount = "1200") =>
      c.call("updateEntry", { roundId: g.roundId, entryId: entry.id }, {
        ...expense(bob.memberId, [bob.memberId, carol.memberId], amount),
        expectedRevision: rev,
      });
    expect((await errorCode(edit(carol, 1))).status).toBe(403);
    expect((await errorCode(carol.call("deleteEntry", { roundId: g.roundId, entryId: entry.id }, { expectedRevision: 1 }))).status).toBe(403);
    const updated = (await edit(g.owner, 1)).body as EntryDTO;
    expect(updated).toMatchObject({ revision: 2, originalAmount: "1200", lastEditedByMemberId: g.owner.memberId, creatorMemberId: bob.memberId });
    expect(await errorCode(edit(bob, 1, "1300"))).toMatchObject({ status: 409, code: "STALE_VERSION", details: { currentRevision: 2 } });
    expect((await edit(bob, 2, "1300")).status).toBe(200);

    const history = await g.owner.ok("getHistory", {}, null, null);
    const ownerEdit = history.events.find((e: any) => e.action === "ENTRY_UPDATED" && e.actorMemberId === g.owner.memberId);
    expect(ownerEdit.details.creatorMemberId).toBe(bob.memberId);
    expect(ownerEdit.details.before.originalAmount).toBe("1000");
    expect(ownerEdit.details.after.originalAmount).toBe("1200");

    await bob.ok("deleteEntry", { roundId: g.roundId, entryId: entry.id }, { expectedRevision: 3 });
    expect((await g.owner.view()).current.entries).toHaveLength(0);
    expect((await errorCode(bob.call("deleteEntry", { roundId: g.roundId, entryId: entry.id }, { expectedRevision: 4 }))).status).toBe(404);
  });
});

describe("readiness (criterion 13)", () => {
  it("is reversible and bumps the review version", async () => {
    const g = await createGroup();
    const r0 = await g.owner.ok<ReviewDTO>("getReview", { roundId: g.roundId }, null, null);
    await g.owner.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    const r1 = await g.owner.ok<ReviewDTO>("getReview", { roundId: g.roundId }, null, null);
    expect(r1.reviewVersion).toBeGreaterThan(r0.reviewVersion);
    expect(r1.ledgerVersion).toBe(r0.ledgerVersion);
    expect(r1.notReadyMemberIds).toEqual([g.members[0]!.memberId]);
    await g.owner.ok("setReadiness", { roundId: g.roundId }, { ready: false });
    expect((await readyMap(g.owner))[g.owner.memberId]).toBe(false);
  });

  it("a new entry clears only the actor; an edit clears actor and creator", async () => {
    const g = await createGroup({ members: 2 });
    const [bob, carol] = g.members as [Client, Client];
    await allReady(g);
    const entry = await bob.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(carol.memberId, [carol.memberId, g.owner.memberId], "500"));
    expect(await readyMap(g.owner)).toEqual({ [g.owner.memberId]: true, [bob.memberId]: false, [carol.memberId]: true });

    await allReady(g);
    await g.owner.ok("updateEntry", { roundId: g.roundId, entryId: entry.id }, {
      ...expense(carol.memberId, [carol.memberId], "500"),
      expectedRevision: 1,
    });
    expect(await readyMap(g.owner)).toEqual({ [g.owner.memberId]: false, [bob.memberId]: false, [carol.memberId]: true });

    await allReady(g);
    await carol.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    await g.owner.ok("deleteEntry", { roundId: g.roundId, entryId: entry.id }, { expectedRevision: 2 });
    expect(await readyMap(g.owner)).toEqual({ [g.owner.memberId]: false, [bob.memberId]: false, [carol.memberId]: true });
  });

  it("currency-mode changes clear everyone; rate defaults clear no one", async () => {
    const g = await createGroup();
    await allReady(g);
    await g.owner.ok("putRate", { currency: "EUR" }, { rate: "4.3" });
    expect(Object.values(await readyMap(g.owner)).every(Boolean)).toBe(true);
    const { project } = await g.owner.view();
    await g.owner.ok("updateSettings", {}, { expectedVersion: project.version, multiCurrencyEnabled: true });
    expect(Object.values(await readyMap(g.owner)).some(Boolean)).toBe(false);
  });
});

describe("idempotency", () => {
  it("replays the committed response for the same key and rejects different content", async () => {
    const g = await createGroup();
    const body = expense(g.owner.memberId, [g.owner.memberId], "700");
    const key = crypto.randomUUID();
    const first = await g.owner.call("createEntry", { roundId: g.roundId }, body, key);
    const second = await g.owner.call("createEntry", { roundId: g.roundId }, body, key);
    expect(second).toEqual(first);
    expect((await g.owner.view()).current.entries).toHaveLength(1);
    expect(await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, { ...body, originalAmount: "701" }, key))).toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
    // Keys are scoped per principal: Bob may reuse the same key string.
    const bob = g.members[0]!;
    expect((await bob.call("createEntry", { roundId: g.roundId }, expense(bob.memberId, [bob.memberId], "5"), key)).status).toBe(201);
  });

  it("does not record failed attempts, so a fixed retry with the same key succeeds", async () => {
    const g = await createGroup();
    const key = crypto.randomUUID();
    const bad = expense(g.owner.memberId, [g.owner.memberId], "0");
    expect((await g.owner.call("createEntry", { roundId: g.roundId }, bad, key)).status).toBe(422);
    const v1 = (await g.owner.view()).project.version;
    expect((await g.owner.call("createEntry", { roundId: g.roundId }, { ...bad, originalAmount: "1" }, key)).status).toBe(201);
    expect((await g.owner.view()).project.version).toBe(v1 + 1);
  });
});

describe("views", () => {
  it("reports per-currency subtotals separately from base totals", async () => {
    const g = await createGroup({ multiCurrencyEnabled: true });
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId], "1000"));
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId], "500", {
      originalCurrency: "EUR",
      conversion: { method: "MANUAL_RATE", rate: "4" },
    }));
    const view: ProjectViewDTO = await g.owner.view();
    expect(view.current.totals.expenses).toBe("3000");
    expect(view.current.currencySubtotals).toEqual([
      { currency: "EUR", exponent: 2, expenses: "500", refunds: "0", baseEquivalent: "2000" },
      { currency: "PLN", exponent: 2, expenses: "1000", refunds: "0", baseEquivalent: "1000" },
    ]);
  });
});
