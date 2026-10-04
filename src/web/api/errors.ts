import type { ApiErrorBody, ApiErrorCode } from "@shared/api";

/** Server codes plus client-only conditions (no response at all). */
export type ClientErrorCode = ApiErrorCode | "NETWORK";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly field: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: ClientErrorCode, message: string, field?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
  }

  /** Worth retrying with the same Idempotency-Key: nothing or a transient failure came back. */
  get retryable(): boolean {
    return this.code === "NETWORK" || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

const FALLBACK: Partial<Record<number, { code: ApiErrorCode; message: string }>> = {
  401: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
  403: { code: "FORBIDDEN", message: "You can't do that in this group." },
  404: { code: "NOT_FOUND", message: "This page isn't available." },
  409: { code: "INVALID_TRANSITION", message: "Something changed in the meantime. Refresh and try again." },
  422: { code: "VALIDATION", message: "Check the highlighted fields." },
  429: { code: "RATE_LIMITED", message: "Too many attempts. Wait a minute and try again." },
};

function isErrorBody(v: unknown): v is ApiErrorBody {
  if (typeof v !== "object" || v === null || !("error" in v)) return false;
  const e = (v as { error: unknown }).error;
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string";
}

/** Turn any non-2xx response body into an ApiError, tolerating non-JSON bodies from proxies. */
export function parseErrorBody(status: number, body: unknown): ApiError {
  if (isErrorBody(body)) {
    const { code, message, field, details } = body.error;
    return new ApiError(status, code, message || FALLBACK[status]?.message || "Something went wrong.", field, details);
  }
  const fb = FALLBACK[status] ?? { code: "INTERNAL" as const, message: "Something went wrong on our side. Try again." };
  return new ApiError(status, fb.code, fb.message);
}

export function networkError(): ApiError {
  return new ApiError(0, "NETWORK", "You're offline or the server can't be reached. Your input is kept; try again.");
}

/**
 * Map an error to form fields. Server field paths like "participants.0.amount" are kept
 * verbatim; forms look up the paths they render. Errors without a field land on "_form".
 */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return { _form: "Something went wrong. Try again." };
  if (err.field) return { [err.field]: err.message };
  return { _form: err.message };
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Try again.";
}
