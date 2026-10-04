import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryDTO, FreezeResultDTO, HistoryDTO, ProjectViewDTO, ReviewDTO, RoundDTO } from "@shared/api";
import type { OutboxMessage } from "../../worker/do/types";
import { localDate, nextDate, startOfDay } from "../../worker/do/tz";
import { createGroup, errorCode, expense, freezeNow, listen, sqlIn, waitFor, type Group } from "./helpers";

const ZONE = "Europe/Warsaw";
const today = (zone = ZONE) => localDate(Date.now(), zone);
const schedule = (g: Group, date: string | null, timeZone = ZONE, client = g.owner) =>
  client.call("setFreezeSchedule", { roundId: g.roundId }, { date, timeZone });
const getAlarm = (g: Group) => runInDurableObject(g.stub, (_i, state) => state.storage.getAlarm());
const history = (g: Group) => g.owner.ok<HistoryDTO>("getHistory", {}, null, null);

async function ownerPaysForAll(g: Group) {
  const ids = [g.owner.memberId, ...g.members.map((m) => m.memberId)];
  return g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, ids, String(1000 * ids.length)));
}

/** Publishes pending outbox rows so the alarm reflects only the schedule. */
async function flushOutbox(g: Group) {
  await runDurableObjectAlarm(g.stub);
}

