import type { ClientErrorReport } from "@shared/api";
import { ApiError } from "../api/errors";

/** Per page load: enough to diagnose a crash, never a flood from an error loop. */
const MAX_REPORTS = 5;

let enabled = false;
let sent = 0;
const seen = new Set<string>();

/** Sends a browser crash to the edge log. Best effort: never throws, never retries. */
export function reportClientError(kind: ClientErrorReport["kind"], error: unknown): void {
  // API failures are already logged by the edge (or are expected 4xx answers).
  if (!enabled || sent >= MAX_REPORTS || error instanceof ApiError) return;
  const err = error instanceof Error ? error : null;
  const message = (err ? `${err.name}: ${err.message}` : String(error)).slice(0, 500);
  if (seen.has(message)) return;
  seen.add(message);
  sent++;
  // Path only: queries and fragments can carry invite or sign-in tokens.
  const report: ClientErrorReport = { kind, message, stack: err?.stack?.slice(0, 4000), path: window.location.pathname.slice(0, 300) };
  try {
    void fetch("/api/client-errors", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    }).catch(() => {});
  } catch {
    /* fetch unavailable */
  }
}

/** Reports uncaught errors and rejections from our own code (not extensions or third-party scripts). */
export function listenForErrors() {
  enabled = true;
  sent = 0;
  seen.clear();
  const onError = (event: ErrorEvent) => {
    // Cross-origin scripts arrive as a bare "Script error." without an error object.
    if (!event.error || (event.filename && !event.filename.startsWith(window.location.origin))) return;
    reportClientError("error", event.error);
  };
  const onRejection = (event: PromiseRejectionEvent) => reportClientError("unhandledrejection", event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    enabled = false;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
