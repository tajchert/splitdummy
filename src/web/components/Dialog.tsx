import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./ui";

/**
 * Modal built on <dialog>.showModal(): the browser traps focus, makes the page inert,
 * closes on Escape and returns focus to the opener. Full-screen sheet on phones,
 * centred dialog on desktop.
 */
export function Sheet({ title, onClose, headerAction, footer, children, size = "md", labelledBy }: {
  title: ReactNode;
  onClose: () => void;
  /** Phone header right slot (e.g. Save). Hidden on desktop, where `footer` carries actions. */
  headerAction?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  size?: "md" | "lg";
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", "");
      }
    }
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    d.addEventListener("cancel", onCancel);
    return () => {
      d.removeEventListener("cancel", onCancel);
      if (d.open) d.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`sheet sheet-${size}`}
      aria-labelledby={labelledBy ?? id}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself) closes on desktop.
        if (e.target === ref.current && window.matchMedia("(min-width: 860px)").matches) onClose();
      }}
    >
      <div className="sheet-panel">
        <header className="sheet-head">
          <button type="button" className="icon-btn sheet-close-m" onClick={onClose} aria-label="Close">
            <Icon name="close" size={22} />
          </button>
          <h2 id={id} className="sheet-title">
            {title}
          </h2>
          <div className="sheet-head-action">{headerAction}</div>
          <button type="button" className="icon-btn sheet-close-d" onClick={onClose} aria-label="Close">
            <Icon name="close" size={22} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

/** Small confirmation for destructive or irreversible actions. */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, danger, pending, confirmIcon }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  pending?: boolean;
  confirmIcon?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    try {
      d.showModal();
    } catch {
      d.setAttribute("open", "");
    }
    const onC = (e: Event) => {
      e.preventDefault();
      cancelRef.current();
    };
    d.addEventListener("cancel", onC);
    return () => {
      d.removeEventListener("cancel", onC);
      if (d.open) d.close();
    };
  }, []);

  return (
    <dialog ref={ref} className="confirm" role="alertdialog" aria-labelledby={id} aria-describedby={`${id}-d`}>
      <h2 id={id} className="confirm-title">
        {title}
      </h2>
      <div id={`${id}-d`} className="confirm-body">
        {children}
      </div>
      <div className="confirm-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={pending}>
          {confirmIcon && <Icon name={confirmIcon} size={18} />}
          {pending ? "Working…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
