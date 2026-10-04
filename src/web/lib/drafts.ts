import type { EntryDraft } from "./entryForm";

/** Local, unsent entry drafts. Never shown as saved; the UI labels them "Not saved". */
const key = (projectId: string, slot: string) => `splitdummy-draft:${projectId}:${slot}`;

export function loadDraft(projectId: string, slot: string): EntryDraft | null {
  try {
    const raw = localStorage.getItem(key(projectId, slot));
    return raw ? (JSON.parse(raw) as EntryDraft) : null;
  } catch {
    return null;
  }
}

export function saveDraft(projectId: string, slot: string, d: EntryDraft): void {
  try {
    localStorage.setItem(key(projectId, slot), JSON.stringify({ ...d, savedAt: new Date().toISOString() }));
  } catch {
    /* storage unavailable: the draft lives only in memory */
  }
}

export function clearDraft(projectId: string, slot: string): void {
  try {
    localStorage.removeItem(key(projectId, slot));
  } catch {
    /* ignore */
  }
}

/** A draft rejected because its round froze: offered again for the next round. */
export function findRejectedDraft(projectId: string): { slot: string; draft: EntryDraft } | null {
  try {
    const prefix = key(projectId, "");
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(prefix)) continue;
      const d = JSON.parse(localStorage.getItem(k) ?? "null") as EntryDraft | null;
      if (d?.rejected) return { slot: k.slice(prefix.length), draft: d };
    }
  } catch {
    /* ignore */
  }
  return null;
}
