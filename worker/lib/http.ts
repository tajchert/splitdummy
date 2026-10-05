import type { z } from "zod";
import { ApiError } from "./errors";

/** Upper bound for JSON request bodies (largest legit body is an entry with 100 participants). */
export const MAX_JSON_BYTES = 64 * 1024;

/** Reads a request body without buffering more than `limit` bytes (413 beyond it). No body → empty array. */
export async function readBodyBytes(req: Request, limit: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw tooLarge();
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Reads a JSON body without buffering more than `limit` bytes. Empty body → undefined. */
export async function readJsonBody(req: Request, limit = MAX_JSON_BYTES): Promise<unknown> {
  const bytes = await readBodyBytes(req, limit);
  if (bytes.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("VALIDATION", "Request body must be valid JSON.");
  }
}

const tooLarge = () => new ApiError("LIMIT_EXCEEDED", "Request is too large.", { status: 413 });

/** Validates with a shared zod schema; the first issue becomes the error's field path. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : undefined;
  throw new ApiError("VALIDATION", issue?.message ?? "Invalid input.", field ? { field } : {});
}

/** `next` redirect target: same-origin relative path only (no `//host`, no backslashes). */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  return next;
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}
