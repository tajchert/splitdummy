import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AttachmentDTO, AuditEventDTO, EntryDTO, HistoryDTO, RoundViewDTO } from "@shared/api";
import { Client, createGroup, errorCode, expense, freezeNow, sqlIn, type Group } from "./helpers";

describe("entry note and photos: read path", () => {
  it("exposes note null and no attachments on a new entry", async () => {
    const g = await createGroup();
    const e = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId], "1000"));
    expect(e.note).toBeNull();
    expect(e.attachments).toEqual([]);
    expect((await g.owner.view()).current.entries[0]).toMatchObject({ note: null, attachments: [] });
  });

  it("fills defaults for frozen-round snapshots written before photos existed", async () => {
    const g = await createGroup();
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId], "1000"));
    await freezeNow(g, "test");
    await runInDurableObject(g.stub, (_i, state) => {
      for (const row of state.storage.sql.exec<{ round_id: string; snapshot_json: string }>("SELECT round_id, snapshot_json FROM settlement_snapshots").toArray()) {
        const snap = JSON.parse(row.snapshot_json);
        for (const e of snap.entries) {
          delete e.note;
          delete e.attachments;
        }
        state.storage.sql.exec("UPDATE settlement_snapshots SET snapshot_json = ? WHERE round_id = ?", JSON.stringify(snap), row.round_id);
      }
    });
    const round = await g.owner.ok<RoundViewDTO>("getRound", { roundId: g.roundId }, null, null);
    expect(round.entries[0]).toMatchObject({ note: null, attachments: [] });
  });
});

describe("entry note", () => {
  it("stores a trimmed note on create; empty becomes null", async () => {
    const g = await createGroup();
    const a = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId], "1000", { note: "  Tip included  " }));
    expect(a.note).toBe("Tip included");
    const b = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId], "1000", { note: "   " }));
    expect(b.note).toBeNull();
  });

  it("keeps the note when an update omits it, clears it with null, and audits the change", async () => {
    const g = await createGroup();
    const body = expense(g.owner.memberId, [g.owner.memberId], "1000");
    const e = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, { ...body, note: "Cash" });
    const kept = await g.owner.ok<EntryDTO>("updateEntry", { roundId: g.roundId, entryId: e.id }, { ...body, expectedRevision: 1 });
    expect(kept.note).toBe("Cash");
    const changed = await g.owner.ok<EntryDTO>("updateEntry", { roundId: g.roundId, entryId: e.id }, { ...body, note: "Card", expectedRevision: 2 });
    expect(changed.note).toBe("Card");
    const cleared = await g.owner.ok<EntryDTO>("updateEntry", { roundId: g.roundId, entryId: e.id }, { ...body, note: null, expectedRevision: 3 });
    expect(cleared.note).toBeNull();

    const history = await g.owner.ok<HistoryDTO>("getHistory", {}, null, null);
    const edits = history.events.filter((x: AuditEventDTO) => x.action === "ENTRY_UPDATED" && x.entityId === e.id).map((x) => x.summary);
    expect(edits.some((s) => s.endsWith("· changed the note"))).toBe(true);
    expect(edits.some((s) => s.endsWith("· removed the note"))).toBe(true);
    expect(edits.filter((s) => s.includes("·"))).toHaveLength(2);
  });

  it("exports note and photo_count columns", async () => {
    const g = await createGroup();
    await g.owner.ok("createEntry", { roundId: g.roundId }, expense(g.owner.memberId, [g.owner.memberId], "1000", { note: "=SUM(A1)" }));
    const csv = (await g.owner.call("exportCsv", {}, null, null)).body as string;
    const [header, row] = csv.replace(/^\uFEFF/, "").split("\r\n");
    expect(header!.endsWith('"note","photo_count"')).toBe(true);
    expect(row!.endsWith(`"'=SUM(A1)","0"`)).toBe(true);
  });
});

const meta = { contentType: "image/webp", bytes: 1234, width: 1600, height: 1200, sha256: "a".repeat(64) };
const upload = (c: Client) => c.ok<AttachmentDTO>("registerAttachment", {}, meta);
/** The edge cron's view of the DO: no principal. */
const internal = (g: Group) => new Client(g.stub, g.projectId, null);

