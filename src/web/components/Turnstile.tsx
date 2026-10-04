import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useSession } from "../api/context";

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loader: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loader ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    s.onerror = () => {
      loader = null;
      reject(new Error("turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return loader;
}

export interface TurnstileHandle {
  reset(): void;
}

/**
 * Renders the Cloudflare Turnstile widget when /api/config has a site key; otherwise
 * renders nothing and reports "not needed" via `onToken(undefined)` semantics:
 * forms should send the token only when one exists.
 */
export const Turnstile = forwardRef<TurnstileHandle, { onToken: (token: string | null) => void; action?: string }>(function Turnstile(
  { onToken, action },
  ref,
) {
  const { config } = useSession();
  const el = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  const siteKey = config?.turnstileSiteKey ?? null;

  useImperativeHandle(ref, () => ({
    reset() {
      if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
      cb.current(null);
    },
  }));

  useEffect(() => {
    if (!siteKey || !el.current) return;
    let cancelled = false;
    loadTurnstile().then(
      (ts) => {
        if (cancelled || !el.current) return;
        widget.current = ts.render(el.current, {
          sitekey: siteKey,
          action,
          theme: "auto",
          size: "flexible",
          callback: (t: string) => cb.current(t),
          "expired-callback": () => cb.current(null),
          "error-callback": () => cb.current(null),
        });
      },
      () => cb.current(null),
    );
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, action]);

  if (!siteKey) return null;
  return <div ref={el} className="turnstile" />;
});

/** Whether the form must wait for a Turnstile token before submitting. */
export function useTurnstileRequired(): boolean {
  return Boolean(useSession().config?.turnstileSiteKey);
}
