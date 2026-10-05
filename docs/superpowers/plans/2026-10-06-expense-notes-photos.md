# Expense notes and receipt photos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every expense/refund can carry a free-text note and up to 5 receipt photos, compressed in the browser and stored privately in R2.

**Architecture:** The ProjectDO stays the only authority: it stores the note on `entries`, photo metadata in a new `attachments` table, and a purge queue in `attachment_trash`. Photos upload first (`POST …/attachments`, raw bytes, validated and metadata-stripped at the edge, then written to a new R2 bucket) and become *pending*; `createEntry`/`updateEntry` link them by id inside the existing transaction. A daily cron step deletes trashed objects from R2. The web app compresses photos to WebP/JPEG (≤ 2000 px, ≤ 900 KB) before uploading.

**Tech Stack:** Cloudflare Workers + Hono 4, SQLite-backed Durable Objects, R2, zod 4, React 19 + react-router, Vitest (`shared` node project, `web` jsdom project, `worker` vitest-pool-workers project).

**Spec:** `docs/superpowers/specs/2026-10-06-expense-notes-photos-design.md` — read it before starting any task.

## Global Constraints

- Contracts in `src/shared/api.ts` are extended **additively only**; no field is renamed or removed.
- No new npm dependencies. Dependencies stay pinned exactly.
- Photo ids use the `att_` prefix (`newId("att")` in `worker/do/tx.ts`); `a_` is already used by audit events.
- Limits: 5 photos per entry · 20 pending uploads per member · 1000 photos per project · upload body ≤ 1,500,000 bytes · each side 1–4096 px · note ≤ 1000 chars after trim · pending TTL 24 h.
- Accepted upload types: exactly `image/webp` and `image/jpeg`.
- R2 bucket names: `splitdummy-attachments` (prod), `splitdummy-staging-attachments` (staging); binding `ATTACHMENTS`. Object key `projects/<projectId>/attachments/<attachmentId>`.
- Rate limiter `RL_UPLOAD`: 30 per 60 s per principal; namespace ids `1007` (prod) and `2007` (staging).
- Never log note text or image bytes. Logs carry ids, byte counts and status only.
- Browser compression: long edge ≤ 2000 px; WebP q0.8 → q0.7 → q0.6 → 1600 px at q0.7; JPEG fallback uses q+0.02 (0.82/0.72/0.62/0.72); budget 900,000 bytes; white background.
- User-facing copy (exact): "This photo isn't available. Remove it and add it again." · "Couldn't read this image — try a JPEG or PNG." · "This photo is no longer available." · "Uploading photos…".
- Don't create the real R2 buckets (`wrangler r2 bucket create`) without explicit user confirmation (Task 12).
- Run commands from the repo root. `npm run typecheck` must pass at the end of every task.

## Review Focus

1. **A transparent PNG (e.g. a screenshot of a digital receipt) in Safari**, which falls back to JPEG: it must come out on white, not black. Test in Task 8 (`encodeOnCanvas` fills white before drawing).
2. **A 48 MP phone photo (8000×6000)**: it must be scaled to 2000×1500 and never encoded at full size. Test in Task 8.
3. **A retried upload after the R2 put failed** (the DO already registered the id): the replay with the same Idempotency-Key must return the same id and the image must then be downloadable. Test in Task 5.
4. **A draft restored more than 24 h later**, whose pending photos were purged: the save fails on `attachmentIds.<n>`, and the form must mark that tile instead of showing a vague error. Tests in Task 4 (field path) and Task 9 (tile marked).
5. **A save that hits STALE_VERSION** because someone else edited the entry: the user's pending photos must stay pending and linkable on the retry. Test in Task 4.

---

## File map

| File | Responsibility |
|---|---|
| `src/shared/api.ts` (modify) | `NoteSchema`, attachment constants/types, `EntryDTO.note/attachments`, `EntryInputSchema.note/attachmentIds`, two ENDPOINTS |
| `src/shared/api.test.ts` (create) | schema tests |
| `worker/do/schema.ts` (modify) | migration #4 |
| `worker/do/store.ts` (modify) | `AttachmentRow`, `EntryRow.note`, attachments loaded with entries, `attachment(id)` |
| `worker/do/views.ts` (modify) | `attachmentDto`, `entryDto` fields, frozen snapshot defaults |
| `worker/do/limits.ts` (modify) | attachment limits, TTL, trash batch |
| `worker/do/ops/attachments.ts` (create) | register/read/link/trash/take/ack ops + `extrasSummary` |
| `worker/do/ops/ledger.ts` (modify) | note + attachment linking in create/update/delete, audit summary |
| `worker/do/ops/read.ts` (modify) | backup tables |
| `worker/do/csv.ts` (modify) | `note`, `photo_count` columns |
| `worker/do/types.ts`, `worker/do/ProjectDO.ts` (modify) | new ops wired |
| `worker/lib/image.ts` (create) | JPEG/WebP sniffing, dimensions, metadata strip (pure) |
| `worker/lib/attachments.ts` (create) | R2 key helpers, prefix delete |
| `worker/lib/http.ts`, `worker/lib/crypto.ts` (modify) | `readBodyBytes`, `sha256HexBytes` |
| `worker/routes/attachments.ts` (create) | upload + download routes |
| `worker/routes/openapi.ts` (modify) | docs for the two endpoints, entry fields |
| `worker/index.ts` (modify) | route registration, keep route-set `Cache-Control` |
| `worker/queue/scheduled.ts`, `worker/routes/account.ts` (modify) | nightly purge, group-deletion purge |
| `wrangler.jsonc`, `worker/worker-configuration.d.ts` (modify) | bindings |
| `test/fixtures/images.ts` (create) | synthetic JPEG/WebP builders |
| `src/web/api/types.ts`, `http.ts`, `mock.ts` (modify) | `uploadAttachment`, `attachmentUrl` |
| `src/web/lib/receiptImage.ts` (create) | browser compression |
| `src/web/lib/usePhotoUploads.ts` (create) | tile state + uploads hook |
| `src/web/lib/entryForm.ts`, `drafts.ts` (modify) | draft fields, body |
| `src/web/pages/group/NoteAndPhotos.tsx` (create) | form section |
| `src/web/pages/group/EntryAttachments.tsx` (create) | detail note, thumbnails, viewer |
| `src/web/pages/group/EntryForm.tsx`, `EntryDetail.tsx`, `parts.tsx` (modify) | wiring, list indicator |
| `src/web/styles/pages.css` (modify) | styles |
| `src/shared/api-guide.ts`, `src/web/pages/ApiDocs.tsx`, `src/web/pages/Privacy.tsx`, `docs/ARCHITECTURE.md`, `docs/splitdummy-development-handoff.md` (modify) | docs |

---

### Task 1: Contracts, schema migration and read path

**Files:**
- Modify: `src/shared/api.ts` (primitives near line 23, `EntryDTO` at 175-209, `EntryInputSchema` at 398-413)
- Create: `src/shared/api.test.ts`
- Modify: `worker/do/schema.ts` (append to `MIGRATIONS`, line ~223)
- Modify: `worker/do/store.ts` (`EntryRow`, `LoadedEntry`, `roundEntries`, `loadEntry`)
- Modify: `worker/do/views.ts` (`entryDto`, frozen branch of `roundView`)
- Modify: `src/web/api/mock.ts` (`buildEntry` at ~219, `roundView` at ~164)
- Test: `test/do/attachments.test.ts` (create)

**Interfaces:**
- Produces (shared): `NOTE_MAX = 1000`, `NoteSchema`, `ATTACHMENT_TYPES`, `AttachmentContentType`, `MAX_ATTACHMENT_BYTES = 1_500_000`, `MAX_IMAGE_EDGE = 4096`, `MAX_ATTACHMENTS_PER_ENTRY = 5`, `AttachmentDTO`, `EntryDTO.note: string | null`, `EntryDTO.attachments: AttachmentDTO[]`, `EntryInput.note?: string | null`, `EntryInput.attachmentIds?: string[]`.
- Produces (worker): `AttachmentRow` (store.ts), `LoadedEntry.attachments: AttachmentRow[]`, `Store.attachment(id): AttachmentRow | undefined`, `attachmentDto(a: AttachmentRow): AttachmentDTO` (views.ts).

- [ ] **Step 1: Write the failing shared schema test**

Create `src/shared/api.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EntryInputSchema, NoteSchema, UpdateEntrySchema } from "./api";

const base = {
  type: "EXPENSE",
  description: "Dinner",
  occurredAt: "2026-10-01",
  originalAmount: "1000",
  originalCurrency: "PLN",
  conversion: { method: "IDENTITY" },
  payerMemberId: "m_a",
  splitMode: "EQUAL",
  participants: [{ memberId: "m_a" }],
};

describe("NoteSchema", () => {
  it("trims and caps at 1000 characters", () => {
    expect(NoteSchema.parse("  hi  ")).toBe("hi");
    expect(NoteSchema.safeParse("x".repeat(1000)).success).toBe(true);
    expect(NoteSchema.safeParse("x".repeat(1001)).success).toBe(false);
    expect(NoteSchema.safeParse(`${"x".repeat(1000)}   `).success).toBe(true);
  });
});

describe("EntryInputSchema note and photos", () => {
  it("keeps both fields optional so old clients are unaffected", () => {
    const parsed = EntryInputSchema.parse(base);
    expect(parsed.note).toBeUndefined();
    expect(parsed.attachmentIds).toBeUndefined();
  });

  it("accepts null and empty values to clear", () => {
    expect(EntryInputSchema.parse({ ...base, note: null, attachmentIds: [] })).toMatchObject({ note: null, attachmentIds: [] });
  });

  it("rejects more than five photos and duplicates", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `att_${i}`);
    expect(EntryInputSchema.safeParse({ ...base, attachmentIds: ids(5) }).success).toBe(true);
    const six = EntryInputSchema.safeParse({ ...base, attachmentIds: ids(6) });
    expect(six.success).toBe(false);
    expect(six.error?.issues[0]?.path).toEqual(["attachmentIds"]);
    const dup = EntryInputSchema.safeParse({ ...base, attachmentIds: ["att_1", "att_1"] });
    expect(dup.success).toBe(false);
  });

  it("carries the fields into updates", () => {
    expect(UpdateEntrySchema.parse({ ...base, expectedRevision: 2, note: "Tip included" }).note).toBe("Tip included");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project shared src/shared/api.test.ts`
Expected: FAIL — `NoteSchema` is not exported.

- [ ] **Step 3: Add the shared contracts**

In `src/shared/api.ts`, below `DescriptionSchema` (line 23):

```ts
export const NOTE_MAX = 1000;
/** Free text on an entry. "" is normalized to null by the server. */
export const NoteSchema = z.string().trim().max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters`);

// ---------- photos ----------
export const ATTACHMENT_TYPES = ["image/webp", "image/jpeg"] as const;
export type AttachmentContentType = (typeof ATTACHMENT_TYPES)[number];
export const MAX_ATTACHMENT_BYTES = 1_500_000;
export const MAX_IMAGE_EDGE = 4096;
export const MAX_ATTACHMENTS_PER_ENTRY = 5;
```

Add the DTO above `EntryDTO`:

```ts
export interface AttachmentDTO {
  id: string;
  contentType: AttachmentContentType;
  bytes: number;
  width: number;
  height: number;
}
```

Add to `EntryDTO`, after `correctedRoundId`:

```ts
  /** Free-text note; null when none. */
  note: string | null;
  /** Receipt photos in display order. */
  attachments: AttachmentDTO[];
```

Add to `EntryInputSchema`'s object, after `participants`:

```ts
  /** Update: omitted = unchanged; null or "" clears. */
  note: NoteSchema.nullable().optional(),
  /** Uploaded photo ids in display order. Update: omitted = unchanged; [] removes all. */
  attachmentIds: z
    .array(IdSchema)
    .max(MAX_ATTACHMENTS_PER_ENTRY, `Add at most ${MAX_ATTACHMENTS_PER_ENTRY} photos`)
    .refine((ids) => new Set(ids).size === ids.length, "This photo is listed twice")
    .optional(),
```

- [ ] **Step 4: Run the shared test**

Run: `npx vitest run --project shared src/shared/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing DO read-path test**

Create `test/do/attachments.test.ts`:

```ts
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
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run --project worker test/do/attachments.test.ts`
Expected: FAIL — `note` is `undefined`.

- [ ] **Step 7: Add migration #4**

Append a new string to `MIGRATIONS` in `worker/do/schema.ts` (after the members/rename migration):

```ts
  `
  ALTER TABLE entries ADD COLUMN note TEXT;
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    entry_id TEXT REFERENCES entries(id),
    uploader_member_id TEXT NOT NULL REFERENCES members(id),
    content_type TEXT NOT NULL CHECK (content_type IN ('image/webp','image/jpeg')),
    bytes INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    attached_at TEXT
  );
  CREATE INDEX attachments_entry ON attachments(entry_id, position);
  CREATE INDEX attachments_pending ON attachments(uploader_member_id) WHERE entry_id IS NULL;
  CREATE TABLE attachment_trash (
    attachment_id TEXT PRIMARY KEY,
    trashed_at TEXT NOT NULL
  );
  `,
```

- [ ] **Step 8: Load attachments with entries**

In `worker/do/store.ts`:

```ts
import type { AttachmentContentType } from "@shared/api";
```

Add `note: string | null;` to `EntryRow` after `corrected_round_id`. Add:

```ts
export interface AttachmentRow {
  id: string;
  /** NULL while pending (uploaded, not yet saved with an entry). */
  entry_id: string | null;
  uploader_member_id: string;
  content_type: AttachmentContentType;
  bytes: number;
  width: number;
  height: number;
  position: number;
  created_at: string;
  attached_at: string | null;
}
```

Add `attachments: AttachmentRow[];` to `LoadedEntry`. In `roundEntries`, after `const effects = …`:

```ts
    const attachments = new Map<string, AttachmentRow[]>();
    for (const a of this.all<AttachmentRow>(
      "SELECT t.* FROM attachments t JOIN entries e ON e.id = t.entry_id WHERE e.round_id = ? AND e.deleted = 0 ORDER BY t.position",
      roundId,
    )) {
      const list = attachments.get(a.entry_id!);
      if (list) list.push(a);
      else attachments.set(a.entry_id!, [a]);
    }
```

and add `attachments: attachments.get(row.id) ?? [],` to the mapped object. In `loadEntry` add:

```ts
      attachments: this.all<AttachmentRow>("SELECT * FROM attachments WHERE entry_id = ? ORDER BY position", id),
```

Add a method:

