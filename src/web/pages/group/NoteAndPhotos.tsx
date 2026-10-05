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
