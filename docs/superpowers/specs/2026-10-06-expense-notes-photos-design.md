# Expense notes and receipt photos

Date: 2026-10-06 · Status: approved design, pending implementation plan

## Goal

Let people attach context to an expense:

1. A free-text **note** on every expense/refund.
2. Up to **5 photos** per expense, mostly photos of bills/receipts, optimized for size while keeping printed text
   legible.

This un-defers "receipt attachments" from `docs/splitdummy-development-handoff.md` (§ deferred features and the
File storage row). OCR stays deferred.

## Decisions

| Topic | Decision |
|---|---|
| Permissions | Notes and photos follow the existing entry edit rules: the entry's creator or the group owner, only while the round is collecting. A frozen round is fully frozen. Any member can **view**. |
| Upload flow | **Upload, then attach.** Photos upload on pick to a project-level endpoint and become *pending*; `createEntry`/`updateEntry` reference them by id and link them in the same DO transaction. Abandoned uploads are purged after 24 h. |
| Compression | In the browser: long edge ≤ 2000 px, WebP q0.8 (JPEG q0.82 where WebP encoding is unsupported), stepped down to fit ≤ 900 KB. Typical bill photo ≈ 150–400 KB. |
| Storage | New private R2 bucket `ATTACHMENTS`, separate from `BACKUPS`. Served only through an authenticated Worker route. |
| Metadata | Stripped twice: by browser re-encoding, and by a server-side EXIF/XMP strip at upload (covers API clients). |
| Thumbnails | None. The compressed image is small enough; the UI scales it with CSS. |
| Out of scope | OCR / amount extraction, PDFs, viewing photos from past revisions in History, offline upload queue. |

## Data model

### ProjectDO (migration #4, append-only in `worker/do/schema.ts` `MIGRATIONS`)

```sql
ALTER TABLE entries ADD COLUMN note TEXT;                 -- NULL when no note

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,                                    -- 'att_' prefix ('a_' is taken by audit events)
  entry_id TEXT REFERENCES entries(id),                   -- NULL while pending
  uploader_member_id TEXT NOT NULL REFERENCES members(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/webp','image/jpeg')),
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,                    -- order within the entry
  created_at TEXT NOT NULL,
  attached_at TEXT
);
CREATE INDEX attachments_entry ON attachments(entry_id);

CREATE TABLE attachment_trash (                           -- R2 objects awaiting deletion
  attachment_id TEXT PRIMARY KEY,
  trashed_at TEXT NOT NULL
);
```

An attachment row is deleted from `attachments` when it moves to `attachment_trash`; trash rows are removed only
after the R2 delete is acknowledged (see Lifecycle).

### R2

- Binding `ATTACHMENTS`: bucket `splitdummy-attachments`; staging `splitdummy-staging-attachments` (declared both
  top-level and under `env.staging` in `wrangler.jsonc`).
- Object key: `projects/<projectId>/attachments/<attachmentId>`. Objects are immutable.
- `httpMetadata.contentType` set to the validated type.

### Limits (`worker/do/limits.ts`)

| Limit | Value |
|---|---|
| Photos per entry | 5 |
| Pending (unattached) uploads per member | 20 |
| Live photos per project (pending + attached) | 1000 |
| Upload body | ≤ 1.5 MB (`MAX_ATTACHMENT_BYTES`) |
| Image dimensions | each side 1–4096 px |
| Note | ≤ 1000 characters after trim |
| Pending TTL | 24 h |

Exceeding a count limit → `LIMIT_EXCEEDED` via the DO's `limitExceeded()` (429, existing DO convention).

## Contracts (`src/shared/api.ts`, additive only)

```ts
export const NoteSchema = z.string().trim().max(1000); // "" → null is normalized in the DO (no zod transform, so OpenAPI input schemas stay representable)
// EntryInputSchema gains:
note: NoteSchema.nullable().optional(),
attachmentIds: z.array(IdSchema).max(5).refine(unique).optional(),

// EntryDTO gains:
note: string | null;
attachments: AttachmentDTO[];   // ordered by position

export interface AttachmentDTO {
  id: string;
  contentType: "image/webp" | "image/jpeg";
  bytes: number;
  width: number;
  height: number;
}
```

Semantics:

- **Create:** omitted `note` → `null`; omitted `attachmentIds` → none.
- **Update (PATCH):** omitted field → **unchanged**; `note: null` or `""` clears; `attachmentIds: []` removes all.
  The array, when present, is the complete ordered list (order = `position`).