```ts
  attachment(id: string): AttachmentRow | undefined {
    return this.first<AttachmentRow>("SELECT * FROM attachments WHERE id = ?", id);
  }
```

- [ ] **Step 9: Map to DTOs and default old snapshots**

In `worker/do/views.ts` import `AttachmentDTO` and `AttachmentRow`, then add:

```ts
export function attachmentDto(a: AttachmentRow): AttachmentDTO {
  return { id: a.id, contentType: a.content_type, bytes: a.bytes, width: a.width, height: a.height };
}

/** Snapshots frozen before notes/photos existed lack those fields. */
const withEntryDefaults = (e: EntryDTO): EntryDTO => ({ ...e, note: e.note ?? null, attachments: e.attachments ?? [] });
```

In `entryDto`, after `correctedRoundId`:

```ts
    note: r.note,
    attachments: e.attachments.map(attachmentDto),
```

In the frozen branch of `roundView`, add `const entries = snap.entries.map(withEntryDefaults);` and use `entries` for `entries`, `totals(...)` and `currencySubtotals(...)`.

- [ ] **Step 10: Keep the web mock compiling**

In `src/web/api/mock.ts` `buildEntry`, add to the returned object:

```ts
    note: body.note === undefined ? (prev?.note ?? null) : body.note?.trim() || null,
    attachments: prev?.attachments ?? [],
```

In the mock's `roundView(p, r)` (line ~164), return entries as `r.entries.map((e) => ({ ...e, note: e.note ?? null, attachments: e.attachments ?? [] }))` (persisted mock state predates these fields). Then run `npm run typecheck` and add `note: null, attachments: []` to any other `EntryDTO` object literal it reports (mock adjustments, seed data, test fixtures).

- [ ] **Step 11: Run the tests and typecheck**

Run: `npx vitest run --project worker test/do && npx vitest run --project shared && npm run typecheck`
Expected: PASS (all existing DO tests too).

- [ ] **Step 12: Commit**

```bash
git add src/shared/api.ts src/shared/api.test.ts worker/do/schema.ts worker/do/store.ts worker/do/views.ts src/web/api/mock.ts test/do/attachments.test.ts
git commit -m "feat: note and attachments on entries (contracts, schema, read path)"
```

---

### Task 2: Note write path, audit summary and CSV

**Files:**
- Create: `worker/do/ops/attachments.ts` (only `extrasSummary` and `normalizeNote` in this task)
- Modify: `worker/do/ops/ledger.ts` (`createEntry` INSERT at ~231, `updateEntry` at ~286-339)
- Modify: `worker/do/csv.ts` (`HEADER`, entry rows, `transferRow`)
- Test: `test/do/attachments.test.ts`

**Interfaces:**
- Consumes: `EntryDTO.note/attachments` (Task 1).
- Produces: `normalizeNote(note: string | null | undefined): string | null`, `extrasSummary(before: EntryDTO, after: EntryDTO): string[]` in `worker/do/ops/attachments.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/do/attachments.test.ts` (merge the `helpers` import):

```ts
import type { AuditEventDTO, HistoryDTO } from "@shared/api";

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
    const [header, row] = csv.replace(/^﻿/, "").split("\r\n");
    expect(header!.endsWith('"note","photo_count"')).toBe(true);
    expect(row!.endsWith(`"'=SUM(A1)","0"`)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project worker test/do/attachments.test.ts`
Expected: FAIL — note is null / header lacks `note`.

- [ ] **Step 3: Create the helpers module**

Create `worker/do/ops/attachments.ts`:

```ts
/** Entry notes and receipt photos: linking, visibility, cleanup. */
import type { EntryDTO } from "@shared/api";

export const normalizeNote = (note: string | null | undefined): string | null => note?.trim() || null;

/** Audit-summary fragments for what changed besides the money, e.g. ["changed the note", "added 2 photos"]. */
export function extrasSummary(before: EntryDTO, after: EntryDTO): string[] {
  const out: string[] = [];
  if (before.note !== after.note) {
    out.push(after.note === null ? "removed the note" : before.note === null ? "added a note" : "changed the note");
  }
  const was = new Set(before.attachments.map((a) => a.id));
  const now = new Set(after.attachments.map((a) => a.id));
  const added = [...now].filter((id) => !was.has(id)).length;
  const removed = [...was].filter((id) => !now.has(id)).length;
  if (added) out.push(added === 1 ? "added a photo" : `added ${added} photos`);
  if (removed) out.push(removed === 1 ? "removed a photo" : `removed ${removed} photos`);
  return out;
}
```

- [ ] **Step 4: Write the note in create and update**

In `worker/do/ops/ledger.ts` import `{ extrasSummary, normalizeNote }` from `./attachments`.

`createEntry`: add `note` to the INSERT column list (after `split_mode`), add one more `?` to `VALUES`, and pass `normalizeNote(input.note)` right after `input.splitMode`.

`updateEntry`: before the UPDATE, add

```ts
  const note = input.note === undefined ? row.note : normalizeNote(input.note);
```

add `note = ?` to the SET list after `split_mode = ?`, and pass `note` after `input.splitMode`. Replace the audit call's summary with:

```ts
  const extras = extrasSummary(before, after);
  tx.audit("ENTRY_UPDATED", `${me.display_name} edited “${input.description}” ${describe(p)}${extras.map((x) => ` · ${x}`).join("")}`, {
```

(keep the rest of the call unchanged).

- [ ] **Step 5: Add the CSV columns**

In `worker/do/csv.ts` append `"note", "photo_count"` to the end of `HEADER`. In the entry row array, append `e.note, e.attachments.length` after the final `""` (confirmed_at). In `transferRow`, append `"", ""` after `i.confirmedAt`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project worker test/do`
Expected: PASS (fix any existing CSV test that asserts the full header by appending the two columns).

- [ ] **Step 7: Commit**

```bash
git add worker/do/ops/attachments.ts worker/do/ops/ledger.ts worker/do/csv.ts test/do/attachments.test.ts test/do
git commit -m "feat(worker): save entry notes, summarize note changes, export note columns"
```

---

### Task 3: Image sniffing and metadata stripping (pure)

**Files:**
- Create: `worker/lib/image.ts`
- Create: `test/fixtures/images.ts`
- Test: `worker/lib/image.test.ts` (in the `worker` vitest project via `worker/**/*.test.ts`)

**Interfaces:**
- Produces: `interface ImageInfo { type: AttachmentContentType; width: number; height: number }`, `sniffImage(bytes: Uint8Array): ImageInfo | null`, `stripMetadata(bytes: Uint8Array, type: AttachmentContentType): Uint8Array` (input must have passed `sniffImage`).
- Produces (fixtures): `jpeg(opts?: { width?: number; height?: number; exif?: boolean; comment?: boolean; fill?: boolean }): Uint8Array`, `webp(opts?: { width?: number; height?: number; exif?: boolean; xmp?: boolean; format?: "VP8X" | "VP8" | "VP8L" }): Uint8Array`, `includesAscii(bytes: Uint8Array, text: string): boolean`, `SECRET = "GPS-52.2297N"`.

- [ ] **Step 1: Write the fixtures**

Create `test/fixtures/images.ts`:

```ts
/** Header-accurate synthetic JPEG/WebP files. Never decoded, so pixel data is filler. */
export const SECRET = "GPS-52.2297N";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const segment = (marker: number, payload: number[]) => [0xff, marker, ...u16be(payload.length + 2), ...payload];