describe("photo upload registration", () => {
  it("registers a pending photo visible only to its uploader", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    const a = await upload(g.owner);
    expect(a).toEqual({ id: expect.stringMatching(/^att_/), contentType: "image/webp", bytes: 1234, width: 1600, height: 1200 });
    expect((await g.owner.call("readAttachment", { attachmentId: a.id }, null, null)).status).toBe(200);
    expect((await bob.call("readAttachment", { attachmentId: a.id }, null, null)).status).toBe(404);
    // Pending uploads are private: no project version bump.
    const before = (await g.owner.view()).project.version;
    await upload(g.owner);
    expect((await g.owner.view()).project.version).toBe(before);
  });

  it("replays the same id for the same idempotency key", async () => {
    const g = await createGroup();
    const key = crypto.randomUUID();
    const a = await g.owner.ok<AttachmentDTO>("registerAttachment", {}, meta, key);
    const b = await g.owner.ok<AttachmentDTO>("registerAttachment", {}, meta, key);
    expect(b.id).toBe(a.id);
  });

  it("validates metadata, requires a collecting round and caps pending uploads", async () => {
    const g = await createGroup();
    expect(await errorCode(g.owner.call("registerAttachment", {}, { ...meta, contentType: "image/png" }))).toMatchObject({ status: 422 });
    expect(await errorCode(g.owner.call("registerAttachment", {}, { ...meta, width: 5000 }))).toMatchObject({ status: 422 });
    for (let i = 0; i < 20; i++) await upload(g.owner);
    expect(await errorCode(g.owner.call("registerAttachment", {}, meta))).toMatchObject({ code: "LIMIT_EXCEEDED" });
    await freezeNow(g, "test");
    expect(await errorCode(g.members[0]!.call("registerAttachment", {}, meta))).toMatchObject({ status: 409, code: "ROUND_NOT_COLLECTING" });
  });

  it("is not available to non-members", async () => {
    const g = await createGroup();
    const stranger = new Client(g.stub, g.projectId, { principalId: "pr_stranger", kind: "ACCOUNT", email: null, hasRecoverableAccount: true });
    expect((await stranger.call("registerAttachment", {}, meta)).status).toBe(404);
  });
});

