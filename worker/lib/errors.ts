import type { ApiErrorBody, ApiErrorCode } from "@shared/api";

const DEFAULT_STATUS: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  ROUND_NOT_COLLECTING: 409,
  ROUND_NOT_SETTLING: 409,
  STALE_VERSION: 409,
  REVIEW_STALE: 409,
  NOT_READY_UNACKNOWLEDGED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  MULTI_CURRENCY_DISABLED: 409,
  FOREIGN_ENTRIES_EXIST: 409,
  CURRENCY_LOCKED: 409,
  MEMBER_REFERENCED: 409,
  INVITE_INVALID: 404,
  INVALID_TRANSITION: 409,
  RATE_LIMITED: 429,
  TURNSTILE_FAILED: 403,
  LIMIT_EXCEEDED: 422,
  INTERNAL: 500,
};

/** Thrown anywhere in the edge; rendered by the app's onError as ApiErrorBody. */
export class ApiError extends Error {
  readonly status: number;
  readonly field: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    opts: { status?: number; field?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.status = opts.status ?? DEFAULT_STATUS[code];
    this.field = opts.field;
    this.details = opts.details;
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorBody["error"] = { code: this.code, message: this.message };
    if (this.field !== undefined) error.field = this.field;
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

export const unauthenticated = () => new ApiError("UNAUTHENTICATED", "Please sign in to continue.");
export const notFound = (message = "This page isn't available.") => new ApiError("NOT_FOUND", message);
