/** Entry notes and receipt photos: linking, visibility, cleanup. */
import { z } from "zod";
import { ATTACHMENT_TYPES, IdSchema, MAX_ATTACHMENT_BYTES, MAX_IMAGE_EDGE, type EntryDTO } from "@shared/api";
import { forbidden, invalid, limitExceeded, notCollecting, notFound, parseBody } from "../errors";
import { ATTACHMENT_TRASH_BATCH, LIMITS, PENDING_ATTACHMENT_TTL_MS } from "../limits";
import type { MemberRow } from "../store";
import { newId, type Tx } from "../tx";
import type { DoRequest, DoResponse } from "../types";
import { attachmentDto } from "../views";
import { ok, type OpResult } from "./project";

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
    throw limitExceeded(`You have ${LIMITS.pendingAttachmentsPerMember} unsaved photos. Save the expense, or wait — unsaved photos are cleared within a day.`);
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
  const cutoff = new Date(Date.parse(tx.now) - PENDING_ATTACHMENT_TTL_MS).toISOString();
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
