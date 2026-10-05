import { useEffect, useId, useRef, useState } from "react";
import type { AttachmentDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { Icon } from "../../components/ui";

export function EntryNote({ note }: { note: string }) {
  const headingId = useId();
  return (
    <section className="stack-8" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">
        Note
      </h3>
      <p className="detail-note">{note}</p>
    </section>
  );
}

export function EntryPhotos({ projectId, attachments }: { projectId: string; attachments: AttachmentDTO[] }) {
  const api = useApi();
  const headingId = useId();
  const [open, setOpen] = useState<number | null>(null);
  const urls = attachments.map((a) => api.attachmentUrl(projectId, a.id));
  // The list can shrink while the viewer is open: stay on the last photo, or close when none are left.
  const shown = open === null || urls.length === 0 ? null : Math.min(open, urls.length - 1);
  return (
    <section className="stack-8" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">
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
      {shown !== null && <PhotoViewer urls={urls} index={shown} onIndex={setOpen} onClose={() => setOpen(null)} />}
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
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      closeRef.current();
    };
    const onCancel = (e: Event) => {
      e.preventDefault();
      finish();
    };
    d.addEventListener("cancel", onCancel);
    // StrictMode's dev double-mount: the first cleanup's d.close() queues a `close` event that the
    // second mount's fresh listener would receive. A genuine close always leaves d.open false.
    const onDialogClose = () => {
      if (d.open) return;
      finish();
    };
    d.addEventListener("close", onDialogClose);
    return () => {
      closed = true;
      d.removeEventListener("cancel", onCancel);
      d.removeEventListener("close", onDialogClose);
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
