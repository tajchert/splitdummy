import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AuditEventDTO, EntryDTO, HistoryDTO, RoundViewDTO } from "@shared/api";
import { createGroup, expense, freezeNow } from "./helpers";

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
