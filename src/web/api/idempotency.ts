import { useCallback, useRef, useState } from "react";
import { ApiError } from "./errors";

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function newKey(): string {
  return crypto.randomUUID();
}

/**
 * One logical submit = one Idempotency-Key. Submitting the same payload again (a retry
 * after a network failure, a double click) reuses the key so the server replays the
 * committed result instead of applying it twice. A changed payload is a new submit.
 * A server-side rejection also ends the submit, because resending the same payload
 * would only replay the same rejection.
 */
export class IdempotentSubmit {
  private key: string | null = null;
  private payload: string | null = null;

  keyFor(body: unknown): string {
    const p = stableStringify(body);
    if (this.key === null || p !== this.payload) {
      this.key = newKey();
      this.payload = p;
    }
    return this.key;
  }

  /** Call after the server answered (success or a definitive error). */
  settle(err?: unknown): void {
    if (err instanceof ApiError && err.retryable) return;
    this.key = null;
    this.payload = null;
  }
}

/**
 * React wrapper: `run(body, (key) => api.x(..., body, { idempotencyKey: key }))`.
 * Ignores re-entry while a submit is in flight.
 */
export function useSubmit() {
  const ref = useRef(new IdempotentSubmit());
  const inflight = useRef(false);
  const [pending, setPending] = useState(false);

  const run = useCallback(async <T,>(body: unknown, fn: (idempotencyKey: string) => Promise<T>): Promise<T> => {
    if (inflight.current) throw new Error("SUBMIT_IN_FLIGHT");
    inflight.current = true;
    setPending(true);
    const key = ref.current.keyFor(body);
    try {
      const r = await fn(key);
      ref.current.settle();
      return r;
    } catch (e) {
      ref.current.settle(e);
      throw e;
    } finally {
      inflight.current = false;
      setPending(false);
    }
  }, []);

  return { run, pending };
}