/** Moves the scheduled instant into the past (the alarm itself still points at the original time). */
const makeDue = (g: Group) =>
  sqlIn(g.stub, "UPDATE rounds SET scheduled_freeze_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), g.roundId);

describe("freeze schedule", () => {
  it("validates owner, round state, zone and date (field errors)", async () => {
    const g = await createGroup();
    expect((await errorCode(schedule(g, today(), ZONE, g.members[0]))).status).toBe(403);
    expect(await errorCode(schedule(g, today(), "Mars/Olympus_Mons"))).toMatchObject({ status: 422, code: "VALIDATION", field: "timeZone" });
    expect(await errorCode(schedule(g, "2020-01-01"))).toMatchObject({ status: 422, code: "VALIDATION", field: "date" });
    expect(await errorCode(schedule(g, "2027-02-30"))).toMatchObject({ status: 422, field: "date" });
    // "Today" is judged in the given zone: yesterday there is rejected.
    const kiritimatiToday = today("Pacific/Kiritimati");
    const [y, m, d] = kiritimatiToday.split("-").map(Number) as [number, number, number];
    const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
    expect(await errorCode(schedule(g, yesterday, "Pacific/Kiritimati"))).toMatchObject({ status: 422, field: "date" });
    expect((await errorCode(g.owner.call("setFreezeSchedule", { roundId: "r_missing" }, { date: today(), timeZone: ZONE }))).status).toBe(404);

    await freezeNow(g);
    expect(await errorCode(schedule(g, today()))).toMatchObject({ status: 409, code: "ROUND_NOT_COLLECTING" });
  });

  it("stores date, canonical zone and the DST-correct instant; audits, bumps the project version only, arms the alarm", async () => {
    const g = await createGroup();
    await ownerPaysForAll(g);
    await flushOutbox(g);
    const before = await g.owner.view();
    const live = await listen(g.stub, g.members[0]!.principal);

    // 2027-03-27 ends when Warsaw springs forward: the next day starts at 23:00Z (CET), not 22:00Z.
    const round = (await schedule(g, "2027-03-27", "europe/warsaw")).body as RoundDTO;
    expect(round).toMatchObject({
      scheduledFreezeDate: "2027-03-27",
      scheduledFreezeTimeZone: "Europe/Warsaw",
      scheduledFreezeAt: "2027-03-27T23:00:00.000Z",
      frozenBySchedule: false,
      status: "COLLECTING",
    });
    expect(round.reviewVersion).toBe(before.current.round.reviewVersion);
    expect(round.ledgerVersion).toBe(before.current.round.ledgerVersion);
    const after = await g.owner.view();
    expect(after.project.version).toBe(before.project.version + 1);
    expect(after.current.round.scheduledFreezeAt).toBe("2027-03-27T23:00:00.000Z");
    expect(await getAlarm(g)).toBe(Date.parse("2027-03-27T23:00:00.000Z"));
    await waitFor(() => live.messages.some((m) => m.type === "changed" && m.reason === "setFreezeSchedule"));
    live.ws.close();

    const moved = (await schedule(g, "2027-03-28")).body as RoundDTO;
    expect(moved.scheduledFreezeAt).toBe("2027-03-28T22:00:00.000Z");
    expect(await getAlarm(g)).toBe(Date.parse("2027-03-28T22:00:00.000Z"));

    const events = (await history(g)).events;
    const scheduled = events.filter((e) => e.action === "FREEZE_SCHEDULED");
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]!.details).toMatchObject({ date: "2027-03-28", timeZone: "Europe/Warsaw", previousDate: "2027-03-27" });

    const cleared = (await schedule(g, null)).body as RoundDTO;
    expect(cleared).toMatchObject({ scheduledFreezeDate: null, scheduledFreezeTimeZone: null, scheduledFreezeAt: null });
    expect((await history(g)).events[0]).toMatchObject({ action: "FREEZE_SCHEDULE_CLEARED", roundId: g.roundId });
    expect(await getAlarm(g)).toBeNull();
    // Clearing again is a no-op.
    const version = (await g.owner.view()).project.version;
    await schedule(g, null);
    expect((await g.owner.view()).project.version).toBe(version);
  });

  it("accepts today in the owner's zone and freezes at the start of tomorrow there", async () => {
    const g = await createGroup();
    const date = today("Pacific/Kiritimati");
    const round = (await schedule(g, date, "Pacific/Kiritimati")).body as RoundDTO;
    expect(round.scheduledFreezeAt).toBe(new Date(startOfDay(nextDate(date), "Pacific/Kiritimati")).toISOString());
  });

  it("auto-freezes from the alarm like an owner freeze, recording who wasn't ready; a second alarm is a no-op", async () => {
    const g = await createGroup({ members: 2 });
    const [bob, carol] = g.members;
    await ownerPaysForAll(g);
    await bob!.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    await schedule(g, today());
    const live = await listen(g.stub, carol!.principal);

    // Not due yet: the alarm fires (e.g. for the outbox) but nothing freezes.
    await runInDurableObject(g.stub, (instance) => instance.alarm!());
    expect((await g.owner.view()).current.round.status).toBe("COLLECTING");

    await makeDue(g);
    expect(await runDurableObjectAlarm(g.stub)).toBe(true);
    const view = await g.owner.view();
    expect(view.current.round).toMatchObject({
      status: "SETTLING",
      frozenBySchedule: true,
      frozenByMemberId: g.owner.memberId,
      earlyFreezeReason: "Scheduled freeze date reached",
      scheduledFreezeDate: today(),
    });
    expect(view.current.instructions).toHaveLength(2);

    const frozen = (await history(g)).events.filter((e) => e.action === "ROUND_FROZEN");
    expect(frozen).toHaveLength(1);
    expect(frozen[0]!.details).toMatchObject({ scheduled: true, earlyFreezeReason: "Scheduled freeze date reached" });
    expect((frozen[0]!.details!.acknowledgedNotReady as string[]).sort()).toEqual([g.owner.memberId, carol!.memberId].sort());

    const outbox = await sqlIn<{ message_json: string }>(g.stub, "SELECT message_json FROM outbox");
    const notify = outbox.map((r) => JSON.parse(r.message_json) as OutboxMessage).find((m) => m.type === "NOTIFY" && m.payload.kind === "ROUND_FROZEN");
    expect(notify).toBeDefined();
    await waitFor(() => live.messages.some((m) => m.type === "changed" && m.reason === "freeze" && m.roundId === g.roundId));
    live.ws.close();

    // Fired twice (or late): nothing changes.
    await runInDurableObject(g.stub, (instance) => instance.alarm!());
    const again = await g.owner.view();
    expect(again.project.version).toBe(view.project.version);
    expect((await history(g)).events.filter((e) => e.action === "ROUND_FROZEN")).toHaveLength(1);
  });

  it("auto-freeze with everyone ready records no reason", async () => {
    const g = await createGroup();
    await ownerPaysForAll(g);
    for (const c of [g.owner, ...g.members]) await c.ok("setReadiness", { roundId: g.roundId }, { ready: true });
    await schedule(g, today());
    await makeDue(g);
    await runDurableObjectAlarm(g.stub);
    expect((await g.owner.view()).current.round).toMatchObject({ status: "SETTLING", frozenBySchedule: true, earlyFreezeReason: null });
  });

  it("auto-freeze of an empty round settles it immediately", async () => {
    const g = await createGroup();
    await schedule(g, today());
    await makeDue(g);
    await runDurableObjectAlarm(g.stub);
    const view = await g.owner.view();
    expect(view.project.activeRoundId).toBeNull();
    expect(view.rounds[0]).toMatchObject({ status: "SETTLED", frozenBySchedule: true });
  });

  it("a manual freeze clears the schedule; a new round starts without one", async () => {
    const g = await createGroup();
    await schedule(g, today());
    const res = await freezeNow(g);
    expect(res.round).toMatchObject({ status: "SETTLED", scheduledFreezeDate: null, scheduledFreezeAt: null, frozenBySchedule: false });
    await makeDue(g);
    await runInDurableObject(g.stub, (instance) => instance.alarm!());
    const next = await g.owner.ok<RoundDTO>("startRound");
    expect(next).toMatchObject({ status: "COLLECTING", scheduledFreezeDate: null, scheduledFreezeTimeZone: null, scheduledFreezeAt: null, frozenBySchedule: false });
    const history2 = await history(g);
    expect(history2.events.filter((e) => e.action === "ROUND_FROZEN")).toHaveLength(1);
  });

  it("a schedule doesn't change the review version, so an open review stays valid", async () => {
    const g = await createGroup();
    await ownerPaysForAll(g);
    const review = await g.owner.ok<ReviewDTO>("getReview", { roundId: g.roundId }, null, null);
    await schedule(g, today());
    const res = await g.owner.ok<FreezeResultDTO>("freeze", { roundId: g.roundId }, {
      expectedReviewVersion: review.reviewVersion,
      acknowledgeNotReady: review.notReadyMemberIds,
    });
    expect(res.round.status).toBe("SETTLING");
  });
});

describe("owner freeze reason is optional", () => {
  it("freezes with not-ready members acknowledged and no reason", async () => {
    const g = await createGroup({ members: 2 });
    await ownerPaysForAll(g);
    const review = await g.owner.ok<ReviewDTO>("getReview", { roundId: g.roundId }, null, null);
    expect(review.notReadyMemberIds).toHaveLength(3);
    const res = await g.owner.ok<FreezeResultDTO>("freeze", { roundId: g.roundId }, {
      expectedReviewVersion: review.reviewVersion,
      acknowledgeNotReady: review.notReadyMemberIds,
    });
    expect(res.round).toMatchObject({ status: "SETTLING", earlyFreezeReason: null, frozenBySchedule: false });
    const view: ProjectViewDTO = await g.owner.view();
    expect(view.current.round.earlyFreezeReason).toBeNull();
  });
});
