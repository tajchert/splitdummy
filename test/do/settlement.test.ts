import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryDTO, FreezeResultDTO, HistoryDTO, InstructionResultDTO, ReviewDTO, RoundDTO, RoundViewDTO } from "@shared/api";
import type { OutboxMessage } from "../../worker/do/types";
import { Client, createGroup, errorCode, expense, freezeNow, type Group } from "./helpers";

/** Owner pays `perHead × n` split equally among everyone → every member owes the owner `perHead`. */
async function ownerPaysForAll(g: Group, perHead = 1000) {
  const ids = [g.owner.memberId, ...g.members.map((m) => m.memberId)];
  return g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, ids, String(perHead * ids.length)));
}

const act = (c: Client, op: "markSent" | "markReceived" | "markDisputed", g: Group, instructionId: string, body: unknown = {}) =>
  c.call(op, { roundId: g.roundId, instructionId }, body);

const sql = <T = Record<string, unknown>>(g: Group, query: string, ...args: (string | number)[]) =>
  runInDurableObject(g.stub, (_i, state) => state.storage.sql.exec(query, ...args).toArray() as T[]);

describe("freeze (criteria 14–16)", () => {
  it("requires the owner, a fresh review version and acknowledgement of exactly the not-ready members", async () => {
    const g = await createGroup({ members: 2 });
    const [bob, carol] = g.members as [Client, Client];
    await ownerPaysForAll(g);
    await bob.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    const review = await g.owner.ok<ReviewDTO>("getReview", { roundId: g.roundId }, null, null);
    expect(review.notReadyMemberIds.sort()).toEqual([g.owner.memberId, carol.memberId].sort());
    expect(review.proposedTransfers).toHaveLength(2);

    const freeze = (c: Client, body: object) => c.call("freeze", { roundId: g.roundId }, { expectedReviewVersion: review.reviewVersion, ...body });
    expect((await errorCode(freeze(bob, { acknowledgeNotReady: review.notReadyMemberIds }))).status).toBe(403);
    const unack = await errorCode(freeze(g.owner, {}));
    expect(unack).toMatchObject({ status: 409, code: "NOT_READY_UNACKNOWLEDGED" });
    expect(unack.details.notReady.sort()).toEqual(review.notReadyMemberIds.sort());
    expect((await errorCode(freeze(g.owner, { acknowledgeNotReady: [carol.memberId] }))).code).toBe("NOT_READY_UNACKNOWLEDGED");
    expect((await errorCode(freeze(g.owner, { acknowledgeNotReady: [...review.notReadyMemberIds, bob.memberId] }))).code).toBe(
      "NOT_READY_UNACKNOWLEDGED",
    );

    await carol.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    const stale = await errorCode(freeze(g.owner, { acknowledgeNotReady: [g.owner.memberId] }));
    expect(stale).toMatchObject({ status: 409, code: "REVIEW_STALE" });
    expect(stale.details.currentReviewVersion).toBeGreaterThan(review.reviewVersion);

    const fresh = await g.owner.ok<ReviewDTO>("getReview", { roundId: g.roundId }, null, null);
    const res = await g.owner.ok<FreezeResultDTO>("freeze", { roundId: g.roundId }, {
      expectedReviewVersion: fresh.reviewVersion,
      acknowledgeNotReady: [g.owner.memberId],
      earlyFreezeReason: "Flight leaves soon",
    });
    expect(res.round).toMatchObject({ status: "SETTLING", earlyFreezeReason: "Flight leaves soon", frozenByMemberId: g.owner.memberId });
    expect(res.instructions.map((i) => ({ from: i.fromMemberId, to: i.toMemberId, amount: i.amount }))).toEqual(
      fresh.proposedTransfers.map((t) => ({ from: t.fromMemberId, to: t.toMemberId, amount: t.amount })),
    );
    const history = await bob.ok<HistoryDTO>("getHistory", {}, null, null);
    const frozen = history.events.find((e) => e.action === "ROUND_FROZEN")!;
    expect(frozen.details).toMatchObject({ earlyFreezeReason: "Flight leaves soon", acknowledgedNotReady: [g.owner.memberId] });

    // Settling: no more edits, readiness, review or freeze.
    expect((await errorCode(bob.call("createEntry", { roundId: g.roundId }, expense(bob.memberId, [bob.memberId], "1")))).code).toBe(
      "ROUND_NOT_COLLECTING",
    );
    expect((await errorCode(bob.call("setReadiness", { roundId: g.roundId }, { ready: false }))).code).toBe("ROUND_NOT_COLLECTING");
    expect((await errorCode(g.owner.call("getReview", { roundId: g.roundId }, null, null))).code).toBe("ROUND_NOT_COLLECTING");
    expect((await errorCode(g.owner.call("removeMember", { memberId: carol.memberId }))).code).toBe("ROUND_NOT_COLLECTING");
  });

  it("serializes racing add-expense and freeze: never an expense inside a frozen snapshot (criterion 15)", async () => {
    for (let i = 0; i < 6; i++) {
      const g = await createGroup();
      const bob = g.members[0]!;
      await ownerPaysForAll(g);
      const review = await g.owner.ok<ReviewDTO>("getReview", { roundId: g.roundId }, null, null);
      const add = bob.call("createEntry", { roundId: g.roundId }, expense(bob.memberId, [bob.memberId, g.owner.memberId], "999"));
      const freeze = g.owner.call("freeze", { roundId: g.roundId }, {
        expectedReviewVersion: review.reviewVersion,
        acknowledgeNotReady: review.notReadyMemberIds,
      });
      const [a, f] =
        i % 2 === 0 ? await Promise.all([add, freeze]) : await Promise.all([freeze, add]).then(([f2, a2]) => [a2, f2] as const);
      const view = await g.owner.ok<RoundViewDTO>("getRound", { roundId: g.roundId }, null, null);
      if (a.status === 201) {
        expect(await errorCode(f)).toMatchObject({ status: 409, code: "REVIEW_STALE" });
        expect(view.round.status).toBe("COLLECTING");
        expect(view.entries).toHaveLength(2);
      } else {
        expect(f.status).toBe(200);
        expect(await errorCode(a)).toMatchObject({ status: 409, code: "ROUND_NOT_COLLECTING" });
        expect(view.round.status).toBe("SETTLING");
        expect(view.entries).toHaveLength(1);
      }
    }
  });

  it("returns the same result for duplicate freeze retries (criterion 16)", async () => {
    const g = await createGroup();
    await ownerPaysForAll(g);
    const review = await g.owner.ok<ReviewDTO>("getReview", { roundId: g.roundId }, null, null);
    const body = { expectedReviewVersion: review.reviewVersion, acknowledgeNotReady: review.notReadyMemberIds };
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([
      g.owner.call("freeze", { roundId: g.roundId }, body, key),
      g.owner.call("freeze", { roundId: g.roundId }, body, key),
    ]);
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    expect(await g.owner.call("freeze", { roundId: g.roundId }, body, key)).toEqual(a);
    expect((await errorCode(g.owner.call("freeze", { roundId: g.roundId }, body))).code).toBe("ROUND_NOT_COLLECTING");
    const rows = await sql<{ n: number }>(g, "SELECT COUNT(*) AS n FROM instructions");
    expect(rows[0]!.n).toBe(1);
  });

  it("rolls back state, snapshot, instructions, audit and outbox together when freeze fails (criterion 16)", async () => {
    const g = await createGroup();
    const entry = await ownerPaysForAll(g);
    // Corrupt the ledger so the zero-sum invariant fails inside the freeze transaction.
    await sql(g, "UPDATE allocations SET base_amount = '1' WHERE entry_id = ? AND member_id = ?", entry.id, g.owner.memberId);
    const count = async () =>
      (
        await sql<{ a: number; o: number; s: number; i: number }>(
          g,
          `SELECT (SELECT COUNT(*) FROM audit_events) AS a, (SELECT COUNT(*) FROM outbox) AS o,
                  (SELECT COUNT(*) FROM settlement_snapshots) AS s, (SELECT COUNT(*) FROM instructions) AS i`,
        )
      )[0]!;
    const before = await count();
    const { review_version } = (await sql<{ review_version: number }>(g, "SELECT review_version FROM rounds"))[0]!;
    const res = await g.owner.call("freeze", { roundId: g.roundId }, {
      expectedReviewVersion: review_version,
      acknowledgeNotReady: [g.owner.memberId, g.members[0]!.memberId],
    });
    expect(await errorCode(res)).toMatchObject({ status: 500, code: "INTERNAL" });
    const round = (await sql<{ status: string; review_version: number }>(g, "SELECT status, review_version FROM rounds"))[0]!;
    expect(round.status).toBe("COLLECTING");
    expect(await count()).toEqual(before);
  });
});

