import { lazy, type ComponentType } from "react";

const RELOAD_KEY = "sd-chunk-reload-at";

/**
 * After a deploy, a tab opened earlier still references the old hashed chunks, which no longer exist.
 * Reload once to pick up the new build; if that already happened in the last minute, let the error
 * reach the error boundary instead of looping.
 */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** React.lazy for a named page export, recovering from stale chunks after a deploy. */
export function lazyPage<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(() =>
    load().then(
      (m) => ({ default: m[name] as ComponentType }),
      (err: unknown) => {
        // Never resolves: the page is reloading.
        if (reloadForNewBuild()) return new Promise<never>(() => {});
        throw err;
      },
    ),
  );
}
