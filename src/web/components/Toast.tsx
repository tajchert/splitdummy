import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./ui";

interface Toast {
  id: number;
  text: string;
  tone: "success" | "info" | "error";
}

const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: Toast["tone"] = "success") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDone={() => setToasts((all) => all.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3600);
    return () => clearTimeout(t);
  }, [onDone]);
  const icon = toast.tone === "success" ? "check_circle" : toast.tone === "error" ? "error" : "info";
  return (
    <div className={`toast toast-${toast.tone}`}>
      <Icon name={icon} size={18} />
      <span>{toast.text}</span>
    </div>
  );
}