describe("settlement instructions (criteria 17–20)", () => {
  it("confirming one transfer leaves the others untouched and settles atomically at the end", async () => {
    const g = await createGroup({ members: 3 });
    await ownerPaysForAll(g);
    const frozen = await freezeNow(g);
    expect(frozen.instructions).toHaveLength(3);
    const [first, ...rest] = frozen.instructions;
    const sender = g.members.find((m) => m.memberId === first!.fromMemberId)!;
    await sender.ok("markSent", { roundId: g.roundId, instructionId: first!.id });
    const confirmed = await g.owner.ok<InstructionResultDTO>("markReceived", { roundId: g.roundId, instructionId: first!.id });
    expect(confirmed.instruction.state).toBe("CONFIRMED");
    expect(confirmed.round.status).toBe("SETTLING");

    const view = await g.owner.ok<RoundViewDTO>("getRound", { roundId: g.roundId }, null, null);
    expect(view.instructions.slice(1)).toEqual(rest);
    const senderBalance = view.balances.find((b) => b.memberId === sender.memberId)!;
    expect(senderBalance).toMatchObject({ net: "-1000", confirmedProgress: "-1000", remaining: "0" });

    let last: InstructionResultDTO | undefined;
    for (const i of rest) {
      const from = g.members.find((m) => m.memberId === i.fromMemberId)!;
      await from.ok("markSent", { roundId: g.roundId, instructionId: i.id });
      last = await g.owner.ok<InstructionResultDTO>("markReceived", { roundId: g.roundId, instructionId: i.id });
    }
    expect(last!.round.status).toBe("SETTLED");
    const project = (await g.owner.view()).project;
    expect(project.activeRoundId).toBeNull();
  });

  it("enforces roles and transitions; duplicate actions produce one confirmed transfer (criterion 18)", async () => {
    const g = await createGroup({ members: 2 });
    const [bob, carol] = g.members as [Client, Client];
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, bob.memberId], "2000"));
    const { instructions } = await freezeNow(g);
    const i = instructions[0]!;
    expect(i).toMatchObject({ fromMemberId: bob.memberId, toMemberId: g.owner.memberId, state: "PROPOSED" });

    expect((await errorCode(act(g.owner, "markSent", g, i.id))).status).toBe(403);
    expect((await errorCode(act(carol, "markSent", g, i.id))).status).toBe(403);
    expect((await errorCode(act(bob, "markReceived", g, i.id))).status).toBe(403);
    expect(await errorCode(act(g.owner, "markReceived", g, i.id))).toMatchObject({ status: 409, code: "INVALID_TRANSITION" });
    expect(await errorCode(act(g.owner, "markDisputed", g, i.id))).toMatchObject({ status: 409, code: "INVALID_TRANSITION" });

    const sent = await Promise.all([act(bob, "markSent", g, i.id), act(bob, "markSent", g, i.id)]);
    expect(sent.map((r) => (r.body as InstructionResultDTO).instruction.revision)).toEqual([2, 2]);
    const received = await Promise.all([act(g.owner, "markReceived", g, i.id), act(g.owner, "markReceived", g, i.id)]);
    expect(received.every((r) => r.status === 200)).toBe(true);
    expect((received[0]!.body as InstructionResultDTO).round.status).toBe("SETTLED");
    expect(await errorCode(act(bob, "markSent", g, i.id))).toMatchObject({ code: "INVALID_TRANSITION" });
    const transfers = await sql<{ n: number }>(g, "SELECT COUNT(*) AS n FROM confirmed_transfers WHERE instruction_id = ?", i.id);
    expect(transfers[0]!.n).toBe(1);
    expect((await errorCode(act(bob, "markSent", g, "i_unknown"))).status).toBe(404);
  });

  it("a dispute blocks completion until the recipient confirms (criterion 19)", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    await ownerPaysForAll(g);
    const { instructions } = await freezeNow(g);
    const i = instructions[0]!;
    await bob.ok("markSent", { roundId: g.roundId, instructionId: i.id });
    const disputed = await g.owner.ok<InstructionResultDTO>("markDisputed", { roundId: g.roundId, instructionId: i.id }, { note: "Nothing arrived" });
    expect(disputed.instruction).toMatchObject({ state: "DISPUTED", disputeNote: "Nothing arrived" });
    expect(disputed.round.status).toBe("SETTLING");
    const resent = await bob.ok<InstructionResultDTO>("markSent", { roundId: g.roundId, instructionId: i.id });
    expect(resent.instruction.state).toBe("SENT");
    expect(resent.round.status).toBe("SETTLING");
    const done = await g.owner.ok<InstructionResultDTO>("markReceived", { roundId: g.roundId, instructionId: i.id });
    expect(done.round.status).toBe("SETTLED");
  });

  it("settles a zero-balance round in the freeze transaction (criterion 20)", async () => {
    const empty = await createGroup();
    const res = await freezeNow(empty);
    expect(res.round.status).toBe("SETTLED");
    expect(res.instructions).toEqual([]);

    const g = await createGroup();
    const bob = g.members[0]!;
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId], "500"));
    await bob.ok("createEntry", { roundId: g.roundId }, expense(bob.memberId, [bob.memberId], "700"));
    const r = await freezeNow(g);
    expect(r.round).toMatchObject({ status: "SETTLED" });
    expect(r.round.settledAt).toBe(r.round.frozenAt);
    const history = await g.owner.ok<HistoryDTO>("getHistory", {}, null, null);
    expect(history.events.map((e) => e.action)).toContain("ROUND_SETTLED");
  });
});

