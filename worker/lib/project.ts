import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { DoOp, DoRequest, DoResponse, Principal } from "../do/types";
import { ApiError } from "./errors";
import { logError } from "./log";

/** Project IDs are `p_` + 32 hex chars; anything else is rejected before touching a DO. */
export const PROJECT_ID_RE = /^p_[0-9a-f]{32}$/;

export function projectStub(env: Env, projectId: string) {
  return env.PROJECT.get(env.PROJECT.idFromName(projectId));
}

export interface CallOptions {
  op: DoOp;
  projectId: string;
  principal: Principal | null;
  params?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string | null;
  requestId: string;
}

/** Single RPC entry into ProjectDO. Transport failures become 500 INTERNAL (logged without payload). */
export async function callProject(env: Env, opts: CallOptions): Promise<DoResponse> {
  const req: DoRequest = {
    op: opts.op,
    principal: opts.principal,
    params: { ...opts.params, projectId: opts.projectId },
    body: opts.body ?? null,
    idempotencyKey: opts.idempotencyKey ?? null,
    requestId: opts.requestId,
  };
  try {
    const res: DoResponse = await projectStub(env, opts.projectId).handle(req);
    return res;
  } catch (err) {
    logError("project rpc failed", err, { op: opts.op, projectId: opts.projectId, requestId: opts.requestId });
    throw new ApiError("INTERNAL", "Something went wrong. Please try again.", { details: { requestId: opts.requestId } });
  }
}

export const isOk = (res: DoResponse) => res.status >= 200 && res.status < 300;

/** Maps a DoResponse onto the Hono context (so cookies/headers set on `c` are kept). */
export function toHttpResponse(c: Context, res: DoResponse, op: DoOp): Response {
  const headers: Record<string, string> = { ...res.headers };
  const status = res.status as StatusCode;
  if (res.status === 204 || res.status === 304 || res.body === null || res.body === undefined) {
    return c.newResponse(null, status, headers);
  }
  const hasType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
  if (typeof res.body === "string") {
    if (!hasType) headers["content-type"] = op === "exportCsv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8";
    return c.newResponse(res.body, status, headers);
  }
  if (!hasType) headers["content-type"] = "application/json; charset=utf-8";
  return c.newResponse(JSON.stringify(res.body), status, headers);
}