describe("linking photos to entries", () => {
  const body = (g: Group, extra: Record<string, unknown> = {}) => expense(g.owner.memberId, [g.owner.memberId], "1000", extra);

  it("links own pending photos in order and shows them to every member", async () => {
    const g = await createGroup();
    const [a, b] = [await upload(g.owner), await upload(g.owner)];
    const e = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, body(g, { attachmentIds: [b.id, a.id] }));
    expect(e.attachments.map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await g.members[0]!.call("readAttachment", { attachmentId: a.id }, null, null)).status).toBe(200);
  });

  it("rejects someone else's pending photo, unknown ids and photos linked elsewhere, with the index in the field", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    const mine = await upload(g.owner);
    const bobs = await upload(bob);
    expect(await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, body(g, { attachmentIds: [mine.id, bobs.id] })))).toMatchObject({
      status: 422,
      code: "VALIDATION",
      field: "attachmentIds.1",
    });
    expect(await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, body(g, { attachmentIds: ["att_nope"] })))).toMatchObject({ field: "attachmentIds.0" });
    await g.owner.ok("createEntry", { roundId: g.roundId }, body(g, { attachmentIds: [mine.id] }));
    expect(await errorCode(g.owner.call("createEntry", { roundId: g.roundId }, body(g, { attachmentIds: [mine.id] })))).toMatchObject({ field: "attachmentIds.0" });
  });

  it("keeps photos when an update omits them, reorders, and trashes removed ones", async () => {
    const g = await createGroup();
    const [a, b, c] = [await upload(g.owner), await upload(g.owner), await upload(g.owner)];
    const e = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, body(g, { attachmentIds: [a.id, b.id] }));
    const kept = await g.owner.ok<EntryDTO>("updateEntry", { roundId: g.roundId, entryId: e.id }, { ...body(g), expectedRevision: 1 });
    expect(kept.attachments.map((x) => x.id)).toEqual([a.id, b.id]);
    const changed = await g.owner.ok<EntryDTO>("updateEntry", { roundId: g.roundId, entryId: e.id }, { ...body(g, { attachmentIds: [c.id, b.id] }), expectedRevision: 2 });
    expect(changed.attachments.map((x) => x.id)).toEqual([c.id, b.id]);
    expect(await sqlIn(g.stub, "SELECT attachment_id FROM attachment_trash")).toEqual([{ attachment_id: a.id }]);
    const history = await g.owner.ok<HistoryDTO>("getHistory", {}, null, null);
    expect(history.events.find((x) => x.action === "ENTRY_UPDATED" && x.entityId === e.id)?.summary).toMatch(/· added a photo · removed a photo$/);
    const cleared = await g.owner.ok<EntryDTO>("updateEntry", { roundId: g.roundId, entryId: e.id }, { ...body(g, { attachmentIds: [] }), expectedRevision: 3 });
    expect(cleared.attachments).toEqual([]);
  });

  it("lets the owner add photos to a member's entry; the member keeps it", async () => {
    const g = await createGroup();
    const bob = g.members[0]!;
    const e = await bob.ok<EntryDTO>("createEntry", { roundId: g.roundId }, expense(bob.memberId, [bob.memberId], "500"));
    const ownerPhoto = await upload(g.owner);
    const edited = await g.owner.ok<EntryDTO>("updateEntry", { roundId: g.roundId, entryId: e.id }, { ...expense(bob.memberId, [bob.memberId], "500"), attachmentIds: [ownerPhoto.id], expectedRevision: 1 });
    expect(edited.attachments).toHaveLength(1);
    // Another member (not creator, not owner) can't edit at all.
    const g2 = await createGroup({ members: 2 });
    const carolPhoto = await upload(g2.members[1]!);
    const bobEntry = await g2.members[0]!.ok<EntryDTO>("createEntry", { roundId: g2.roundId }, expense(g2.members[0]!.memberId, [g2.members[0]!.memberId], "500"));
    expect((await g2.members[1]!.call("updateEntry", { roundId: g2.roundId, entryId: bobEntry.id }, { ...expense(g2.members[0]!.memberId, [g2.members[0]!.memberId], "500"), attachmentIds: [carolPhoto.id], expectedRevision: 1 })).status).toBe(403);
  });

  it("keeps pending photos linkable after a stale-revision rejection", async () => {
    const g = await createGroup();
    const e = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, body(g));
    await g.owner.ok("updateEntry", { roundId: g.roundId, entryId: e.id }, { ...body(g, { description: "Lunch" }), expectedRevision: 1 });
    const a = await upload(g.owner);
    expect(await errorCode(g.owner.call("updateEntry", { roundId: g.roundId, entryId: e.id }, { ...body(g, { attachmentIds: [a.id] }), expectedRevision: 1 }))).toMatchObject({ code: "STALE_VERSION" });
    const retried = await g.owner.ok<EntryDTO>("updateEntry", { roundId: g.roundId, entryId: e.id }, { ...body(g, { attachmentIds: [a.id] }), expectedRevision: 2 });
    expect(retried.attachments.map((x) => x.id)).toEqual([a.id]);
  });

  it("trashes an entry's photos when it is deleted and hides them", async () => {
    const g = await createGroup();
    const a = await upload(g.owner);
    const e = await g.owner.ok<EntryDTO>("createEntry", { roundId: g.roundId }, body(g, { attachmentIds: [a.id] }));
    await g.owner.ok("deleteEntry", { roundId: g.roundId, entryId: e.id }, { expectedRevision: 1 });
    expect((await g.owner.call("readAttachment", { attachmentId: a.id }, null, null)).status).toBe(404);
    expect(await sqlIn(g.stub, "SELECT attachment_id FROM attachment_trash")).toEqual([{ attachment_id: a.id }]);
  });

  it("includes photo metadata in backups", async () => {
    const g = await createGroup();
    await upload(g.owner);
    const snap = await internal(g).ok<{ tables: Record<string, unknown[]> }>("backupSnapshot", {}, null, null);
    expect(snap.tables.attachments).toHaveLength(1);
    expect(snap.tables.attachment_trash).toEqual([]);
  });
});

describe("photo purge queue", () => {
  it("moves expired pending uploads to the trash, hands out ids, and forgets them on ack", async () => {
    const g = await createGroup();
    const old = await upload(g.owner);
    const fresh = await upload(g.owner);
    await runInDurableObject(g.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE attachments SET created_at = ? WHERE id = ?", new Date(Date.now() - 25 * 3600_000).toISOString(), old.id);
    });
    const cron = internal(g);
    const taken = await cron.ok<{ ids: string[] }>("takeAttachmentTrash", {}, null, null);
    expect(taken.ids).toEqual([old.id]);
    expect((await g.owner.call("readAttachment", { attachmentId: fresh.id }, null, null)).status).toBe(200);
    // Not acknowledged yet: handed out again.
    expect((await cron.ok<{ ids: string[] }>("takeAttachmentTrash", {}, null, null)).ids).toEqual([old.id]);
    await cron.ok("ackAttachmentTrash", {}, { ids: [old.id] }, null);
    expect((await cron.ok<{ ids: string[] }>("takeAttachmentTrash", {}, null, null)).ids).toEqual([]);
  });

  it("refuses the purge ops to members", async () => {
    const g = await createGroup();
    expect((await g.owner.call("takeAttachmentTrash", {}, null, null)).status).toBe(403);
    expect((await g.owner.call("ackAttachmentTrash", {}, { ids: [] }, null)).status).toBe(403);
  });
});
