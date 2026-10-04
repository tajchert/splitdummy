import type { z } from "zod";
import type { ApiErrorBody, ApiErrorCode } from "@shared/api";
import type { DoResponse } from "./types";

/** Thrown inside op handlers; aborts the surrounding transaction and becomes an ApiErrorBody response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly field?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  toResponse(): DoResponse {
    const body: ApiErrorBody = { error: { code: this.code, message: this.message } };
    if (this.field !== undefined) body.error.field = this.field;
    if (this.details !== undefined) body.error.details = this.details;
    return { status: this.status, body };
  }
}

export const unauthenticated = () => new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");

/** Never distinguishes "does not exist" from "you are not a member". */
export const notFound = (message = "This group isn't available.") => new ApiError(404, "NOT_FOUND", message);

export const forbidden = (message: string) => new ApiError(403, "FORBIDDEN", message);

export const conflict = (code: ApiErrorCode, message: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, undefined, details);

export const invalid = (field: string | undefined, message: string, details?: Record<string, unknown>) =>
  new ApiError(422, "VALIDATION", message, field, details);

export const limitExceeded = (message: string, status = 429, details?: Record<string, unknown>) =>
  new ApiError(status, "LIMIT_EXCEEDED", message, undefined, details);

export const notCollecting = () =>
  conflict("ROUND_NOT_COLLECTING", "Expenses are frozen for this round. Nothing was saved.");

export const notSettling = () => conflict("ROUND_NOT_SETTLING", "This round is not in settlement.");

/** Parse with a zod schema; the first issue becomes a 422 with its field path. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : undefined;
  throw invalid(field, issue?.message ?? "Invalid request");
}
