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