export function jpeg(opts: { width?: number; height?: number; exif?: boolean; comment?: boolean; fill?: boolean } = {}): Uint8Array {
  const { width = 1600, height = 1200 } = opts;
  return new Uint8Array([
    0xff, 0xd8,
    ...segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(opts.exif ? segment(0xe1, [...ascii("Exif"), 0, 0, ...ascii(SECRET)]) : []),
    ...(opts.comment ? segment(0xfe, ascii(`comment ${SECRET}`)) : []),
    ...(opts.fill ? [0xff] : []), // a fill byte before the next marker is legal
    ...segment(0xc0, [8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    0x12, 0x34, 0xff, 0x00, 0x56, // entropy-coded data with a stuffed 0xFF
    0xff, 0xd9,
  ]);
}

const chunk = (fourcc: string, data: number[]) => [...ascii(fourcc), ...u32le(data.length), ...data, ...(data.length % 2 ? [0] : [])];

export function webp(opts: { width?: number; height?: number; exif?: boolean; xmp?: boolean; format?: "VP8X" | "VP8" | "VP8L" } = {}): Uint8Array {
  const { width = 1600, height = 1200, format = "VP8X" } = opts;
  const vp8 = chunk("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height), 0, 0]);
  const bits = (width - 1) | ((height - 1) << 14);
  const vp8l = chunk("VP8L", [0x2f, ...u32le(bits), 0]);
  let body: number[];
  if (format === "VP8") body = vp8;
  else if (format === "VP8L") body = vp8l;
  else {
    const flags = (opts.exif ? 0x08 : 0) | (opts.xmp ? 0x04 : 0);
    body = [
      ...chunk("VP8X", [flags, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]),
      ...vp8,
      ...(opts.exif ? chunk("EXIF", ascii(`II*\0${SECRET}`)) : []),
      ...(opts.xmp ? chunk("XMP ", ascii(`<x:xmpmeta>${SECRET}</x:xmpmeta>`)) : []),
    ];
  }
  const riff = [...ascii("WEBP"), ...body];
  return new Uint8Array([...ascii("RIFF"), ...u32le(riff.length), ...riff]);
}

export function includesAscii(bytes: Uint8Array, text: string): boolean {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s.includes(text);
}
```

- [ ] **Step 2: Write the failing tests**

Create `worker/lib/image.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SECRET, includesAscii, jpeg, webp } from "../../test/fixtures/images";
import { sniffImage, stripMetadata } from "./image";

const u32le = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

describe("sniffImage", () => {
  it("reads JPEG dimensions from the SOF segment, past fill bytes", () => {
    expect(sniffImage(jpeg({ width: 1234, height: 987, exif: true, fill: true }))).toEqual({ type: "image/jpeg", width: 1234, height: 987 });
  });

  it("reads WebP dimensions for extended, lossy and lossless files", () => {
    expect(sniffImage(webp({ width: 2000, height: 1500 }))).toEqual({ type: "image/webp", width: 2000, height: 1500 });
    expect(sniffImage(webp({ width: 640, height: 480, format: "VP8" }))).toEqual({ type: "image/webp", width: 640, height: 480 });
    expect(sniffImage(webp({ width: 300, height: 200, format: "VP8L" }))).toEqual({ type: "image/webp", width: 300, height: 200 });
  });

  it("rejects other formats and truncated files", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull(); // PNG
    expect(sniffImage(jpeg().subarray(0, 30))).toBeNull();
    const notWebp = webp();
    notWebp.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    expect(sniffImage(notWebp)).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe("stripMetadata", () => {
  it("drops EXIF/XMP (APP1) and comments from JPEG and keeps the image segments", () => {
    const input = jpeg({ width: 800, height: 600, exif: true, comment: true });
    const out = stripMetadata(input, "image/jpeg");
    expect(includesAscii(input, SECRET)).toBe(true);
    expect(includesAscii(out, SECRET)).toBe(false);
    expect(includesAscii(out, "JFIF")).toBe(true);
    expect(sniffImage(out)).toEqual({ type: "image/jpeg", width: 800, height: 600 });
    expect([...out.subarray(-7)]).toEqual([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]);
  });

  it("drops EXIF and XMP chunks from WebP, clears their VP8X flags and fixes the RIFF size", () => {
    const out = stripMetadata(webp({ exif: true, xmp: true }), "image/webp");
    expect(includesAscii(out, SECRET)).toBe(false);
    expect(u32le(out, 4)).toBe(out.length - 8);
    expect(out[20]! & 0x0c).toBe(0); // VP8X flags byte: RIFF(12) + chunk header(8)
    expect(sniffImage(out)).toEqual({ type: "image/webp", width: 1600, height: 1200 });
  });

  it("returns a copy and never mutates its input", () => {
    const input = webp({ exif: true });
    const before = [...input];
    stripMetadata(input, "image/webp");
    expect([...input]).toEqual(before);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run --project worker worker/lib/image.test.ts`
Expected: FAIL — module `./image` not found.

- [ ] **Step 4: Implement `worker/lib/image.ts`**

```ts
/**
 * Minimal JPEG/WebP container parsing: identify the format, read the pixel size from the header and drop
 * metadata (EXIF, XMP, comments). Never decodes pixels. Pure; safe on untrusted bytes.
 */
import type { AttachmentContentType } from "@shared/api";

export interface ImageInfo {
  type: AttachmentContentType;
  width: number;
  height: number;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, i: number) => (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegInfo(b);
  if (b.length >= 20 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webpInfo(b);
  return null;
}

export function stripMetadata(b: Uint8Array, type: AttachmentContentType): Uint8Array {
  return type === "image/jpeg" ? stripJpeg(b) : stripWebp(b);
}

// ---------- JPEG ----------

/** Start-of-frame markers (baseline, progressive, lossless, arithmetic); they carry the image size. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** APP1 (EXIF, XMP), APP13 (IPTC/Photoshop), COM. */
const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);

interface Segment {
  marker: number;
  start: number;
  payload: number;
  end: number;
}

/** Header segments up to and including the first SOS; `rest` is where the scan data starts. */
function jpegSegments(b: Uint8Array): { segments: Segment[]; rest: number } | null {
  const segments: Segment[] = [];
  let i = 2;
  for (;;) {
    const start = i;
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff) i++; // marker prefix plus optional fill bytes
    const marker = b[i++];
    if (marker === undefined || marker === 0xd9) return null; // truncated, or EOI before any scan
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start, payload: i, end: i });
      continue;
    }
    if (i + 2 > b.length) return null;
    const end = i + u16be(b, i);
    if (end < i + 2 || end > b.length) return null;
    segments.push({ marker, start, payload: i + 2, end });
    i = end;
    if (marker === 0xda) return { segments, rest: end };
  }
}

function jpegInfo(b: Uint8Array): ImageInfo | null {
  const parsed = jpegSegments(b);
  const sof = parsed?.segments.find((s) => SOF.has(s.marker) && s.end - s.payload >= 5);
  if (!sof) return null;
  const height = u16be(b, sof.payload + 1);
  const width = u16be(b, sof.payload + 3);
  return width > 0 && height > 0 ? { type: "image/jpeg", width, height } : null;
}

function stripJpeg(b: Uint8Array): Uint8Array {
  const parsed = jpegSegments(b);
  if (!parsed) throw new Error("stripJpeg: not a JPEG");
  return concat([
    b.subarray(0, 2),
    ...parsed.segments.filter((s) => !JPEG_DROP.has(s.marker)).map((s) => b.subarray(s.start, s.end)),
    b.subarray(parsed.rest),
  ]);
}

// ---------- WebP ----------

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const WEBP_DROP = new Set(["EXIF", "XMP "]);

interface Chunk {
  fourcc: string;
  start: number;
  data: number;
  size: number;
  end: number;
}

function webpChunks(b: Uint8Array): Chunk[] | null {
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd < 20 || riffEnd > b.length) return null;
  const chunks: Chunk[] = [];
  let i = 12;
  while (i + 8 <= riffEnd) {
    const size = u32le(b, i + 4);
    const data = i + 8;
    if (data + size > riffEnd) return null;
    const end = Math.min(data + size + (size & 1), riffEnd);
    chunks.push({ fourcc: ascii(b, i, 4), start: i, data, size, end });
    i = end;
  }
  return chunks.length > 0 ? chunks : null;
}

const webpDims = (width: number, height: number): ImageInfo | null =>
  width > 0 && height > 0 ? { type: "image/webp", width, height } : null;

function webpInfo(b: Uint8Array): ImageInfo | null {
  const first = webpChunks(b)?.[0];
  if (!first) return null;
  const d = first.data;
  if (first.fourcc === "VP8X" && first.size >= 10) return webpDims(1 + u24le(b, d + 4), 1 + u24le(b, d + 7));
  if (first.fourcc === "VP8 " && first.size >= 10 && b[d + 3] === 0x9d && b[d + 4] === 0x01 && b[d + 5] === 0x2a) {
    return webpDims(u16le(b, d + 6) & 0x3fff, u16le(b, d + 8) & 0x3fff);
  }
  if (first.fourcc === "VP8L" && first.size >= 5 && b[d] === 0x2f) {
    const bits = u32le(b, d + 1);
    return webpDims((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

function stripWebp(b: Uint8Array): Uint8Array {
  const chunks = webpChunks(b);
  if (!chunks) throw new Error("stripWebp: not a WebP");
  const kept = chunks.filter((c) => !WEBP_DROP.has(c.fourcc));
  const body = concat([b.subarray(8, 12), ...kept.map((c) => b.subarray(c.start, c.end))]);
  if (kept[0]?.fourcc === "VP8X") body[12] = body[12]! & ~(VP8X_EXIF | VP8X_XMP); // "WEBP"(4) + chunk header(8)
  const size = body.length;
  return concat([b.subarray(0, 4), new Uint8Array([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff]), body]);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project worker worker/lib/image.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/lib/image.ts worker/lib/image.test.ts test/fixtures/images.ts
git commit -m "feat(worker): sniff JPEG/WebP size and strip photo metadata"
```

---

### Task 4: DO attachment ops (register, read, link, trash, purge queue)

**Files:**
- Modify: `worker/do/ops/attachments.ts`
- Modify: `worker/do/limits.ts`
- Modify: `worker/do/types.ts` (`DoOp` union)
- Modify: `worker/do/ProjectDO.ts` (`ReadOp`, `READ_OPS`, `KEYLESS_OPS`, `mutate` switch, imports)
- Modify: `worker/do/ops/ledger.ts` (`createEntry`, `updateEntry`, `deleteEntry`)
- Modify: `worker/do/ops/read.ts` (`BACKUP_TABLES`)
- Test: `test/do/attachments.test.ts`

**Interfaces:**
- Consumes: `AttachmentRow`, `Store.attachment`, `attachmentDto` (Task 1); `ATTACHMENT_TYPES`, `MAX_ATTACHMENT_BYTES`, `MAX_IMAGE_EDGE`, `MAX_ATTACHMENTS_PER_ENTRY` (Task 1).
- Produces DO ops (consumed by Tasks 5 and 6):
  - `registerAttachment` — principal = uploader, idempotency key required, body `{ contentType, bytes, width, height, sha256 }` → `201 AttachmentDTO`.
  - `readAttachment` — read op, `params.attachmentId` → `200 AttachmentDTO` or 404.
  - `takeAttachmentTrash` — internal, principal `null`, keyless → `200 { ids: string[] }` (at most `ATTACHMENT_TRASH_BATCH`).
  - `ackAttachmentTrash` — internal, principal `null`, keyless, body `{ ids: string[] }` → `200 { ok: true }`.
- Produces (limits.ts): `LIMITS.pendingAttachmentsPerMember`, `LIMITS.attachments`, `PENDING_ATTACHMENT_TTL_MS`, `ATTACHMENT_TRASH_BATCH = 500`.

- [ ] **Step 1: Write the failing tests**

Append to `test/do/attachments.test.ts`:

```ts
import type { AttachmentDTO } from "@shared/api";
import { Client, errorCode, sqlIn, type Group } from "./helpers";

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
```

Merge all imports at the top of the file (one import from `./helpers`, one from `@shared/api`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project worker test/do/attachments.test.ts`
Expected: FAIL — unknown operation `registerAttachment`.

- [ ] **Step 3: Add the limits**

In `worker/do/limits.ts`, add to `LIMITS` (photos per entry are capped by `EntryInputSchema` via `MAX_ATTACHMENTS_PER_ENTRY`):

```ts
  /** Uploaded but not yet saved with an entry, per member. */
  pendingAttachmentsPerMember: 20,
  /** Pending and attached photos in the project. */
  attachments: 1000,
```

and below it:

```ts
/** Unattached uploads are purged after this long. */
export const PENDING_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Trash ids handed to the cron per call (R2 deletes up to 1000 keys per call). */
export const ATTACHMENT_TRASH_BATCH = 500;
```

- [ ] **Step 4: Implement the ops**

Extend `worker/do/ops/attachments.ts` (keep `normalizeNote` and `extrasSummary`):

```ts
import { z } from "zod";
import { ATTACHMENT_TYPES, IdSchema, MAX_ATTACHMENT_BYTES, MAX_IMAGE_EDGE, type EntryDTO } from "@shared/api";
import { forbidden, invalid, limitExceeded, notCollecting, notFound, parseBody } from "../errors";
import { ATTACHMENT_TRASH_BATCH, LIMITS, PENDING_ATTACHMENT_TTL_MS } from "../limits";
import type { MemberRow } from "../store";
import { newId, type Tx } from "../tx";
import type { DoRequest, DoResponse } from "../types";
import { attachmentDto } from "../views";
import { ok, type OpResult } from "./project";

/** What the edge measured; the edge has already validated the bytes themselves. */
const RegisterSchema = z.object({
  contentType: z.enum(ATTACHMENT_TYPES),
  bytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  width: z.number().int().min(1).max(MAX_IMAGE_EDGE),
  height: z.number().int().min(1).max(MAX_IMAGE_EDGE),
  /** Part of the idempotency hash, so one key can't register two different images. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const AckSchema = z.object({ ids: z.array(IdSchema).max(ATTACHMENT_TRASH_BATCH) });

export function registerAttachment(tx: Tx, req: DoRequest): OpResult {
  const me = tx.member();
  if (tx.activeRound()?.status !== "COLLECTING") throw notCollecting();
  const body = parseBody(RegisterSchema, req.body);
  const pending = tx.store.count("SELECT COUNT(*) AS n FROM attachments WHERE entry_id IS NULL AND uploader_member_id = ?", me.id);
  if (pending >= LIMITS.pendingAttachmentsPerMember) {
    throw limitExceeded(`You can have at most ${LIMITS.pendingAttachmentsPerMember} unsaved photos. Save or discard an expense first.`);
  }
  if (tx.store.count("SELECT COUNT(*) AS n FROM attachments") >= LIMITS.attachments) {
    throw limitExceeded(`A group can have at most ${LIMITS.attachments} photos.`);
  }
  const id = newId("att");
  tx.store.run(
    `INSERT INTO attachments (id, entry_id, uploader_member_id, content_type, bytes, width, height, position, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, 0, ?)`,
    id,
    me.id,
    body.contentType,
    body.bytes,
    body.width,
    body.height,
    tx.now,
  );
  // A pending upload is private to its uploader: no audit, no version bump, no broadcast.
  return ok(attachmentDto(tx.store.attachment(id)!), 201);
}

/** Members see photos of live entries; a pending photo only its uploader. */
export function readAttachment(tx: Tx, req: DoRequest): DoResponse {
  const me = tx.member();
  const a = tx.store.attachment(req.params.attachmentId ?? "");
  const visible = !!a && (a.entry_id === null ? a.uploader_member_id === me.id : tx.store.entryRow(a.entry_id)?.deleted === 0);
  if (!a || !visible) throw notFound("This photo isn't available.");
  return ok(attachmentDto(a));
}

function trash(tx: Tx, attachmentId: string): void {
  tx.store.run("DELETE FROM attachments WHERE id = ?", attachmentId);
  tx.store.run("INSERT INTO attachment_trash (attachment_id, trashed_at) VALUES (?, ?) ON CONFLICT DO NOTHING", attachmentId, tx.now);
}

/**
 * Makes `ids` (in this order) the entry's photos. New ones must be the actor's pending uploads; photos
 * dropped from the list go to the trash. Callers have already checked the entry is editable by `me`.
 */
export function setEntryAttachments(tx: Tx, entryId: string, ids: string[], me: MemberRow): void {
  ids.forEach((id, i) => {
    const a = tx.store.attachment(id);
    const usable = !!a && (a.entry_id === entryId || (a.entry_id === null && a.uploader_member_id === me.id));
    if (!usable) throw invalid(`attachmentIds.${i}`, "This photo isn't available. Remove it and add it again.");
  });
  const keep = new Set(ids);
  for (const { id } of tx.store.all<{ id: string }>("SELECT id FROM attachments WHERE entry_id = ?", entryId)) {
    if (!keep.has(id)) trash(tx, id);
  }
  ids.forEach((id, position) => {
    tx.store.run(
      "UPDATE attachments SET entry_id = ?, position = ?, attached_at = COALESCE(attached_at, ?) WHERE id = ?",
      entryId,
      position,
      tx.now,
      id,
    );
  });
}

export function trashEntryAttachments(tx: Tx, entryId: string): void {
  for (const { id } of tx.store.all<{ id: string }>("SELECT id FROM attachments WHERE entry_id = ?", entryId)) trash(tx, id);
}

/** Internal (edge cron): expire old pending uploads, then hand out R2 objects to delete. */
export function takeAttachmentTrash(tx: Tx): OpResult {
  if (tx.principal) throw forbidden("Photo cleanup is internal.");
  tx.requireProject();
  const cutoff = new Date(Date.now() - PENDING_ATTACHMENT_TTL_MS).toISOString();
  for (const { id } of tx.store.all<{ id: string }>("SELECT id FROM attachments WHERE entry_id IS NULL AND created_at < ?", cutoff)) {
    trash(tx, id);
  }
  const ids = tx.store
    .all<{ attachment_id: string }>("SELECT attachment_id FROM attachment_trash ORDER BY trashed_at, attachment_id LIMIT ?", ATTACHMENT_TRASH_BATCH)
    .map((r) => r.attachment_id);
  return ok({ ids });
}

/** Internal (edge cron): the R2 objects are gone; forget them. */
export function ackAttachmentTrash(tx: Tx, req: DoRequest): OpResult {
  if (tx.principal) throw forbidden("Photo cleanup is internal.");
  tx.requireProject();
  const { ids } = parseBody(AckSchema, req.body);
  for (const id of ids) tx.store.run("DELETE FROM attachment_trash WHERE attachment_id = ?", id);
  return ok({ ok: true });
}
```

Check `worker/do/errors.ts` exports `notCollecting`, `limitExceeded`, `forbidden`, `invalid`, `notFound`, `parseBody` (it does). `limitExceeded` defaults to status 429.

- [ ] **Step 5: Wire the ops into the DO**

`worker/do/types.ts` — add to `DoOp`:

```ts
  | "registerAttachment" // body { contentType, bytes, width, height, sha256 } (edge-measured) → 201 AttachmentDTO; pending until an entry links it
  | "readAttachment" // read; params.attachmentId → AttachmentDTO when visible to the caller, else 404
  | "takeAttachmentTrash" // internal (principal null, edge cron): expires pending uploads → { ids } of R2 objects to delete
  | "ackAttachmentTrash" // internal (principal null, edge cron): body { ids } deleted from R2 → forgets them
```

`worker/do/ProjectDO.ts`:
- import `{ ackAttachmentTrash, readAttachment, registerAttachment, takeAttachmentTrash }` from `./ops/attachments`;
- add `| "readAttachment"` to `ReadOp` and `readAttachment: (tx, req) => readAttachment(tx, req),` to `READ_OPS`;
- `const KEYLESS_OPS = new Set<DoOp>(["principalUpdated", "anonymizeMember", "takeAttachmentTrash", "ackAttachmentTrash"]);`
- in `mutate`: `case "registerAttachment": return registerAttachment(tx, req);`, `case "takeAttachmentTrash": return takeAttachmentTrash(tx);`, `case "ackAttachmentTrash": return ackAttachmentTrash(tx, req);`.

- [ ] **Step 6: Link and trash from the ledger ops**

In `worker/do/ops/ledger.ts` import `setEntryAttachments, trashEntryAttachments` from `./attachments`.
- `createEntry`: right after `writeSplits(tx, id, p);` add `if (input.attachmentIds?.length) setEntryAttachments(tx, id, input.attachmentIds, me);`
- `updateEntry`: right after `writeSplits(tx, row.id, p);` add `if (input.attachmentIds !== undefined) setEntryAttachments(tx, row.id, input.attachmentIds, me);`
- `deleteEntry`: right after the `UPDATE entries SET deleted = 1 …` call add `trashEntryAttachments(tx, row.id);`

In `worker/do/ops/read.ts` add `"attachments", "attachment_trash",` to `BACKUP_TABLES`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project worker test/do && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add worker/do test/do/attachments.test.ts
git commit -m "feat(worker): register, link, read and purge receipt photos in ProjectDO"
```

---

### Task 5: Edge upload/download routes, bindings and OpenAPI

**Files:**
- Modify: `wrangler.jsonc` (top-level `r2_buckets` line 74 and `ratelimits` 39-46; `env.staging` copies at 88-95 and 117)
- Modify: `worker/worker-configuration.d.ts` (regenerate)
- Modify: `src/shared/api.ts` (`ENDPOINTS`)
- Modify: `worker/lib/http.ts`, `worker/lib/crypto.ts`
- Create: `worker/lib/attachments.ts`
- Create: `worker/routes/attachments.ts`
- Modify: `worker/index.ts`
- Modify: `worker/routes/openapi.ts`
- Modify: `test/edge/helpers.ts` (`CallInit.raw`)
- Modify: `test/edge/routing.test.ts` (`edgeHandled`)
- Test: `test/edge/attachments.test.ts` (create)

**Interfaces:**
- Consumes: DO ops `registerAttachment`, `readAttachment` (Task 4); `sniffImage`, `stripMetadata` (Task 3); fixtures (Task 3).
- Produces: `ENDPOINTS.uploadAttachment = "POST /api/projects/:projectId/attachments"`, `ENDPOINTS.getAttachment = "GET /api/projects/:projectId/attachments/:attachmentId"`; `attachmentKey(projectId, attachmentId): string`, `attachmentPrefix(projectId): string`, `deletePrefix(bucket: R2Bucket, prefix: string): Promise<void>` in `worker/lib/attachments.ts`; `readBodyBytes(req: Request, limit: number): Promise<Uint8Array>`; `sha256HexBytes(bytes: Uint8Array): Promise<string>`; env bindings `ATTACHMENTS: R2Bucket`, `RL_UPLOAD: RateLimit`.

- [ ] **Step 1: Add the bindings and regenerate types**

In `wrangler.jsonc`, top level:

```jsonc
  "r2_buckets": [
    { "binding": "BACKUPS", "bucket_name": "splitdummy-backups" },
    { "binding": "ATTACHMENTS", "bucket_name": "splitdummy-attachments" }
  ],
```

and add to `ratelimits`: `{ "name": "RL_UPLOAD", "namespace_id": "1007", "simple": { "limit": 30, "period": 60 } }`. Under `env.staging`: bucket `splitdummy-staging-attachments` and namespace `2007`.

Run: `npm run cf-typegen`
Expected: `worker/worker-configuration.d.ts` now declares `ATTACHMENTS: R2Bucket` and `RL_UPLOAD: RateLimit`.

- [ ] **Step 2: Add the endpoints and the test helper option**

`src/shared/api.ts` `ENDPOINTS`, after `export`:

```ts
  uploadAttachment: "POST /api/projects/:projectId/attachments", // raw image/webp | image/jpeg body -> 201 AttachmentDTO (pending)
  getAttachment: "GET /api/projects/:projectId/attachments/:attachmentId", // image bytes
```

`test/edge/routing.test.ts`: add `"uploadAttachment", "getAttachment",` to `edgeHandled` (comment: `// Photos: raw-body upload and byte download in routes/attachments.ts.`).

`test/edge/helpers.ts`: add `raw?: { body: Uint8Array; contentType: string };` to `CallInit`, change `let body: string | undefined;` to `let body: BodyInit | undefined;`, and after the JSON block:

```ts
  if (init.raw) {
    body = init.raw.body;
    headers.set("content-type", init.raw.contentType);
  }
```

and use `const method = init.method ?? (init.body !== undefined || init.raw ? "POST" : "GET");`.

- [ ] **Step 3: Write the failing edge tests**

Create `test/edge/attachments.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentDTO, EntryDTO, InvitationDTO, JoinResultDTO, ProjectViewDTO } from "@shared/api";
import { SECRET, includesAscii, jpeg, webp } from "../fixtures/images";
import { call, mockTurnstile, signIn, testEnv, uniqueEmail } from "./helpers";

beforeEach(() => {
  mockTurnstile();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function group() {
  const owner = await signIn(uniqueEmail("owner"));
  const created = await json<ProjectViewDTO>(
    await call("/api/projects", { cookie: owner, body: { name: "Trip", baseCurrency: "PLN", ownerDisplayName: "Ann", turnstileToken: "ok" } }),
    201,
  );
  const projectId = created.project.id;
  const invite = await json<InvitationDTO>(await call(`/api/projects/${projectId}/invitations`, { method: "POST", cookie: owner }), 201);
  const bob = await signIn(uniqueEmail("bob"));
  const token = decodeURIComponent(new URL(invite.url ?? "").hash.slice(1));
  const joined = await json<JoinResultDTO>(await call("/api/invitations/join", { cookie: bob, body: { token, displayName: "Bob" } }));
  return { owner, bob, projectId, roundId: created.current.round.id, ownerMemberId: created.me.memberId, bobMemberId: joined.memberId };
}

const uploadPath = (projectId: string) => `/api/projects/${projectId}/attachments`;
const upload = (projectId: string, cookie: string, bytes: Uint8Array, contentType = "image/webp", extra: Parameters<typeof call>[1] = {}) =>
  call(uploadPath(projectId), { cookie, raw: { body: bytes, contentType }, ...extra });

describe("photo upload", () => {
  it("stores a stripped image privately and serves it to its uploader with immutable caching", async () => {
    const g = await group();
    const a = await json<AttachmentDTO>(await upload(g.projectId, g.owner, webp({ width: 1600, height: 1200, exif: true, xmp: true })), 201);
    expect(a).toMatchObject({ id: expect.stringMatching(/^att_/), contentType: "image/webp", width: 1600, height: 1200 });

    const stored = await testEnv.ATTACHMENTS.get(`projects/${g.projectId}/attachments/${a.id}`);
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(includesAscii(bytes, SECRET)).toBe(false);
    expect(stored!.httpMetadata?.contentType).toBe("image/webp");
    expect(a.bytes).toBe(bytes.length);

    const res = await call(`${uploadPath(g.projectId)}/${a.id}`, { cookie: g.owner });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("shows a photo to other members only once it is saved with an expense, and hides it after deletion", async () => {
    const g = await group();
    const a = await json<AttachmentDTO>(await upload(g.projectId, g.owner, jpeg({ exif: true }), "image/jpeg"), 201);
    const photo = `${uploadPath(g.projectId)}/${a.id}`;
    expect((await call(photo, { cookie: g.bob })).status).toBe(404);

    const entry = await json<EntryDTO>(
      await call(`/api/projects/${g.projectId}/rounds/${g.roundId}/entries`, {
        cookie: g.owner,
        body: {
          type: "EXPENSE", description: "Groceries", occurredAt: "2026-10-01", originalAmount: "4200", originalCurrency: "PLN",
          conversion: { method: "IDENTITY" }, payerMemberId: g.ownerMemberId, splitMode: "EQUAL",
          participants: [{ memberId: g.ownerMemberId }, { memberId: g.bobMemberId }], note: "Receipt attached", attachmentIds: [a.id],
        },
      }),
      201,
    );
    expect(entry.attachments.map((x) => x.id)).toEqual([a.id]);
    expect((await call(photo, { cookie: g.bob })).status).toBe(200);

    const stranger = await signIn(uniqueEmail("stranger"));
    expect((await call(photo, { cookie: stranger })).status).toBe(404);

    await json(await call(`/api/projects/${g.projectId}/rounds/${g.roundId}/entries/${entry.id}`, { method: "DELETE", cookie: g.owner, body: { expectedRevision: 1 } }));
    expect((await call(photo, { cookie: g.bob })).status).toBe(404);
  });

  it("rejects wrong types, mismatched bytes, oversize and oversized dimensions", async () => {
    const g = await group();
    expect((await upload(g.projectId, g.owner, webp(), "image/png")).status).toBe(422);
    expect((await upload(g.projectId, g.owner, webp(), "image/jpeg")).status).toBe(422);
    expect((await upload(g.projectId, g.owner, new Uint8Array([1, 2, 3]))).status).toBe(422);
    expect((await upload(g.projectId, g.owner, webp({ width: 5000, height: 1000 }))).status).toBe(422);
    const huge = new Uint8Array(1_500_001);
    huge.set(webp());
    expect((await upload(g.projectId, g.owner, huge)).status).toBe(413);
    const listed = await testEnv.ATTACHMENTS.list({ prefix: `projects/${g.projectId}/` });
    expect(listed.objects).toHaveLength(0);
  });

  it("requires membership, same origin and an idempotency key", async () => {
    const g = await group();
    const stranger = await signIn(uniqueEmail("stranger"));
    expect((await upload(g.projectId, stranger, webp())).status).toBe(404);
    expect((await upload(g.projectId, g.owner, webp(), "image/webp", { origin: "https://evil.example" })).status).toBe(403);
    expect((await upload(g.projectId, g.owner, webp(), "image/webp", { idempotencyKey: null })).status).toBe(422);
    expect((await upload(g.projectId, "", webp())).status).toBe(401);
  });

  it("repairs a failed R2 write when the client retries with the same key", async () => {
    const g = await group();
    const idempotencyKey = crypto.randomUUID();
    const broken = { ...testEnv, ATTACHMENTS: { put: async () => { throw new Error("r2 down"); } } } as unknown as Env;
    expect((await upload(g.projectId, g.owner, webp(), "image/webp", { idempotencyKey, env: broken })).status).toBe(500);
    const a = await json<AttachmentDTO>(await upload(g.projectId, g.owner, webp(), "image/webp", { idempotencyKey }), 201);
    const again = await json<AttachmentDTO>(await upload(g.projectId, g.owner, webp(), "image/webp", { idempotencyKey }), 201);
    expect(again.id).toBe(a.id);
    expect((await call(`${uploadPath(g.projectId)}/${a.id}`, { cookie: g.owner })).status).toBe(200);
  });

  it("documents both endpoints in OpenAPI", async () => {
    const doc = await json<{ paths: Record<string, Record<string, any>> }>(await call("/api/openapi.json"));
    const up = doc.paths["/api/projects/{projectId}/attachments"]!.post;
    expect(Object.keys(up.requestBody.content).sort()).toEqual(["image/jpeg", "image/webp"]);
    expect(doc.paths["/api/projects/{projectId}/attachments/{attachmentId}"]!.get.responses["200"].content["image/webp"]).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run --project worker test/edge/attachments.test.ts test/edge/routing.test.ts`
Expected: FAIL — 404 Not found for the upload route; routing test fails until the routes exist.

- [ ] **Step 5: Add the body/hash helpers**

`worker/lib/http.ts` — split the streaming read out of `readJsonBody`:

```ts
/** Reads a request body without buffering more than `limit` bytes (413 beyond it). No body → empty array. */
export async function readBodyBytes(req: Request, limit: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw tooLarge();
  if (!req.body) return new Uint8Array();
  // (move the existing reader loop and the chunk concatenation here unchanged; return `bytes`)
}

/** Reads a JSON body without buffering more than `limit` bytes. Empty body → undefined. */
export async function readJsonBody(req: Request, limit = MAX_JSON_BYTES): Promise<unknown> {
  const bytes = await readBodyBytes(req, limit);
  if (bytes.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("VALIDATION", "Request body must be valid JSON.");
  }
}
```

`worker/lib/crypto.ts`:

```ts
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

Create `worker/lib/attachments.ts`:

```ts
/** R2 layout of receipt photos: projects/<projectId>/attachments/<attachmentId>. */
const R2_DELETE_BATCH = 1000;

export const attachmentPrefix = (projectId: string) => `projects/${projectId}/attachments/`;
export const attachmentKey = (projectId: string, attachmentId: string) => `${attachmentPrefix(projectId)}${attachmentId}`;

/** Deletes every object under `prefix`, a page at a time. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: R2_DELETE_BATCH });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
```

- [ ] **Step 6: Implement the routes**

Create `worker/routes/attachments.ts`:

```ts
/** Receipt photos: raw-body upload (validated, metadata stripped) and member-only download. */
import { Hono } from "hono";
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_IMAGE_EDGE, type AttachmentDTO } from "@shared/api";
import { requireIdempotencyKey, requireSession } from "../auth/middleware";
import { toPrincipal } from "../auth/principals";
import { attachmentKey } from "../lib/attachments";
import type { AppEnv } from "../lib/context";
import { sha256HexBytes } from "../lib/crypto";
import { ApiError, notFound } from "../lib/errors";
import { readBodyBytes } from "../lib/http";
import { sniffImage, stripMetadata } from "../lib/image";
import { callProject, isOk, toHttpResponse } from "../lib/project";
import { enforceLimit } from "../lib/ratelimit";
import { splitEndpoint, validateParams } from "./projects";

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.post(splitEndpoint("uploadAttachment").path, async (c) => {
  const { principal } = await requireSession(c);
  const params = c.req.param() as Record<string, string>;
  validateParams(params);
  const projectId = params.projectId!;
  const idempotencyKey = requireIdempotencyKey(c);
  await enforceLimit(c.env.RL_UPLOAD, `principal:${principal.id}`);

  const declared = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(declared)) {
    throw new ApiError("VALIDATION", "Upload a JPEG or WebP image.", { field: "Content-Type" });
  }
  const raw = await readBodyBytes(c.req.raw, MAX_ATTACHMENT_BYTES);
  const info = sniffImage(raw);
  if (!info || info.type !== declared) throw new ApiError("VALIDATION", "This file isn't a valid JPEG or WebP image.");
  if (info.width > MAX_IMAGE_EDGE || info.height > MAX_IMAGE_EDGE) {
    throw new ApiError("VALIDATION", `Photos can be at most ${MAX_IMAGE_EDGE} pixels on each side.`);
  }
  const bytes = stripMetadata(raw, info.type);

  const res = await callProject(c.env, {
    op: "registerAttachment",
    projectId,
    principal: toPrincipal(principal),
    params,
    body: { contentType: info.type, bytes: bytes.length, width: info.width, height: info.height, sha256: await sha256HexBytes(bytes) },
    idempotencyKey,
    requestId: c.get("requestId"),
  });
  if (isOk(res)) {
    const dto = res.body as AttachmentDTO;
    // A replay (same key) writes the same bytes again, which repairs a put that failed last time.
    await c.env.ATTACHMENTS.put(attachmentKey(projectId, dto.id), bytes, { httpMetadata: { contentType: dto.contentType } });
  }
  return toHttpResponse(c, res, "registerAttachment");
});

attachmentRoutes.get(splitEndpoint("getAttachment").path, async (c) => {
  const { principal } = await requireSession(c);
  const params = c.req.param() as Record<string, string>;
  validateParams(params);
  const projectId = params.projectId!;
  const res = await callProject(c.env, { op: "readAttachment", projectId, principal: toPrincipal(principal), params, requestId: c.get("requestId") });
  if (!isOk(res)) return toHttpResponse(c, res, "readAttachment");
  const dto = res.body as AttachmentDTO;
  const object = await c.env.ATTACHMENTS.get(attachmentKey(projectId, dto.id));
  if (!object) throw notFound("This photo isn't available.");
  return c.body(object.body, 200, {
    "Content-Type": dto.contentType,
    "Content-Length": String(object.size),
    // Ids are never reused and objects never change.
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
  });
});
```

`worker/index.ts`: import `attachmentRoutes` and add `app.route("/", attachmentRoutes);` before `app.route("/", projectRoutes);`. In the `/api/*` header middleware replace `c.res.headers.set("Cache-Control", "no-store");` with:

```ts
  // Routes that set their own caching (photos) keep it; everything else is never cached.
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
```

- [ ] **Step 7: Document both endpoints in OpenAPI**

In `worker/routes/openapi.ts`:

```ts
const attachment = object({ id, contentType: z.enum(api.ATTACHMENT_TYPES), bytes: z.number(), width: z.number(), height: z.number() });
```

(declare above `entry`) and add `note: nullableText, attachments: z.array(attachment)` to `entry`. Extend `Operation` with `rawBody?: readonly string[]; binaryResponse?: readonly string[];` and add to `operations`:

```ts
  uploadAttachment: { summary: "Upload a receipt photo", description: "Send the image bytes as the request body with Content-Type image/jpeg or image/webp (at most 1.5 MB and 4096 px per side). Photo metadata, including EXIF orientation, is removed, so upload upright images. The photo is visible only to you until you attach it with attachmentIds on createEntry or updateEntry; unattached uploads are deleted after 24 hours. Collecting round only.", rawBody: api.ATTACHMENT_TYPES, response: attachment, created: true },
  getAttachment: { summary: "Download a receipt photo", description: "Members see photos of saved entries; a not-yet-attached upload only its uploader.", binaryResponse: api.ATTACHMENT_TYPES },
```

Also extend the `createEntry` description with: `Optional note (≤ 1000 characters) and attachmentIds (≤ 5, from uploadAttachment).` and the `updateEntry` description with: `Omitting note or attachmentIds keeps them; null or [] clears them.`

In `openApiDocument`, replace the `requestBody` spread and the `responses` content with:

```ts
      ...(definition.body
        ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(definition.body, "input") } } } }
        : definition.rawBody
          ? { requestBody: { required: true, content: Object.fromEntries(definition.rawBody.map((t) => [t, { schema: { type: "string", format: "binary" } }])) } }
          : {}),
      responses: { [definition.created ? "201" : "200"]: { description: "Success", content: key === "export"
        ? { "text/csv": { schema: { type: "string" } } }
        : definition.binaryResponse
          ? Object.fromEntries(definition.binaryResponse.map((t) => [t, { schema: { type: "string", format: "binary" } }]))
          : { "application/json": { schema: jsonSchema(definition.response ?? ok) } } }, ...errors },
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run --project worker && npm run typecheck`
Expected: PASS (the whole worker project, including routing, observability and api-keys tests).

- [ ] **Step 9: Commit**

```bash
git add wrangler.jsonc worker src/shared/api.ts test/edge
git commit -m "feat(worker): photo upload and download endpoints backed by a private R2 bucket"
```

---

### Task 6: Nightly purge and group-deletion cleanup

**Files:**
- Modify: `worker/queue/scheduled.ts`
- Modify: `worker/routes/account.ts` (`forgetProject` at 64-80 and its two callers)
- Test: `test/edge/cron.test.ts`, `test/edge/account.test.ts`

**Interfaces:**
- Consumes: DO ops `takeAttachmentTrash`, `ackAttachmentTrash` (Task 4); `attachmentKey`, `attachmentPrefix`, `deletePrefix` (Task 5); `ATTACHMENT_TRASH_BATCH` (Task 4).
- Produces: `purgeAttachments(env: Env): Promise<{ deleted: number; failed: number }>` in `worker/queue/scheduled.ts`.

- [ ] **Step 1: Write the failing cron tests**

In `test/edge/cron.test.ts`, change the first test's mock to answer per op and filter its assertion to backups:

```ts
    const { calls } = mockProjectDO((req) =>
      req.op === "backupSnapshot" ? { status: 200, body: { projectId: req.params.projectId, tables: { entries: [] } } } : { status: 200, body: { ids: [] } },
    );
    …
    expect(calls.filter((c) => c.op === "backupSnapshot").map((c) => [c.op, c.principal, c.params.projectId]).sort()).toEqual(ids.map((id) => ["backupSnapshot", null, id]));
```

and the housekeeping test's mock to `mockProjectDO(() => ({ status: 200, body: { ids: [] } }))`. Add:

```ts
describe("scheduled photo purge", () => {
  const projectId = `p_${"3".repeat(32)}`;
  const key = (id: string) => `projects/${projectId}/attachments/${id}`;

  async function seedDirectory() {
    await testEnv.DB.prepare(
      `INSERT INTO project_directory (principal_id, project_id, member_id, is_owner, status, name, base_currency, project_version, updated_at)
       VALUES ('pr_z', ?, 'm', 1, 'ACTIVE', 'n', 'EUR', 1, '2026-01-01T00:00:00Z')`,
    ).bind(projectId).run();
  }

  it("deletes trashed photos from R2, then acknowledges them", async () => {
    await seedDirectory();
    await testEnv.ATTACHMENTS.put(key("att_gone"), "x");
    await testEnv.ATTACHMENTS.put(key("att_kept"), "y");
    const { calls } = mockProjectDO((req) =>
      req.op === "takeAttachmentTrash" ? { status: 200, body: { ids: ["att_gone"] } } : { status: 200, body: { ok: true, tables: {} } },
    );
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController(), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(await testEnv.ATTACHMENTS.head(key("att_gone"))).toBeNull();
    expect(await testEnv.ATTACHMENTS.head(key("att_kept"))).not.toBeNull();
    expect(calls.find((c) => c.op === "ackAttachmentTrash")).toMatchObject({ principal: null, body: { ids: ["att_gone"] } });
  });

  it("does not acknowledge when the R2 delete fails", async () => {
    await seedDirectory();
    const { calls } = mockProjectDO((req) =>
      req.op === "takeAttachmentTrash" ? { status: 200, body: { ids: ["att_x"] } } : { status: 200, body: { ok: true, tables: {} } },
    );
    const broken = { ...testEnv, ATTACHMENTS: { delete: async () => { throw new Error("r2 down"); } } } as unknown as Env;
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController(), broken, ctx);
    await waitOnExecutionContext(ctx);
    expect(calls.some((c) => c.op === "ackAttachmentTrash")).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing account test**

In `test/edge/account.test.ts`, in the test that puts backups at lines 120-121 and asserts at 180-181, also put photos and assert:

```ts
    await testEnv.ATTACHMENTS.put(`projects/${ownedId}/attachments/att_owned`, "x");
    await testEnv.ATTACHMENTS.put(`projects/${joinedId}/attachments/att_joined`, "y");
    …
    expect((await testEnv.ATTACHMENTS.list({ prefix: `projects/${ownedId}/` })).objects).toHaveLength(0);
    expect((await testEnv.ATTACHMENTS.list({ prefix: `projects/${joinedId}/` })).objects).toHaveLength(1);
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run --project worker test/edge/cron.test.ts test/edge/account.test.ts`
Expected: FAIL — `att_gone` still exists; owned photos remain.

- [ ] **Step 4: Implement the purge**

In `worker/queue/scheduled.ts`, extract the shared fan-out and add the purge:

```ts
import { ATTACHMENT_TRASH_BATCH } from "../do/limits";
import { attachmentKey } from "../lib/attachments";

/** Daily cron: versioned R2 backups of every project, photo cleanup, then D1 housekeeping. */
export async function handleScheduled(env: Env): Promise<void> {
  await backupAllProjects(env);
  await purgeAttachments(env);
  await housekeeping(env);
}

/** Runs `fn` for every directory project, BACKUP_CONCURRENCY at a time; counts failures (logged by the caller). */
async function forEachProject(env: Env, fn: (projectId: string) => Promise<void>, label: string): Promise<{ ok: number; failed: number }> {
  const { results } = await env.DB.prepare("SELECT DISTINCT project_id FROM project_directory").all<{ project_id: string }>();
  const queue = results.map((r) => r.project_id);
  let ok = 0;
  let failed = 0;
  const worker = async () => {
    for (let projectId = queue.shift(); projectId; projectId = queue.shift()) {
      try {
        await fn(projectId);
        ok++;
      } catch (err) {
        failed++;
        logError(`${label} failed`, err, { projectId });
      }
    }
  };
  await Promise.all(Array.from({ length: BACKUP_CONCURRENCY }, worker));
  return { ok, failed };
}
```

Rewrite `backupAllProjects` to call `forEachProject(env, async (projectId) => { …existing body of the try… }, "project backup")` and keep its `logInfo("backup finished", …)` and return value. Then:

```ts
/** Deletes trashed photos from R2 and only then lets the DO forget them, so a failed delete is retried tomorrow. */
export async function purgeAttachments(env: Env): Promise<{ deleted: number; failed: number }> {
  const requestId = `cron_${new Date().toISOString()}`;
  let deleted = 0;
  const { failed } = await forEachProject(env, async (projectId) => {
    for (;;) {
      const taken = await callProject(env, { op: "takeAttachmentTrash", projectId, principal: null, requestId });
      if (!isOk(taken)) throw new Error(`takeAttachmentTrash status ${taken.status}`);
      const { ids } = taken.body as { ids: string[] };
      if (ids.length === 0) return;
      await env.ATTACHMENTS.delete(ids.map((id) => attachmentKey(projectId, id)));
      const ack = await callProject(env, { op: "ackAttachmentTrash", projectId, principal: null, body: { ids }, requestId });
      if (!isOk(ack)) throw new Error(`ackAttachmentTrash status ${ack.status}`);
      deleted += ids.length;
      if (ids.length < ATTACHMENT_TRASH_BATCH) return;
    }
  }, "photo purge");
  logInfo("photo purge finished", { deleted, failed });
  return { deleted, failed };
}
```

- [ ] **Step 5: Purge photos with a deleted group**

In `worker/routes/account.ts`, import `{ attachmentPrefix, deletePrefix }` from `../lib/attachments` and rewrite `forgetProject`:

```ts
/** A deleted project: its stored files (owner's deletion only: backups, photos), then every member's directory row behind a tombstone. */
async function forgetProject(env: Env, projectId: string, purgeStorage: boolean): Promise<void> {
  if (purgeStorage) {
    await deletePrefix(env.BACKUPS, `projects/${projectId}/`);
    await deletePrefix(env.ATTACHMENTS, attachmentPrefix(projectId));
  }
  // (unchanged D1 batch)
}
```

Remove the now-unused `R2_DELETE_BATCH` constant from `account.ts` if nothing else uses it.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project worker && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/queue/scheduled.ts worker/routes/account.ts test/edge/cron.test.ts test/edge/account.test.ts
git commit -m "feat(worker): purge removed and abandoned photos nightly and with deleted groups"
```

---

### Task 7: Web API client (HTTP + mock)

**Files:**
- Modify: `src/web/api/types.ts` (`Api`)
- Modify: `src/web/api/http.ts` (`once`, returned object)
- Modify: `src/web/api/mock.ts` (module-level photo store, `buildEntry`, API methods)
- Test: `src/web/api/http.test.ts`, `src/web/api/mock.test.ts`

**Interfaces:**
- Consumes: `AttachmentDTO`, `EntryInput.attachmentIds` (Task 1); `ENDPOINTS.uploadAttachment/getAttachment` paths (Task 5).
- Produces: `Api.uploadAttachment(projectId: string, image: Blob, o: MutationOptions): Promise<AttachmentDTO>`; `Api.attachmentUrl(projectId: string, attachmentId: string): string`.

- [ ] **Step 1: Write the failing tests**

Append to `src/web/api/http.test.ts`:

```ts
  it("uploads a photo as its raw bytes and retries with the same key", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(json(201, { id: "att_1", contentType: "image/webp", bytes: 3, width: 1, height: 1 }));
    const api = createHttpApi({ fetch, retryDelayMs: () => 0 });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
    await expect(api.uploadAttachment("p_1", blob, { idempotencyKey: "key-photo" })).resolves.toMatchObject({ id: "att_1" });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe("/api/projects/p_1/attachments");
      expect(init?.body).toBe(blob);
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("image/webp");
      expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-photo");
    }
    expect(api.attachmentUrl("p_1", "att_1")).toBe("/api/projects/p_1/attachments/att_1");
  });
```

Append to `src/web/api/mock.test.ts`:

```ts
describe("mock photos", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });

  it("links an uploaded photo, keeps it when an update omits it, and rejects someone else's upload", async () => {
    const api = as("pr_maya");
    const view = await api.getProject("p_lisbon");
    const round = view.current.round.id;
    const photo = await api.uploadAttachment("p_lisbon", new Blob(["x"], { type: "image/webp" }), o());
    expect(api.attachmentUrl("p_lisbon", photo.id)).toBeTruthy();
    const body = {
      type: "EXPENSE" as const, description: "Taxi", occurredAt: "2026-09-20", originalAmount: "1500", originalCurrency: view.project.baseCurrency,
      conversion: { method: "IDENTITY" as const }, payerMemberId: view.me.memberId, splitMode: "EQUAL" as const,
      participants: [{ memberId: view.me.memberId }],
    };
    await api.createEntry("p_lisbon", round, { ...body, note: "Airport", attachmentIds: [photo.id] }, o());
    let entry = (await api.getProject("p_lisbon")).current.entries.find((e) => e.description === "Taxi")!;
    expect(entry).toMatchObject({ note: "Airport", attachments: [{ id: photo.id }] });
    await api.updateEntry("p_lisbon", round, entry.id, { ...body, expectedRevision: entry.revision }, o());
    entry = (await api.getProject("p_lisbon")).current.entries.find((e) => e.id === entry.id)!;
    expect(entry.attachments.map((a) => a.id)).toEqual([photo.id]);
    await expect(api.createEntry("p_lisbon", round, { ...body, attachmentIds: ["att_missing"] }, o())).rejects.toMatchObject({ status: 422, field: "attachmentIds.0" });
  });
});
```

Check the seed data in `mock.ts` for an actual principal/project pair (`p_lisbon` with its owner principal) and adjust `as("pr_maya")` accordingly.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project web src/web/api`
Expected: FAIL — `uploadAttachment` is not a function.

- [ ] **Step 3: Extend the interface and the HTTP client**

`src/web/api/types.ts` — import `AttachmentDTO` and add to `Api` after `createAdjustment`:

```ts
  /** Uploads one compressed photo. It stays private to you until an entry save lists it in attachmentIds. */
  uploadAttachment(projectId: string, image: Blob, o: MutationOptions): Promise<AttachmentDTO>;
  /** Same-origin URL for <img src>; the session cookie authenticates it. */
  attachmentUrl(projectId: string, attachmentId: string): string;
```

`src/web/api/http.ts` — in `once`, send Blobs as-is:

```ts
    const raw = body instanceof Blob;
    …
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": raw ? body.type : "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
```

and add to the returned object:

```ts
    uploadAttachment: (id, image, o) => request<AttachmentDTO>("POST", `${P(id)}/attachments`, image, o),
    attachmentUrl: (id, attachmentId) => `${P(id)}/attachments/${enc(attachmentId)}`,
```

(import `AttachmentDTO`).

- [ ] **Step 4: Implement the mock**

In `src/web/api/mock.ts`, above `buildEntry`:

```ts
/** In-memory only: object URLs don't survive a reload, so persisted entries fall back to a placeholder image. */
const mockPhotos = new Map<string, { dto: AttachmentDTO; url: string; uploader: string; entryId: string | null }>();
const PLACEHOLDER_PHOTO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="100%" height="100%" fill="#e5e7eb"/><text x="50%" y="50%" text-anchor="middle" fill="#6b7280" font-family="sans-serif" font-size="20">Receipt</text></svg>');
```

In `buildEntry`, compute the id first (`const id = prev?.id ?? uid("e_");` and use it in the returned object) and replace `attachments: prev?.attachments ?? []` with:

```ts
    attachments:
      body.attachmentIds === undefined
        ? (prev?.attachments ?? [])
        : body.attachmentIds.map((aid, i) => {
            const kept = prev?.attachments?.find((a) => a.id === aid);
            if (kept) return kept;
            const photo = mockPhotos.get(aid);
            if (!photo || photo.entryId !== null || photo.uploader !== actor) {
              fail(422, "VALIDATION", "This photo isn't available. Remove it and add it again.", `attachmentIds.${i}`);
            }
            photo.entryId = id;
            return photo.dto;
          }),
```

Add to the API object (next to `createEntry`):

```ts
    uploadAttachment: (id, image, o) =>
      mutate(o, null, "ATTACHMENT_UPLOADED", () => {
        const p = proj(id);
        const m = memberOf(p);
        collecting(p, active(p).round.id);
        const dto: AttachmentDTO = { id: uid("att_"), contentType: image.type === "image/jpeg" ? "image/jpeg" : "image/webp", bytes: image.size, width: 0, height: 0 };
        const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(image) : PLACEHOLDER_PHOTO;
        mockPhotos.set(dto.id, { dto, url, uploader: m.id, entryId: null });
        return dto;
      }),
    attachmentUrl: (_id, attachmentId) => mockPhotos.get(attachmentId)?.url ?? PLACEHOLDER_PHOTO,
```

(`mutate(o, null, …)` doesn't bump a project version, matching the server; confirm the helper names `proj`, `memberOf`, `collecting`, `active` against the file and use the existing ones.)

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project web && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/api
git commit -m "feat(web): photo upload and URLs in the HTTP client and mock API"
```

---

### Task 8: Browser receipt compression

**Files:**
- Create: `src/web/lib/receiptImage.ts`
- Test: `src/web/lib/receiptImage.test.ts`

**Interfaces:**
- Produces: `compressReceipt(file: Blob, codec?: ImageCodec): Promise<CompressedImage>` where `CompressedImage = { blob: Blob; width: number; height: number }`; `ImageReadError` (message "Couldn't read this image — try a JPEG or PNG."); `ImageCodec`; `fitWithin(width, height, edge)`; `encodeOnCanvas(canvas: CanvasLike, source, width, height, type, quality): Promise<Blob>`; `browserCodec`.

- [ ] **Step 1: Write the failing tests**

Create `src/web/lib/receiptImage.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { compressReceipt, encodeOnCanvas, fitWithin, ImageReadError, type ImageCodec } from "./receiptImage";

type Call = { width: number; height: number; type: string; quality: number };

function codec(opts: { width: number; height: number; webp?: boolean; size?: (c: Call) => number; failDecode?: boolean }) {
  const calls: Call[] = [];
  const close = vi.fn();
  const c: ImageCodec = {
    decode: async () => {
      if (opts.failDecode) throw new Error("HEIC");
      return { width: opts.width, height: opts.height, source: {} as CanvasImageSource, close };
    },
    encode: async (_s, width, height, type, quality) => {
      const call = { width, height, type, quality };
      calls.push(call);
      const actual = type === "image/webp" && opts.webp === false ? "image/png" : type;
      return new Blob([new Uint8Array(opts.size?.(call) ?? 300_000)], { type: actual });
    },
  };
  return { c, calls, close };
}

const file = new Blob(["x"], { type: "image/jpeg" });

describe("compressReceipt", () => {
  it("scales the long edge to 2000 px and encodes WebP at 0.8", async () => {
    const { c, calls, close } = codec({ width: 4000, height: 3000 });
    const out = await compressReceipt(file, c);
    expect(calls).toEqual([{ width: 2000, height: 1500, type: "image/webp", quality: 0.8 }]);
    expect(out).toMatchObject({ width: 2000, height: 1500 });
    expect(out.blob.type).toBe("image/webp");
    expect(close).toHaveBeenCalled();
  });

  it("scales a 48 MP photo down before encoding", async () => {
    const { c, calls } = codec({ width: 6000, height: 8000 });
    await compressReceipt(file, c);
    expect(calls[0]).toMatchObject({ width: 1500, height: 2000 });
  });

  it("never upscales small images", async () => {
    const { c, calls } = codec({ width: 800, height: 600 });
    await compressReceipt(file, c);
    expect(calls[0]).toMatchObject({ width: 800, height: 600 });
  });

  it("falls back to JPEG where WebP encoding isn't supported, and stays on JPEG", async () => {
    const { c, calls } = codec({ width: 3000, height: 2000, webp: false, size: (x) => (x.quality > 0.7 ? 1_000_000 : 500_000) });
    const out = await compressReceipt(file, c);
    expect(calls.map((x) => [x.type, x.quality])).toEqual([
      ["image/webp", 0.8],
      ["image/jpeg", 0.82],
      ["image/jpeg", 0.72],
    ]);
    expect(out.blob.type).toBe("image/jpeg");
  });

  it("steps quality down, then size, to fit 900 KB; returns the smallest if nothing fits", async () => {
    const { c, calls } = codec({ width: 4000, height: 3000, size: (x) => (x.width === 1600 ? 950_000 : 1_200_000) });
    const out = await compressReceipt(file, c);
    expect(calls.map((x) => [x.width, x.quality])).toEqual([
      [2000, 0.8],
      [2000, 0.7],
      [2000, 0.6],
      [1600, 0.7],
    ]);
    expect(out.width).toBe(1600);
    expect(out.blob.size).toBe(950_000);
  });

  it("reports undecodable files with a friendly error", async () => {
    const { c } = codec({ width: 1, height: 1, failDecode: true });
    await expect(compressReceipt(file, c)).rejects.toBeInstanceOf(ImageReadError);
    await expect(compressReceipt(file, c)).rejects.toThrow("Couldn't read this image — try a JPEG or PNG.");
  });
});

describe("fitWithin", () => {
  it("keeps at least one pixel per side", () => {
    expect(fitWithin(10000, 1, 2000)).toEqual({ width: 2000, height: 1 });
  });
});

describe("encodeOnCanvas", () => {
  it("paints white before drawing so transparent images don't turn black as JPEG", async () => {
    const ops: string[] = [];
    const ctx = {
      set fillStyle(v: string) { ops.push(`fill:${v}`); },
      fillRect: () => ops.push("fillRect"),
      drawImage: () => ops.push("draw"),
      imageSmoothingQuality: "low",
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toBlob: (cb: (b: Blob | null) => void, type: string) => cb(new Blob(["x"], { type })),
    };
    const blob = await encodeOnCanvas(canvas, {} as CanvasImageSource, 100, 50, "image/jpeg", 0.82);
    expect(ops).toEqual(["fill:#ffffff", "fillRect", "draw"]);
    expect(blob.type).toBe("image/jpeg");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project web src/web/lib/receiptImage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/lib/receiptImage.ts`**

```ts
/**
 * Receipt photo compression before upload: upright, long edge ≤ 2000 px, WebP (JPEG where the browser can't
 * encode WebP), stepped down to fit the size budget. Re-encoding also drops EXIF/GPS metadata.
 */
export const MAX_EDGE = 2000;
const SMALL_EDGE = 1600;
export const SIZE_BUDGET = 900_000;

/** Quality steps; JPEG needs slightly more quality than WebP for legible small print. */
const STEPS = [
  { edge: MAX_EDGE, webp: 0.8, jpeg: 0.82 },
  { edge: MAX_EDGE, webp: 0.7, jpeg: 0.72 },
  { edge: MAX_EDGE, webp: 0.6, jpeg: 0.62 },
  { edge: SMALL_EDGE, webp: 0.7, jpeg: 0.72 },
];

type OutputType = "image/webp" | "image/jpeg";

export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  close(): void;
}

export interface ImageCodec {
  decode(file: Blob): Promise<DecodedImage>;
  encode(source: CanvasImageSource, width: number, height: number, type: OutputType, quality: number): Promise<Blob>;
}

export interface CompressedImage {
  blob: Blob;
  width: number;
  height: number;
}

export class ImageReadError extends Error {
  constructor() {
    super("Couldn't read this image — try a JPEG or PNG.");
  }
}

export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function compressReceipt(file: Blob, codec: ImageCodec = browserCodec): Promise<CompressedImage> {
  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    throw new ImageReadError();
  }
  try {
    let type: OutputType = "image/webp";
    let best: CompressedImage | null = null;
    for (const step of STEPS) {
      const size = fitWithin(image.width, image.height, step.edge);
      let blob = await codec.encode(image.source, size.width, size.height, type, type === "image/webp" ? step.webp : step.jpeg);
      if (type === "image/webp" && blob.type !== "image/webp") {
        type = "image/jpeg"; // e.g. Safari silently returns PNG for WebP
        blob = await codec.encode(image.source, size.width, size.height, type, step.jpeg);
      }
      const result = { blob, ...size };
      if (!best || blob.size < best.blob.size) best = result;
      if (blob.size <= SIZE_BUDGET) return result;
    }
    return best!;
  } finally {
    image.close();
  }
}

/** The bits of HTMLCanvasElement we use; a fake in tests. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: "2d"): Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect" | "drawImage" | "imageSmoothingQuality"> | null;
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

export async function encodeOnCanvas(canvas: CanvasLike, source: CanvasImageSource, width: number, height: number, type: OutputType, quality: number): Promise<Blob> {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  // JPEG has no alpha: transparent screenshots would otherwise turn black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // Release the backing store early; iOS caps total canvas memory.
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("Couldn't encode the image");
  return blob;
}

export const browserCodec: ImageCodec = {
  async decode(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
      } catch {
        // Some browsers decode more formats through <img>; try that next.
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => URL.revokeObjectURL(url) };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  },
  encode: (source, width, height, type, quality) => encodeOnCanvas(document.createElement("canvas"), source, width, height, type, quality),
};
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project web src/web/lib/receiptImage.test.ts && npm run typecheck`
Expected: PASS. (If the setter-based `fillStyle` fake trips the `Pick<CanvasRenderingContext2D, …>` type, cast the fake ctx in the test with `as unknown as CanvasLike["getContext"] extends (k: "2d") => infer R ? R : never` or simply `as any`.)

- [ ] **Step 5: Commit**

```bash
git add src/web/lib/receiptImage.ts src/web/lib/receiptImage.test.ts
git commit -m "feat(web): compress receipt photos to WebP/JPEG before upload"
```

---

### Task 9: Expense form — note and photos

**Files:**
- Modify: `src/web/lib/entryForm.ts` (`EntryDraft`, `emptyDraft`, `draftFromEntry`, `evaluateEntry`, `formFieldFor`; add `withDraftDefaults`)
- Modify: `src/web/lib/drafts.ts` (`loadDraft`, `findRejectedDraft`)
- Create: `src/web/lib/usePhotoUploads.ts`
- Create: `src/web/pages/group/NoteAndPhotos.tsx`
- Modify: `src/web/pages/group/EntryForm.tsx`
- Modify: `src/web/styles/pages.css`
- Test: `src/web/lib/entryForm.test.ts`, `src/web/pages/group/EntryForm.test.tsx`

**Interfaces:**
- Consumes: `NoteSchema`, `NOTE_MAX`, `MAX_ATTACHMENTS_PER_ENTRY` (Task 1); `Api.uploadAttachment`, `Api.attachmentUrl` (Task 7); `compressReceipt` (Task 8).
- Produces: `EntryDraft.note: string`, `EntryDraft.attachmentIds: string[]`; `withDraftDefaults(d: Partial<EntryDraft> & Omit<EntryDraft, "note" | "attachmentIds">): EntryDraft`; `usePhotoUploads(opts): PhotoUploads` with `PhotoTile { key: string; id: string | null; src: string; status: "compressing" | "uploading" | "done" | "failed"; error: string | null; canRetry: boolean }` and `PhotoUploads { tiles; add(files: File[]): void; remove(key: string): void; retry(key: string): void; markBroken(key: string): void; markFailedAt(index: number, message: string): void; busy: boolean; failed: boolean; full: boolean }`.

- [ ] **Step 1: Write the failing pure tests**

Append to `src/web/lib/entryForm.test.ts` (reuse its existing context/view fixtures; names below follow that file — adjust to what it defines):

```ts
describe("note and photos in drafts", () => {
  it("sends the trimmed note and photo ids; an empty note becomes null", () => {
    const d = { ...validDraft(), note: "  Tip incl.  ", attachmentIds: ["att_1", "att_2"] };
    expect(evaluateEntry(d, ctx).body).toMatchObject({ note: "Tip incl.", attachmentIds: ["att_1", "att_2"] });
    expect(evaluateEntry({ ...d, note: "   " }, ctx).body).toMatchObject({ note: null });
  });

  it("flags a note over 1000 characters", () => {
    const ev = evaluateEntry({ ...validDraft(), note: "x".repeat(1001), attachmentIds: [] }, ctx);
    expect(ev.errors.note).toBe("Keep the note under 1000 characters");
    expect(ev.body).toBeNull();
  });

  it("fills defaults for drafts saved before notes existed", () => {
    const { note: _n, attachmentIds: _a, ...old } = validDraft();
    expect(withDraftDefaults(old)).toMatchObject({ note: "", attachmentIds: [] });
  });

  it("maps server photo errors onto the photos field", () => {
    expect(formFieldFor("attachmentIds.2", [])).toBe("photos");
    expect(formFieldFor("note", [])).toBe("note");
  });
});
```

If `entryForm.test.ts` has no `validDraft()` helper, add one built from `emptyDraft(…)` with a description and amount filled in.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project web src/web/lib/entryForm.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend the draft model**

In `src/web/lib/entryForm.ts`:
- import `NoteSchema` from `@shared/api`;
- add to `EntryDraft` (before the local-only fields): `/** Free text; "" when none. */ note: string;` and `/** Uploaded photo ids in display order. */ attachmentIds: string[];`
- `emptyDraft`: `note: "", attachmentIds: [],`
- `draftFromEntry`: `note: e.note ?? "", attachmentIds: e.attachments.map((a) => a.id),`
- add

```ts
/** Drafts stored before notes/photos existed lack those fields. */
export function withDraftDefaults(d: Omit<EntryDraft, "note" | "attachmentIds"> & Partial<Pick<EntryDraft, "note" | "attachmentIds">>): EntryDraft {
  return { ...d, note: d.note ?? "", attachmentIds: d.attachmentIds ?? [] };
}
```

- in `evaluateEntry`, next to the description check:

```ts
  const note = NoteSchema.safeParse(d.note);
  if (!note.success) errors.note = note.error.issues[0]?.message ?? "This note is too long";
```

and add to `body`: `note: note.success && note.data ? note.data : null, attachmentIds: d.attachmentIds,` (make sure `ok` also requires `note.success`, which it does implicitly via `errors`).
- `formFieldFor`: first line `if (serverField.startsWith("attachmentIds")) return "photos";`

In `src/web/lib/drafts.ts`, wrap parsed drafts: `return raw ? withDraftDefaults(JSON.parse(raw)) : null;` and in `findRejectedDraft` `return { slot: …, draft: withDraftDefaults(d) };`.

Run: `npx vitest run --project web src/web/lib/entryForm.test.ts` → PASS.

- [ ] **Step 4: Write the failing form tests**

Add to `src/web/pages/group/EntryForm.test.tsx` (top-level, before `describe`):

```ts
import { vi } from "vitest";

vi.mock("../../lib/receiptImage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/receiptImage")>()),
  compressReceipt: vi.fn(async (f: Blob) => ({ blob: new Blob([f], { type: "image/webp" }), width: 10, height: 10 })),
}));

const photoInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
/** Every tile finished compressing and uploading (Save is disabled until then). */
const uploadsSettled = () => waitFor(() => expect(screen.queryByText(/Preparing…|Uploading…/)).toBeNull());
const pick = (...names: string[]) =>
  fireEvent.change(photoInput(), { target: { files: names.map((n) => new File(["img"], n, { type: "image/jpeg" })) } });
```

and inside `describe("expense form", …)`:

```ts
  it("saves a note and an uploaded photo with the expense", async () => {
    const view = await newSingleCurrencyGroup(api);
    renderAt(api, `/g/${view.project.id}/new`);
    fireEvent.change(await screen.findByLabelText("What was it?", { selector: "input" }), { target: { value: "Groceries" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), { target: { value: "42" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Split the wine separately next time" } });
    pick("bill.jpg");
    await screen.findByRole("button", { name: "Remove photo 1" });
    await uploadsSettled();
    fireEvent.submit(document.getElementById("entry-form")!);
    await waitFor(async () => {
      const saved = (await api.getProject(view.project.id)).current.entries.find((e) => e.description === "Groceries");
      expect(saved).toMatchObject({ note: "Split the wine separately next time", attachments: [expect.objectContaining({ contentType: "image/webp" })] });
    });
  });

  it("blocks saving while an upload failed, and retries it", async () => {
    const view = await newSingleCurrencyGroup(api);
    const real = api.uploadAttachment.bind(api);
    const spy = vi.spyOn(api, "uploadAttachment").mockRejectedValueOnce(new Error("offline")).mockImplementation(real);
    renderAt(api, `/g/${view.project.id}/new`);
    fireEvent.change(await screen.findByLabelText("What was it?", { selector: "input" }), { target: { value: "Taxi" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), { target: { value: "15" } });
    pick("taxi.jpg");
    fireEvent.click(await screen.findByRole("button", { name: "Retry photo 1" }));
    await uploadsSettled();
    fireEvent.submit(document.getElementById("entry-form")!);
    await waitFor(async () => {
      expect((await api.getProject(view.project.id)).current.entries.find((e) => e.description === "Taxi")?.attachments).toHaveLength(1);
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps uploaded photo ids in the unsent draft", async () => {
    const view = await newSingleCurrencyGroup(api);
    renderAt(api, `/g/${view.project.id}/new`);
    fireEvent.change(await screen.findByLabelText("What was it?", { selector: "input" }), { target: { value: "Hotel" } });
    pick("hotel.jpg");
    await screen.findByRole("button", { name: "Remove photo 1" });
    await waitFor(() => {
      const draft = JSON.parse(localStorage.getItem(`splitdummy-draft:${view.project.id}:new-EXPENSE`) ?? "{}");
      expect(draft.attachmentIds).toHaveLength(1);
    });
  });

  it("marks the photo the server rejected", async () => {
    const view = await newSingleCurrencyGroup(api);
    vi.spyOn(api, "createEntry").mockRejectedValueOnce(
      new (await import("../../api/errors")).ApiError(422, "VALIDATION", "This photo isn't available. Remove it and add it again.", "attachmentIds.0"),
    );
    renderAt(api, `/g/${view.project.id}/new`);
    fireEvent.change(await screen.findByLabelText("What was it?", { selector: "input" }), { target: { value: "Fuel" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), { target: { value: "60" } });
    pick("fuel.jpg");
    await screen.findByRole("button", { name: "Remove photo 1" });
    await uploadsSettled();
    fireEvent.submit(document.getElementById("entry-form")!);
    expect(await screen.findAllByText("This photo isn't available. Remove it and add it again.")).not.toHaveLength(0);
  });
```

Check `src/web/api/errors.ts` for the real `ApiError` constructor signature and adapt the last test's construction. If `URL.createObjectURL` is missing in jsdom, stub it at the top of the test file: `URL.createObjectURL ??= () => "blob:test"; URL.revokeObjectURL ??= () => {};`.

- [ ] **Step 5: Run them to verify they fail**

Run: `npx vitest run --project web src/web/pages/group/EntryForm.test.tsx`
Expected: FAIL — no "Note" textbox.

- [ ] **Step 6: Implement the upload hook**

Create `src/web/lib/usePhotoUploads.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_ATTACHMENTS_PER_ENTRY } from "@shared/api";
import { useApi } from "../api/context";
import { errorMessage } from "../api/errors";
import { newKey } from "../api/idempotency";
import { compressReceipt } from "./receiptImage";

export type TileStatus = "compressing" | "uploading" | "done" | "failed";

export interface PhotoTile {
  key: string;
  /** Server id once uploaded (or for photos already on the entry). */
  id: string | null;
  src: string;
  status: TileStatus;
  error: string | null;
  /** Only tiles with a local file can be retried. */
  canRetry: boolean;
}

interface Local {
  file: Blob;
  compressed?: Blob;
  /** One per tile: a retry replays the same upload instead of creating another. */
  idempotencyKey: string;
  objectUrl?: string;
}

export interface PhotoUploads {
  tiles: PhotoTile[];
  add(files: File[]): void;
  remove(key: string): void;
  retry(key: string): void;
  /** The server image didn't load (e.g. an expired upload in an old draft). */
  markBroken(key: string): void;
  /** A save was rejected for the photo at this position of the saved id list. */
  markFailedAt(index: number, message: string): void;
  busy: boolean;
  failed: boolean;
  full: boolean;
}

export function usePhotoUploads({ projectId, initialIds, onIdsChange }: { projectId: string; initialIds: string[]; onIdsChange: (ids: string[]) => void }): PhotoUploads {
  const api = useApi();
  const local = useRef(new Map<string, Local>());
  const [tiles, setTiles] = useState<PhotoTile[]>(() =>
    initialIds.map((id) => ({ key: id, id, src: api.attachmentUrl(projectId, id), status: "done", error: null, canRetry: false })),
  );
  const patch = useCallback((key: string, p: Partial<PhotoTile>) => setTiles((ts) => ts.map((t) => (t.key === key ? { ...t, ...p } : t))), []);

  const process = useCallback(
    async (key: string) => {
      const item = local.current.get(key);
      if (!item) return;
      try {
        if (!item.compressed) {
          patch(key, { status: "compressing", error: null });
          item.compressed = (await compressReceipt(item.file)).blob;
          if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
          item.objectUrl = URL.createObjectURL(item.compressed);
          patch(key, { src: item.objectUrl });
        }
        patch(key, { status: "uploading", error: null });
        const dto = await api.uploadAttachment(projectId, item.compressed, { idempotencyKey: item.idempotencyKey });
        if (local.current.has(key)) patch(key, { status: "done", id: dto.id });
      } catch (err) {
        if (local.current.has(key)) patch(key, { status: "failed", error: errorMessage(err) });
      }
    },
    [api, projectId, patch],
  );

  const current = useRef(tiles);
  current.current = tiles;

  const add = useCallback(
    (files: File[]) => {
      const room = MAX_ATTACHMENTS_PER_ENTRY - current.current.length;
      const added: PhotoTile[] = files.slice(0, Math.max(0, room)).map((file) => {
        const key = newKey();
        const objectUrl = URL.createObjectURL(file);
        local.current.set(key, { file, idempotencyKey: newKey(), objectUrl });
        return { key, id: null, src: objectUrl, status: "compressing", error: null, canRetry: true };
      });
      setTiles((ts) => [...ts, ...added]);
      for (const t of added) void process(t.key);
    },
    [process],
  );

  const remove = useCallback((key: string) => {
    const item = local.current.get(key);
    if (item?.objectUrl) URL.revokeObjectURL(item.objectUrl);
    local.current.delete(key);
    setTiles((ts) => ts.filter((t) => t.key !== key));
  }, []);

  const retry = useCallback((key: string) => void process(key), [process]);
  const markBroken = useCallback((key: string) => patch(key, { status: "failed", error: "This photo is no longer available.", canRetry: false }), [patch]);
  const markFailedAt = useCallback(
    (index: number, message: string) => setTiles((ts) => {
      const target = ts.filter((t) => t.status === "done")[index];
      return target ? ts.map((t) => (t.key === target.key ? { ...t, status: "failed", error: message, canRetry: false } : t)) : ts;
    }),
    [],
  );

  // Report the saved ids (in tile order) whenever they change; skip the initial set.
  const ids = tiles.filter((t) => t.status === "done" && t.id).map((t) => t.id!);
  const last = useRef(initialIds.join(","));
  useEffect(() => {
    const joined = ids.join(",");
    if (joined === last.current) return;
    last.current = joined;
    onIdsChange(ids);
  });

  useEffect(() => () => {
    for (const item of local.current.values()) if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
  }, []);

  return {
    tiles,
    add,
    remove,
    retry,
    markBroken,
    markFailedAt,
    busy: tiles.some((t) => t.status === "compressing" || t.status === "uploading"),
    failed: tiles.some((t) => t.status === "failed"),
    full: tiles.length >= MAX_ATTACHMENTS_PER_ENTRY,
  };
}
```

Note: a failed tile is never in `ids`, so a saved body never references it; Save is blocked while any tile failed (Step 8).

- [ ] **Step 7: Implement the form section**

Create `src/web/pages/group/NoteAndPhotos.tsx`:

```tsx
import { useRef } from "react";
import { NOTE_MAX } from "@shared/api";
import { Field } from "../../components/Field";
import { Icon } from "../../components/ui";
import type { PhotoUploads } from "../../lib/usePhotoUploads";

const STATUS_TEXT = { compressing: "Preparing…", uploading: "Uploading…", done: "", failed: "" } as const;

export function NoteAndPhotos({ note, onNote, noteError, photos, photosError }: {
  note: string;
  onNote: (note: string) => void;
  noteError?: string;
  photos: PhotoUploads;
  photosError?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="ef-extras" aria-label="Note and photos">
      <Field label="Note" error={noteError} hint={note.length > NOTE_MAX - 100 ? `${note.length}/${NOTE_MAX}` : undefined}>
        {(p) => <textarea {...p} className="input ef-note" rows={2} value={note} placeholder="Anything worth remembering" onChange={(e) => onNote(e.target.value)} />}
      </Field>
      <div className="ef-photos">
        {photos.tiles.length > 0 && (
          <ul className="photo-tiles">
            {photos.tiles.map((t, i) => (
              <li key={t.key} className={`photo-tile is-${t.status}`}>
                <img src={t.src} alt={`Photo ${i + 1}`} onError={() => t.id && t.status === "done" && photos.markBroken(t.key)} />
                {STATUS_TEXT[t.status] && (
                  <span className="photo-tile-status tiny" role="status">
                    {STATUS_TEXT[t.status]}
                  </span>
                )}
                {t.status === "failed" && (
                  <span className="photo-tile-error tiny" role="alert">
                    {t.error}
                    {t.canRetry && (
                      <button type="button" className="link-btn" onClick={() => photos.retry(t.key)} aria-label={`Retry photo ${i + 1}`}>
                        Retry
                      </button>
                    )}
                  </span>
                )}
                <button type="button" className="icon-btn photo-tile-remove" onClick={() => photos.remove(t.key)} aria-label={`Remove photo ${i + 1}`}>
                  <Icon name="close" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {!photos.full && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => input.current?.click()}>
            <Icon name="add_a_photo" size={18} />
            Add photo
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Add photos"
          onChange={(e) => {
            if (e.target.files) photos.add([...e.target.files]);
            e.target.value = "";
          }}
        />
        {photosError && (
          <span className="field-error" role="alert">
            <Icon name="error" size={16} />
            {photosError}
          </span>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 8: Wire it into the form**

In `src/web/pages/group/EntryForm.tsx`:
- imports: `usePhotoUploads` from `../../lib/usePhotoUploads`, `NoteAndPhotos` from `./NoteAndPhotos`;
- after `const [d, setD] = useState<EntryDraft>(…)`:

```tsx
  const photos = usePhotoUploads({ projectId: view.project.id, initialIds: d.attachmentIds, onIdsChange: (attachmentIds) => update({ attachmentIds }) });
```

  (it must stay above the early `if (!collecting && !d.rejected) return …`, since it is a hook; the arrow only calls `update` later, so `update` may be declared further down);
- in `submit`, after the `if (!ev.body) { … }` block:

```tsx
    if (photos.busy) return;
    if (photos.failed) {
      setServerErrors({ photos: "Retry or remove the photo that didn't upload." });
      return;
    }
```

- in the `catch`, before `if (err.field) …`:

```tsx
      if (err.field?.startsWith("attachmentIds.")) photos.markFailedAt(Number(err.field.split(".")[1]), err.message);
```

- render `<NoteAndPhotos note={d.note} onNote={(note) => update({ note })} noteError={errors.note} photos={photos} photosError={errors.photos} />` between `<SplitEditor … />` and `<details className="ef-advanced" …>`;
- both submit buttons: `disabled={pending || photos.busy || (!collecting && d.rejected)}`; the footer button label becomes `{photos.busy ? "Uploading photos…" : <existing label>}` (keep the existing label expression).

- [ ] **Step 9: Style it**

Append to `src/web/styles/pages.css` near the `.ef-advanced` rules:

```css
.ef-extras {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ef-note {
  field-sizing: content;
  min-height: calc(2lh + 20px);
  max-height: calc(10lh + 20px);
  resize: vertical;
}
.ef-photos {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.photo-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}
.photo-tile {
  position: relative;
  aspect-ratio: 1;
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--line);
}
.photo-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.photo-tile.is-compressing img,
.photo-tile.is-uploading img,
.photo-tile.is-failed img {
  opacity: 0.45;
}
.photo-tile-status,
.photo-tile-error {
  position: absolute;
  inset: auto 4px 4px 4px;
  padding: 2px 4px;
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink);
}
.photo-tile-error {
  color: var(--danger);
  display: flex;
  flex-direction: column;
}
.photo-tile-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  background: var(--surface);
  border-radius: 999px;
}
```

Use the CSS variables that `pages.css` actually defines (check `--r-md`, `--r-sm`, `--surface`, `--danger`, `--ink`; substitute the file's equivalents if a name differs).

- [ ] **Step 10: Run the tests**

Run: `npx vitest run --project web && npm run typecheck`
Expected: PASS (all existing EntryForm tests too).

- [ ] **Step 11: Commit**

```bash
git add src/web
git commit -m "feat(web): note and receipt photos in the expense form"
```

---

### Task 10: Expense detail and list indicator

**Files:**
- Create: `src/web/pages/group/EntryAttachments.tsx`
- Modify: `src/web/pages/group/EntryDetail.tsx` (after the conversion section, ~line 192)
- Modify: `src/web/pages/group/parts.tsx` (`EntryRow` at 204)
- Modify: `src/web/styles/pages.css`
- Test: `src/web/pages/group/EntryDetail.test.tsx` (create)

**Interfaces:**
- Consumes: `EntryDTO.note/attachments` (Task 1); `Api.attachmentUrl` (Task 7).
- Produces: `EntryNote({ note }: { note: string })`, `EntryPhotos({ projectId, attachments }: { projectId: string; attachments: AttachmentDTO[] })`, `PhotoViewer({ urls, index, onIndex, onClose })`.

- [ ] **Step 1: Write the failing test**

Create `src/web/pages/group/EntryDetail.test.tsx`, reusing the render helper pattern from `EntryForm.test.tsx`:

```tsx
import "../../test/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApiProvider } from "../../api/context";
import { createMockApi, type MockApi } from "../../api/mock";
import { ToastProvider } from "../../components/Toast";
import { AppRoutes } from "../../App";

function renderAt(api: MockApi, path: string) {
  return render(
    <ApiProvider api={api}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ToastProvider>
    </ApiProvider>,
  );
}

describe("expense detail note and photos", () => {
  let api: MockApi;
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
    api = createMockApi();
  });
  afterEach(() => cleanup());

  it("shows the note as plain text and opens photos in a viewer", async () => {
    const view = await api.createProject({ name: "Ski", baseCurrency: "EUR", multiCurrencyEnabled: false, ownerDisplayName: "Maya" }, { idempotencyKey: crypto.randomUUID() });
    const pid = view.project.id;
    const photos = [
      await api.uploadAttachment(pid, new Blob(["a"], { type: "image/webp" }), { idempotencyKey: crypto.randomUUID() }),
      await api.uploadAttachment(pid, new Blob(["b"], { type: "image/webp" }), { idempotencyKey: crypto.randomUUID() }),
    ];
    await api.createEntry(pid, view.current.round.id, {
      type: "EXPENSE", description: "Lift passes", occurredAt: "2026-10-01", originalAmount: "9000", originalCurrency: "EUR",
      conversion: { method: "IDENTITY" }, payerMemberId: view.me.memberId, splitMode: "EQUAL", participants: [{ memberId: view.me.memberId }],
      note: "Line one\n<b>not bold</b>", attachmentIds: photos.map((p) => p.id),
    }, { idempotencyKey: crypto.randomUUID() });
    const entry = (await api.getProject(pid)).current.entries[0]!;

    renderAt(api, `/g/${pid}/e/${entry.id}`);
    const note = await screen.findByText(/Line one/);
    expect(note.textContent).toBe("Line one\n<b>not bold</b>");
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
    expect(screen.getByRole("dialog", { name: "Photo 1 of 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    expect(screen.getByRole("dialog", { name: "Photo 2 of 2" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full size" }).getAttribute("href")).toBe(api.attachmentUrl(pid, photos[1]!.id));
    fireEvent.click(screen.getByRole("button", { name: "Close photo" }));
    expect(screen.queryByRole("dialog", { name: /Photo \d of 2/ })).toBeNull();
  });
});
```

Confirm the detail route path (`/g/:id/e/:entryId`) in `src/web/App.tsx` and adjust.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project web src/web/pages/group/EntryDetail.test.tsx`
Expected: FAIL — note text not found.

- [ ] **Step 3: Implement the components**

Create `src/web/pages/group/EntryAttachments.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { AttachmentDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { Icon } from "../../components/ui";

export function EntryNote({ note }: { note: string }) {
  return (
    <section className="stack-8" aria-labelledby="note-h">
      <h3 id="note-h" className="section-title">
        Note
      </h3>
      <p className="detail-note">{note}</p>
    </section>
  );
}

export function EntryPhotos({ projectId, attachments }: { projectId: string; attachments: AttachmentDTO[] }) {
  const api = useApi();
  const [open, setOpen] = useState<number | null>(null);
  const urls = attachments.map((a) => api.attachmentUrl(projectId, a.id));
  return (
    <section className="stack-8" aria-labelledby="photos-h">
      <h3 id="photos-h" className="section-title">
        Photos
      </h3>
      <ul className="photo-tiles">
        {urls.map((url, i) => (
          <li key={attachments[i]!.id} className="photo-tile">
            <button type="button" className="photo-thumb" onClick={() => setOpen(i)} aria-label={`Open photo ${i + 1} of ${urls.length}`}>
              <img src={url} alt="" loading="lazy" />
            </button>
          </li>
        ))}
      </ul>
      {open !== null && <PhotoViewer urls={urls} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Full-screen viewer on its own <dialog>.showModal(): stacks above the detail Sheet; Escape closes only this. */
export function PhotoViewer({ urls, index, onIndex, onClose }: { urls: string[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const touchX = useRef<number | null>(null);
  const many = urls.length > 1;
  const go = (delta: number) => onIndex((index + delta + urls.length) % urls.length);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    try {
      d.showModal();
    } catch {
      d.setAttribute("open", "");
    }
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    d.addEventListener("cancel", onCancel);
    return () => {
      d.removeEventListener("cancel", onCancel);
      if (d.open && typeof d.close === "function") d.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="photo-viewer"
      aria-label={`Photo ${index + 1} of ${urls.length}`}
      onKeyDown={(e) => {
        if (!many) return;
        if (e.key === "ArrowRight") go(1);
        if (e.key === "ArrowLeft") go(-1);
      }}
      onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const start = touchX.current;
        const end = e.changedTouches[0]?.clientX;
        touchX.current = null;
        if (!many || start === null || end === undefined || Math.abs(end - start) < 50) return;
        go(end < start ? 1 : -1);
      }}
    >
      <img src={urls[index]} alt={`Photo ${index + 1} of ${urls.length}`} className="photo-viewer-img" />
      <div className="photo-viewer-bar">
        {many && (
          <button type="button" className="icon-btn" onClick={() => go(-1)} aria-label="Previous photo">
            <Icon name="chevron_left" size={24} />
          </button>
        )}
        <a href={urls[index]} target="_blank" rel="noopener" className="link-btn">
          Open full size
        </a>
        {many && (
          <button type="button" className="icon-btn" onClick={() => go(1)} aria-label="Next photo">
            <Icon name="chevron_right" size={24} />
          </button>
        )}
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close photo" autoFocus>
          <Icon name="close" size={24} />
        </button>
      </div>
    </dialog>
  );
}
```

- [ ] **Step 4: Wire into the detail and the list row**

`EntryDetail.tsx`: import `{ EntryNote, EntryPhotos }`; directly after the conversion `<section className="fx fx-static" …>` block (before the ADJUSTMENT/shares ternary) add:

```tsx
      {e.note && <EntryNote note={e.note} />}
      {e.attachments.length > 0 && <EntryPhotos projectId={view.project.id} attachments={e.attachments} />}
```

`parts.tsx` `EntryRow`: inside `entry-meta`, after the `group` meta item:

```tsx
          {e.attachments.length > 0 && (
            <span className="meta-item">
              <Icon name="attach_file" size={14} />
              <span className="sr-only">Photos </span>
              {e.attachments.length}
            </span>
          )}
          {e.note && (
            <span className="meta-item" title="Has a note">
              <Icon name="sticky_note_2" size={14} />
              <span className="sr-only">Has a note</span>
            </span>
          )}
```

Check that the icon font in `index.html` includes `attach_file`, `sticky_note_2`, `add_a_photo`, `chevron_left` and `chevron_right`; if the font is subset with an `icon_names=` list, add them to it.

- [ ] **Step 5: Style it**

Append to `src/web/styles/pages.css`:

```css
.detail-note {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
}
.photo-thumb {
  all: unset;
  display: block;
  width: 100%;
  height: 100%;
  cursor: zoom-in;
}
.photo-thumb:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}
.photo-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.photo-viewer {
  width: 100vw;
  height: 100dvh;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: #000;
  display: flex;
  flex-direction: column;
}
.photo-viewer::backdrop {
  background: rgb(0 0 0 / 0.9);
}
.photo-viewer-img {
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: contain;
}
.photo-viewer-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
  color: #fff;
}
.photo-viewer-bar .icon-btn,
.photo-viewer-bar .link-btn {
  color: #fff;
}
```

(The `.photo-viewer` rules must not apply when the dialog is closed; `display: flex` only matters while open because a closed `<dialog>` is `display: none` via the UA stylesheet — if a later rule overrides that, scope with `.photo-viewer[open]`.)

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project web && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web
git commit -m "feat(web): show notes and receipt photos on expenses, with a photo viewer"
```

---

### Task 11: Docs and privacy policy

**Files:**
- Modify: `src/shared/api-guide.ts` (guide sections)
- Modify: `src/web/pages/ApiDocs.tsx`
- Modify: `src/web/pages/Privacy.tsx` (lines 19-52)
- Modify: `docs/ARCHITECTURE.md` (runtime list at ~line 17)
- Modify: `docs/splitdummy-development-handoff.md` (lines 58 and 228)
- Modify: `README.md` if it lists features

- [ ] **Step 1: API guide**

In `apiGuide()` add a section after "Add an expense with Python":

```md
## Notes and receipt photos
Expenses and refunds accept an optional note (up to 1000 characters) and up to 5 photos.
1. Upload each photo: POST /api/projects/{projectId}/attachments with the image bytes as the body, Content-Type image/jpeg or image/webp, and an Idempotency-Key. At most 1.5 MB and 4096 px per side. The response contains the photo id.
2. Save the expense with "attachmentIds": ["att_…"] in display order.
Photo metadata, including EXIF orientation, is removed, so upload upright images. An uploaded photo is visible only to you until it is attached; unattached uploads are deleted after 24 hours.
On updates, omitting note or attachmentIds keeps them; null or [] clears them. Download a photo with GET /api/projects/{projectId}/attachments/{attachmentId}.
```

and add the two endpoints to "Common endpoints".

- [ ] **Step 2: Human API docs page**

In `src/web/pages/ApiDocs.tsx`, add the same two-step explanation as a short section in the page's existing style (mirror how it renders the other guide sections; if it renders `apiGuide` content, nothing else is needed — check first).

- [ ] **Step 3: Privacy policy**

In `src/web/pages/Privacy.tsx`:
- "What we keep" → replace the second bullet with: `What you add to groups: names, members, expenses, notes, receipt photos and payments. Members of a group can see it.` and add a bullet: `Photos are shrunk in your browser and their location and camera details are removed before they're stored. A photo is deleted when it's removed from its expense, when the expense or group is deleted, or after 24 hours if it was never saved with an expense.`
- "How long, and your rights": after "deletes the groups you own with their backups" insert "and photos".

- [ ] **Step 4: Architecture and handoff docs**

`docs/ARCHITECTURE.md`: next to `R2 BACKUPS — versioned JSON exports for recovery` add `R2 ATTACHMENTS — receipt photos (projects/<id>/attachments/<attachmentId>), metadata stripped at upload; the DO owns visibility and the purge queue (attachment_trash), the daily cron deletes from R2`.
`docs/splitdummy-development-handoff.md` line 58: change "Receipt attachments/OCR … deferred" to say receipt photos shipped and OCR is still deferred; line 228: "File storage | Private R2 for backup/export artifacts and receipt photos".

- [ ] **Step 5: Verify**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (the OpenAPI/docs tests still pass).

- [ ] **Step 6: Commit**

```bash
git add src/shared/api-guide.ts src/web/pages docs README.md
git commit -m "docs: notes and receipt photos in the API guide, privacy policy and architecture"
```

---

### Task 12: Full verification, infrastructure and manual check

- [ ] **Step 1: Full test suite and build**

Run: `npm test && npm run build`
Expected: all three vitest projects pass; build succeeds.

- [ ] **Step 2: Run the app with the mock and try the flow**

Use the `run` skill (or `VITE_MOCK=1 npm run dev`): add an expense with a note and two photos, reload mid-draft, edit to remove one photo, open the viewer (arrows, Escape), check the list row indicator and the entry's Changes list ("· added 2 photos").

- [ ] **Step 3: Create the R2 buckets — only after explicit user confirmation**

Ask the user first. Then:

```bash
npx wrangler r2 bucket create splitdummy-attachments
npx wrangler r2 bucket create splitdummy-staging-attachments
```

- [ ] **Step 4: Staging check on real phones (user-assisted)**

After `npm run deploy:staging` (user's call), photograph a long supermarket receipt on iOS Safari and Android Chrome: small print must stay legible in "Open full size", and the uploaded size should be ~150–400 KB (check the `bytes` in the entry's attachment or the R2 object size).

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch.
