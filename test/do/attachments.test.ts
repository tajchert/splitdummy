import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryDTO, RoundViewDTO } from "@shared/api";
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
