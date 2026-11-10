import { withDraftDefaults, type EntryDraft } from "./entryForm";

/** Local, unsent entry drafts. Never shown as saved; the UI labels them "Not saved". */
const PREFIX = "splitdummy-draft:";
const key = (projectId: string, slot: string) => `${PREFIX}${projectId}:${slot}`;

export function loadDraft(projectId: string, slot: string): EntryDraft | null {
  try {
    const raw = localStorage.getItem(key(projectId, slot));
    return raw ? withDraftDefaults(JSON.parse(raw)) : null;
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

/** Everything unsent on this device, for sign-out and account deletion (shared devices). */
export function clearAllDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
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
      try {
        const d = JSON.parse(localStorage.getItem(k) ?? "null") as EntryDraft | null;
        if (d?.rejected) return { slot: k.slice(prefix.length), draft: withDraftDefaults(d) };
      } catch {
        /* one corrupt value must not hide the others */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