- `ADJUSTMENT` entries accept neither field (they can't be edited; created via the correction flow without them).

## Endpoints

### `POST /api/projects/:projectId/attachments`

Raw image body (not JSON). Edge pipeline:

1. `requireSession`, `originGuard` (mutating), `validateParams`, `requireIdempotencyKey`, `enforceLimit(RL_UPLOAD)`
   (new limiter, 30/min per principal; prod + staging namespaces).
2. `Content-Type` must be `image/webp` or `image/jpeg`; a declared `Content-Length` over `MAX_ATTACHMENT_BYTES` is
   rejected up front, and the streaming read enforces the same cap (413 if it overruns).
3. Magic bytes must match the declared type (`RIFF....WEBP` / `FF D8 FF`). Width/height parsed from the header
   (JPEG SOFn; WebP VP8/VP8L/VP8X); must be within limits.
4. Strip metadata: JPEG drops APP1 (EXIF/XMP) and APP13 segments; WebP drops `EXIF`/`XMP ` chunks and clears the
   matching VP8X flags. Pure functions in `worker/lib/image.ts`.
5. DO op `registerAttachment` (mutation, idempotent like every group mutation): member check, collecting round,
   pending and project quotas, inserts the pending row (metadata + SHA-256 of the stripped bytes in the request).
   No audit, no version bump, no broadcast (a pending upload is private to its uploader). Returns `AttachmentDTO`.
6. `ATTACHMENTS.put(key, strippedBytes)`. If the put fails, return 500. A retry with the same `Idempotency-Key`
   replays the same id and puts the bytes again, which repairs it; an abandoned row is purged by the TTL.
7. `201` with `AttachmentDTO`.

The server-side strip also drops EXIF orientation; the browser path is already upright, and the API docs tell API
clients to upload upright images.

### `GET /api/projects/:projectId/attachments/:attachmentId`

1. `requireSession` (cookie works for `<img src>`; API keys work via `Authorization`).
2. DO read op `readAttachment`: caller is an active member **and** the attachment is either linked to a
   non-deleted entry, or pending and uploaded by the caller. Otherwise 404.
3. Stream from R2 with:
   - `Content-Type` from the row
   - `Cache-Control: private, max-age=31536000, immutable`
   - `X-Content-Type-Options: nosniff`
   - `Content-Security-Policy: sandbox`
   - `Content-Disposition: inline`

Both endpoints are under `/api/projects/*`, so they join the public API allowlist automatically.

### Linking in `createEntry` / `updateEntry` (`worker/do/ops/ledger.ts`)

After the existing checks (member, collecting round, `editableEntry`, revision):

- Each id in `attachmentIds` must exist in this project and be either pending with
  `uploader_member_id = me.id`, or already linked to this entry. Otherwise `VALIDATION` (422) with field
  `attachmentIds.<index>` ("This photo isn't available. Remove it and add it again.").
- Linked ids not in the new list → moved to `attachment_trash`.
- New ids → `entry_id`, `attached_at`, `position` set.
- `note` written to `entries.note`.
- A note-only or photo-only change is a normal edit: bumps `revision`, writes `ENTRY_UPDATED` audit with
  before/after `entryDto` (which now includes `note` and `attachments`). The audit summary gains fragments such as
  "· changed the note · added 2 photos", which is what the entry's Changes list and History show.
- Frozen rounds read entries from their settlement snapshot; snapshots written before this feature lack the new
  fields, so the read path fills `note: null, attachments: []`.

### `deleteEntry`

Soft-deletes as today, and moves all of the entry's attachments to `attachment_trash` in the same transaction.

## Lifecycle and cleanup

- **Daily cron** (`worker/queue/scheduled.ts`), per project, after the backup step:
  1. DO op `takeAttachmentTrash`: first moves pending attachments older than 24 h to trash, then returns up to
     N trash ids.
  2. Edge deletes `projects/<projectId>/attachments/<id>` for those ids from R2 (batched).
  3. DO op `ackAttachmentTrash { ids }` removes the trash rows.
  A failed R2 delete leaves the trash rows; the next night retries.
- **Group deletion** (`forgetProject` in `worker/routes/account.ts`): delete the `projects/<projectId>/attachments/`
  prefix in `ATTACHMENTS` on the same owner-deletion path that deletes the group's backups.
- **Account deletion:** photos stay with the group, like the person's entries; uploader is anonymized by the
  existing member anonymization.
- **Backups:** `backupSnapshot` includes the `attachments` and `attachment_trash` metadata rows; image bytes are
  not backed up.
- **CSV export:** appends `note` and `photo_count` columns (snake_case like the existing header).

## Web

### `src/web/lib/receiptImage.ts` (new)

`compressReceipt(file, deps?) → Promise<{ blob, width, height }>`

1. Decode with orientation applied (`createImageBitmap(file, { imageOrientation: "from-image" })`, falling back
   to an `<img>` decode).
2. Scale so the long edge ≤ 2000 px (never upscale).
3. Encode WebP q0.8 on a white background (so transparent PNG screenshots don't turn black in JPEG). If the
   produced `blob.type` isn't `image/webp`, encode JPEG q0.82 and stay on JPEG for later steps.
4. If > 900 KB: retry at q0.7, then q0.6, then long edge 1600 px at q0.7. Return the first that fits; if none
   fits, return the smallest (server cap is 1.5 MB).
5. Undecodable input → typed error the UI maps to "Couldn't read this image — try a JPEG or PNG."

Encoder/decoder are injectable for tests (jsdom has no canvas).

### Expense form (`src/web/pages/group/EntryForm.tsx`, `src/web/lib/entryForm.ts`)

- New **"Note & photos"** section below the split (not inside Advanced):
  - Auto-growing `<textarea>` labelled "Note"; character counter appears near the limit.
  - "Add photo" button → `<input type="file" accept="image/*" multiple>`; hidden at 5 photos.
  - Tiles: local preview immediately; states *compressing → uploading → done* / *failed (Retry)*; remove (×).
- Save waits for in-flight uploads ("Uploading photos…"); a failed tile blocks save until retried or removed.
  Payload includes `note` and `attachmentIds` (tile order).
- Drafts (`src/web/lib/drafts.ts`) persist `note` and uploaded `attachmentIds` (ids only).
- When the round isn't collecting the form isn't shown at all (existing behaviour).
- A tile whose server image fails to load (e.g. a draft's pending upload expired) shows "This photo is no longer
  available" with Remove; a save error on `attachmentIds.<n>` marks that tile.

### Expense detail (`src/web/pages/group/EntryDetail.tsx`)

- Note as plain text, line breaks preserved (`white-space: pre-wrap`), no markdown/linkify.
- Photo row: square thumbnails (`object-fit: cover`), tap → full-screen viewer with prev/next (buttons, swipe,
  arrow keys), Esc/close, "Open full size" link. Built on a second `<dialog>.showModal()` stacked above the detail Sheet (the browser traps focus; Escape closes only the viewer).

### Elsewhere

- List row (`src/web/pages/group/parts.tsx` `EntryRow`): small paperclip / note indicator when present.
- History and the entry's Changes list show the audit summary fragments from the DO (see Linking).
- Mock API (`src/web/api/mock.ts`): fake uploads backed by object URLs.

## Privacy, logging, docs

- Never log note text or image bytes; logs carry ids, byte counts, status only.
- `src/web/pages/Privacy.tsx`: notes and receipt photos are kept and visible to group members; location and other
  photo metadata are stripped; photos are deleted when removed, when their expense or group is deleted, or after
  24 h if never attached.
- API docs: `worker/routes/openapi.ts`, `src/shared/api-guide.ts` (upload-then-attach flow, PATCH omit semantics),
  `src/web/pages/ApiDocs.tsx`.
- `docs/ARCHITECTURE.md`: `ATTACHMENTS` bucket and its role. Handoff doc: receipts no longer deferred (OCR still is).

## Infra

- `wrangler.jsonc`: `ATTACHMENTS` R2 binding and `RL_UPLOAD` rate limiter, top-level and `env.staging`.
- Buckets created with `wrangler r2 bucket create` (prod + staging) — run only after explicit confirmation.

## Testing

- **shared:** `NoteSchema` (trim, empty → null, 1000 cap), `attachmentIds` (max 5, unique), create vs
  PATCH omit semantics.
- **DO** (`test/do/`): link own pending; reject another member's pending, another project's id, an id linked to
  another entry; > 5; frozen round; non-creator non-owner; PATCH omitted keeps / `[]` clears / reorder;
  delete entry trashes photos; pending TTL → trash; take/ack cycle; quotas; audit details and summary;
  `readAttachment` visibility rules; old frozen snapshots read with defaults.
- **edge** (`test/edge/`, Miniflare R2): upload type/magic mismatch, oversize, bad dimensions, idempotent replay
  repairing a failed put,
  non-member, removed member, cross-origin; metadata strip on fixture JPEG/WebP; GET access matrix and response
  headers; group deletion clears the prefix; cron purge.
- **web:** `compressReceipt` with injected codec (fallback to JPEG, size-budget steps, no upscale, decode error);
  white background before draw; `EntryForm` (tile states, save waits, failed tile blocks, draft restores ids,
  server `attachmentIds.n` error marks the tile).
- **Manual:** real bill photos from iOS Safari and Android Chrome — legibility of small print and resulting size.