describe("corrections and history (criterion 21)", () => {
  it("needs a new owner-created round; previous snapshots stay byte-for-byte unchanged", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    const entry = await ownerPaysForAll(g);
    const { instructions } = await freezeNow(g);
    await bob.ok("markSent", { roundId: g.roundId, instructionId: instructions[0]!.id });
    await g.owner.ok("markReceived", { roundId: g.roundId, instructionId: instructions[0]!.id });

    const round1 = g.roundId;
    const snapshotRow = async () => (await sql(g, "SELECT * FROM settlement_snapshots WHERE round_id = ?", round1))[0];
    const before = JSON.stringify(await g.owner.ok<RoundViewDTO>("getRound", { roundId: round1 }, null, null));
    const snapBefore = JSON.stringify(await snapshotRow());

    expect((await errorCode(bob.call("startRound"))).status).toBe(403);
    expect((await errorCode(bob.call("createEntry", { roundId: round1 }, expense(bob.memberId, [bob.memberId], "1")))).code).toBe(
      "ROUND_NOT_COLLECTING",
    );
    const round2 = await g.owner.ok<RoundDTO>("startRound");
    expect(round2).toMatchObject({ sequence: 2, status: "COLLECTING" });
    expect((await errorCode(g.owner.call("startRound"))).code).toBe("INVALID_TRANSITION");
    g.roundId = round2.id;

    const adj = {
      correctedEntryId: entry.id,
      correctedRoundId: round1,
      description: "Bob's share was wrong",
      occurredAt: "2026-10-02",
      effects: [
        { memberId: g.owner.memberId, baseAmount: "-300" },
        { memberId: bob.memberId, baseAmount: "300" },
      ],
    };
    expect((await errorCode(bob.call("createAdjustment", { roundId: round2.id }, adj))).status).toBe(403);
    expect(
      await errorCode(
        g.owner.call("createAdjustment", { roundId: round2.id }, { ...adj, effects: [adj.effects[0], { ...adj.effects[1], baseAmount: "200" }] }),
      ),
    ).toMatchObject({ status: 422, field: "effects" });
    expect((await errorCode(g.owner.call("createAdjustment", { roundId: round2.id }, { ...adj, correctedRoundId: round2.id }))).field).toBe(
      "correctedRoundId",
    );
    const created = await g.owner.ok<EntryDTO>("createAdjustment", { roundId: round2.id }, adj);
    expect(created).toMatchObject({ type: "ADJUSTMENT", correctedEntryId: entry.id, correctedRoundId: round1, baseAmount: "300" });
    await bob.ok("createEntry", { roundId: round2.id }, expense(bob.memberId, [bob.memberId, g.owner.memberId], "100"));

    const view = await g.owner.view();
    expect(view.current.round.id).toBe(round2.id);
    // Round 2 contains only its own facts: the adjustment and the late expense.
    const nets = Object.fromEntries(view.current.balances.map((b) => [b.memberId, b.net]));
    expect(nets).toEqual({ [g.owner.memberId]: "-350", [bob.memberId]: "350" });
    expect(view.current.totals).toEqual({ expenses: "100", refunds: "0", adjustments: "300" });
    expect(view.rounds.map((r) => r.sequence)).toEqual([2, 1]);

    const after = JSON.stringify(await g.owner.ok<RoundViewDTO>("getRound", { roundId: round1 }, null, null));
    expect(after).toBe(before);
    expect(JSON.stringify(await snapshotRow())).toBe(snapBefore);
  });
});

