import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_ATTACHMENTS_PER_ENTRY } from "@shared/api";
import { useApi } from "../api/context";
import { errorMessage } from "../api/errors";
import { newKey } from "../api/idempotency";
import { compressReceipt, ImageReadError } from "./receiptImage";

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
  /** Informational only (the preview didn't load); never blocks saving. */
  notice: string | null;
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
  /** Returns how many files were skipped for lack of room. */
  add(files: File[]): number;
  remove(key: string): void;
  retry(key: string): void;
  /** The preview didn't load: note it on the tile, but keep the photo and don't block saving. */
  markBroken(key: string): void;
  /** A save was rejected for the photo at this position of the saved id list. */
  markFailedAt(index: number, message: string): void;
  /** Start over from these saved ids (the form discarded its draft). */
  reset(ids: string[]): void;
  /** Uploaded ids in tile order; what a save should send. */
  ids: string[];
  busy: boolean;
  failed: boolean;
  full: boolean;
}

export function usePhotoUploads({ projectId, initialIds, onIdsChange }: { projectId: string; initialIds: string[]; onIdsChange: (ids: string[]) => void }): PhotoUploads {
  const api = useApi();
  const local = useRef(new Map<string, Local>());
  const savedTiles = useCallback(
    (ids: string[]): PhotoTile[] => ids.map((id) => ({ key: id, id, src: api.attachmentUrl(projectId, id), status: "done", error: null, canRetry: false, notice: null })),
    [api, projectId],
  );
  const [tiles, setTiles] = useState<PhotoTile[]>(() => savedTiles(initialIds));
  const patch = useCallback((key: string, p: Partial<PhotoTile>) => setTiles((ts) => ts.map((t) => (t.key === key ? { ...t, ...p } : t))), []);

  /** Compression runs one photo at a time (several full-resolution decodes at once can crash mobile Safari); uploads may overlap. */
  const compressing = useRef<Promise<unknown>>(Promise.resolve());
  const compressInTurn = useCallback((file: Blob) => {
    const turn = compressing.current.then(() => compressReceipt(file));
    compressing.current = turn.catch(() => {});
    return turn;
  }, []);

  const process = useCallback(
    async (key: string) => {
      const item = local.current.get(key);
      if (!item) return;
      try {
        if (!item.compressed) {
          patch(key, { status: "compressing", error: null });
          item.compressed = (await compressInTurn(item.file)).blob;
          if (!local.current.has(key)) return;
          if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
          item.objectUrl = URL.createObjectURL(item.compressed);
          patch(key, { src: item.objectUrl });
        }
        patch(key, { status: "uploading", error: null });
        const dto = await api.uploadAttachment(projectId, item.compressed, { idempotencyKey: item.idempotencyKey });
        if (local.current.has(key)) patch(key, { status: "done", id: dto.id });
      } catch (err) {
        if (!local.current.has(key)) return;
        // An unreadable file fails the same way every time, so it can only be removed.
        const unreadable = err instanceof ImageReadError;
        patch(key, { status: "failed", error: unreadable ? err.message : errorMessage(err), canRetry: !unreadable });
      }
    },
    [api, projectId, patch, compressInTurn],
  );

  /** The ids last reported (or given), so only real changes reach onIdsChange. */
  const last = useRef(initialIds.join(","));
  const current = useRef(tiles);
  current.current = tiles;

  const add = useCallback(
    (files: File[]) => {
      const room = Math.max(0, MAX_ATTACHMENTS_PER_ENTRY - current.current.length);
      const added: PhotoTile[] = files.slice(0, room).map((file) => {
        const key = newKey();
        const objectUrl = URL.createObjectURL(file);
        local.current.set(key, { file, idempotencyKey: newKey(), objectUrl });
        return { key, id: null, src: objectUrl, status: "compressing", error: null, canRetry: true, notice: null };
      });
      setTiles((ts) => [...ts, ...added]);
      for (const t of added) void process(t.key);
      return files.length - added.length;
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
  const markBroken = useCallback((key: string) => patch(key, { notice: "This photo is no longer available.", canRetry: false }), [patch]);
  const markFailedAt = useCallback(
    (index: number, message: string) => setTiles((ts) => {
      const target = ts.filter((t) => t.status === "done")[index];
      return target ? ts.map((t) => (t.key === target.key ? { ...t, status: "failed", error: message, canRetry: false } : t)) : ts;
    }),
    [],
  );

  const reset = useCallback(
    (ids: string[]) => {
      for (const item of local.current.values()) if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
      local.current.clear();
      last.current = ids.join(",");
      setTiles(savedTiles(ids));
    },
    [savedTiles],
  );

  // Report the saved ids (in tile order) whenever they change; skip the initial set.
  const ids = tiles.filter((t) => t.status === "done" && t.id).map((t) => t.id!);
  useEffect(() => {
    const joined = ids.join(",");
    if (joined === last.current) return;
    last.current = joined;
    onIdsChange(ids);
  });

  useEffect(() => () => {
    for (const item of local.current.values()) if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    // Late results from uploads still in flight are dropped (process checks membership).
    local.current.clear();
  }, []);

  return {
    tiles,
    add,
    remove,
    retry,
    markBroken,
    markFailedAt,
    reset,
    ids,
    busy: tiles.some((t) => t.status === "compressing" || t.status === "uploading"),
    failed: tiles.some((t) => t.status === "failed"),
    full: tiles.length >= MAX_ATTACHMENTS_PER_ENTRY,
  };
}
