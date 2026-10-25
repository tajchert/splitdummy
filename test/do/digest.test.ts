import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryDTO, ProjectViewDTO } from "@shared/api";
import { DIGEST_DEBOUNCE_MS, DIGEST_MAX_WAIT_MS } from "../../worker/do/ops/digest";
import type { OutboxMessage } from "../../worker/do/types";
import { createGroup, expense, sqlIn, type Client, type Group } from "./helpers";

type Notify = Extract<OutboxMessage, { type: "NOTIFY" }>;

const getAlarm = (g: Group) => runInDurableObject(g.stub, (_i, state) => state.storage.getAlarm());
const digests = async (g: Group) =>
  (await sqlIn<{ message_json: string }>(g.stub, "SELECT message_json FROM outbox WHERE type = 'NOTIFY' ORDER BY seq"))
    .map((r) => JSON.parse(r.message_json) as Notify)
    .filter((m) => m.payload.kind === "EXPENSES_ADDED");
const pending = async (g: Group) => (await sqlIn<{ n: number }>(g.stub, "SELECT COUNT(*) AS n FROM expense_digest"))[0]!.n;

function add(g: Group, by: Client, description: string, amount = "1000") {
  const ids = [g.owner.memberId, ...g.members.map((m) => m.memberId)];
  return by.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(by.memberId, ids, amount, { description }));
}

/** Pretends every queued entry was added `ms` earlier. */
const age = (g: Group, ms: number) => sqlIn(g.stub, "UPDATE expense_digest SET added_at = added_at - ?", ms);

describe("expense digest", () => {
  it("waits an hour after the last addition, then sends one grouped notification per distinct list", async () => {
    const g = await createGroup({ members: 2 });
    const [bob, carol] = g.members as [Client, Client];
    await add(g, g.owner, "Hotel", "40000");
    await add(g, bob, "Dinner", "12050");
    await add(g, bob, "Taxi");
    await runDurableObjectAlarm(g.stub); // publishes the directory rows; the digest isn't due yet
    expect(await digests(g)).toEqual([]);
    expect(await pending(g)).toBe(3);

    const [row] = await sqlIn<{ last: number }>(g.stub, "SELECT MAX(added_at) AS last FROM expense_digest");
    expect(await getAlarm(g)).toBe(Number(row!.last) + DIGEST_DEBOUNCE_MS);

    const before = (await g.owner.ok<ProjectViewDTO>("getProject", {}, null, null)).project.version;
    await age(g, DIGEST_DEBOUNCE_MS);
    await runDurableObjectAlarm(g.stub);
    const sent = await digests(g);
    const to = (c: Client) => sent.find((m) => m.payload.principalIds.includes(c.principal!.principalId))!;

    // Alice hears about Bob's two, Bob about Alice's one, Carol (added nothing) about all three.
    expect(sent).toHaveLength(3);
    expect(to(g.owner).payload).toMatchObject({
      summary: "2 new expenses in “Trip”",
      lines: ["Bob added “Dinner” · 120.50 PLN", "Bob added “Taxi” · 10.00 PLN"],
    });
    expect(to(bob).payload).toMatchObject({ summary: "1 new expense in “Trip”", lines: ["Alice added “Hotel” · 400.00 PLN"] });
    expect(to(carol).payload.lines).toHaveLength(3);
    expect(await pending(g)).toBe(0);
    expect((await g.owner.ok<ProjectViewDTO>("getProject", {}, null, null)).project.version).toBe(before);

    // Nothing queued: another alarm sends nothing new.
    await runDurableObjectAlarm(g.stub);
    expect(await digests(g)).toHaveLength(3);
  });

  it("members who'd get the same list share one notification", async () => {
    const g = await createGroup({ members: 2 });
    await add(g, g.owner, "Hotel");
    await age(g, DIGEST_DEBOUNCE_MS);
    await runDurableObjectAlarm(g.stub);
    const sent = await digests(g);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.principalIds.sort()).toEqual(g.members.map((m) => m.principal!.principalId).sort());
  });

  it("a new addition pushes the digest back, but never past the max wait", async () => {
    const g = await createGroup();
    await add(g, g.owner, "Hotel");
    await age(g, DIGEST_DEBOUNCE_MS - 60_000);
    await add(g, g.owner, "Dinner");
    await runDurableObjectAlarm(g.stub);
    expect(await digests(g)).toEqual([]);

    // Keep adding past the max wait: the oldest entry forces the send.
    await age(g, DIGEST_MAX_WAIT_MS - DIGEST_DEBOUNCE_MS + 60_000);
    await add(g, g.owner, "Taxi");
    await runDurableObjectAlarm(g.stub);
    const sent = await digests(g);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.summary).toBe("3 new expenses in “Trip”");
  });

  it("leaves out entries deleted before the digest and sends nothing when none remain", async () => {
    const g = await createGroup();
    const entry = await add(g, g.owner, "Hotel");
    await g.owner.ok("deleteEntry", { roundId: g.roundId, entryId: entry.id }, { expectedRevision: entry.revision });
    await age(g, DIGEST_DEBOUNCE_MS);
    await runDurableObjectAlarm(g.stub);
    expect(await digests(g)).toEqual([]);
    expect(await pending(g)).toBe(0);
  });
});