describe("export, backup and outbox", () => {
  it("exports quoted, formula-safe UTF-8 CSV with both currencies, only to members", async () => {
    const g = await createGroup({ multiCurrencyEnabled: true });
    const bob = g.members[0]!;
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId, bob.memberId], "10000", {
      description: '=HYPERLINK("x") "quoted"',
      originalCurrency: "EUR",
      conversion: { method: "MANUAL_RATE", rate: "4.3" },
    }));
    const res = await bob.call("exportCsv", {}, null, null);
    expect(res.status).toBe(200);
    expect(res.headers?.["content-type"]).toBe("text/csv; charset=utf-8");
    const csv = res.body as string;
    expect(csv.startsWith("﻿\"record_type\"")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"") ""quoted"""`);
    expect(csv).toContain(`"100.00","EUR","430.00","PLN","MANUAL_RATE","4.3","ENTRY_OVERRIDE"`);
    expect(csv).toContain(g.roundId);
    expect(csv).toContain("215.00 PLN (50.00 EUR)");
    const stranger = new Client(g.stub, g.projectId, { ...bob.principal!, principalId: "pr_stranger" });
    expect((await errorCode(stranger.call("exportCsv", {}, null, null))).status).toBe(404);
  });

  it("dumps every table for internal backups only", async () => {
    const g = await createGroup();
    await ownerPaysForAll(g);
    expect((await errorCode(g.owner.call("backupSnapshot", {}, null, null))).status).toBe(403);
    const res = await new Client(g.stub, g.projectId, null).call("backupSnapshot", {}, null, null);
    expect(res.status).toBe(200);
    const body = res.body as { projectId: string; tables: Record<string, unknown[]> };
    expect(body.projectId).toBe(g.projectId);
    expect(body.tables.entries).toHaveLength(1);
    expect(body.tables.members).toHaveLength(2);
    expect(body.tables).not.toHaveProperty("idempotency");
  });

  it("writes outbox rows with the change and publishes them from the alarm, retrying on failure (criterion 23)", async () => {
    const g = await createGroup();
    await ownerPaysForAll(g);
    // Make publication fail: settlement must still commit.
    await runInDurableObject(g.stub, (instance) => {
      (instance as any).env = { ...(instance as any).env, EVENTS: { sendBatch: async () => { throw new Error("queue down"); } } };
    });
    const frozen = await freezeNow(g);
    expect(frozen.round.status).toBe("SETTLING");
    await runDurableObjectAlarm(g.stub);
    const rows = await sql<{ type: string; message_json: string; sent_at: string | null; attempts: number; last_error: string | null }>(
      g,
      "SELECT type, message_json, sent_at, attempts, last_error FROM outbox ORDER BY seq",
    );
    const messages = rows.map((r) => JSON.parse(r.message_json) as OutboxMessage);
    const notify = messages.find((m) => m.type === "NOTIFY" && m.payload.kind === "ROUND_FROZEN");
    expect(notify).toBeDefined();
    expect((notify as any).payload.principalIds.sort()).toEqual([g.owner.principal!.principalId, g.members[0]!.principal!.principalId].sort());
    const directory = messages.filter((m) => m.type === "DIRECTORY_UPSERT").at(-1) as Extract<OutboxMessage, { type: "DIRECTORY_UPSERT" }>;
    expect(directory.payload.roundStatus).toBe("SETTLING");
    const bobRow = directory.payload.members.find((m) => m.memberId === g.members[0]!.memberId)!;
    expect(bobRow.nextAction).toBe("SEND_MONEY");
    const versions = messages.map((m) => m.projectVersion);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    const pendingFailed = rows.filter((r) => !r.sent_at);
    expect(pendingFailed.length).toBeGreaterThan(0);
    expect(pendingFailed.every((r) => r.attempts >= 1 && r.last_error?.includes("queue down"))).toBe(true);

    // Queue recovers: the next alarm publishes everything.
    const published: unknown[] = [];
    await runInDurableObject(g.stub, async (instance, state) => {
      (instance as any).env = { ...(instance as any).env, EVENTS: { sendBatch: async (batch: unknown[]) => void published.push(...batch) } };
      state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0 WHERE sent_at IS NULL");
      await instance.alarm!();
    });
    expect(published.length).toBe(pendingFailed.length);
    const left = await sql<{ n: number }>(g, "SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL");
    expect(left[0]!.n).toBe(0);
  });
});
