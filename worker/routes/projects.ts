import { Hono } from "hono";
import type { z } from "zod";
import {
  AdjustmentInputSchema,
  CreateProjectSchema,
  DeleteEntrySchema,
  ENDPOINTS,
  EntryInputSchema,
  FreezeScheduleSchema,
  FreezeSchema,
  InstructionActionSchema,
  PutRateSchema,
  ReadinessSchema,
  RenameMemberSchema,
  TransferOwnershipSchema,
  UpdateEntrySchema,
  UpdateSettingsSchema,
} from "@shared/api";
import type { DoOp } from "../do/types";
import { requireIdempotencyKey, requireSession } from "../auth/middleware";
import { toPrincipal } from "../auth/principals";
import type { AppContext, AppEnv } from "../lib/context";
import { sha256Hex } from "../lib/crypto";
import { listProjects, rowFromProjectView, upsertStatement } from "../lib/directory";
import { ApiError, notFound } from "../lib/errors";
import { parseWith, readJsonBody } from "../lib/http";
import { logError } from "../lib/log";
import { callProject, isOk, PROJECT_ID_RE, toHttpResponse } from "../lib/project";
import { enforceLimit } from "../lib/ratelimit";

type EndpointKey = keyof typeof ENDPOINTS;

interface DoRoute {
  op: DoOp;
  schema?: z.ZodType;
}

/** Endpoints that map 1:1 onto a ProjectDO op for an authenticated member. */
export const PROJECT_ROUTES = {
  getProject: { op: "getProject" },
  updateSettings: { op: "updateSettings", schema: UpdateSettingsSchema },
  putRate: { op: "putRate", schema: PutRateSchema },
  deleteRate: { op: "deleteRate" },
  createInvite: { op: "createInvite" },
  revokeInvite: { op: "revokeInvite" },
  removeMember: { op: "removeMember" },
  leave: { op: "leave" },
  renameMe: { op: "renameMe", schema: RenameMemberSchema },
  renameMember: { op: "renameMember", schema: RenameMemberSchema },
  cancelMemberInvite: { op: "cancelMemberInvite" },
  transferOwnership: { op: "transferOwnership", schema: TransferOwnershipSchema },
  acceptOwnership: { op: "acceptOwnership" },
  createEntry: { op: "createEntry", schema: EntryInputSchema },
  updateEntry: { op: "updateEntry", schema: UpdateEntrySchema },
  deleteEntry: { op: "deleteEntry", schema: DeleteEntrySchema },
  createAdjustment: { op: "createAdjustment", schema: AdjustmentInputSchema },
  readiness: { op: "setReadiness", schema: ReadinessSchema },
  review: { op: "getReview" },
  freeze: { op: "freeze", schema: FreezeSchema },
  freezeSchedule: { op: "setFreezeSchedule", schema: FreezeScheduleSchema },
  getRound: { op: "getRound" },
  sent: { op: "markSent", schema: InstructionActionSchema },
  received: { op: "markReceived", schema: InstructionActionSchema },
  dispute: { op: "markDisputed", schema: InstructionActionSchema },
  startRound: { op: "startRound" },
  history: { op: "getHistory" },
  export: { op: "exportCsv" },
} satisfies Partial<Record<EndpointKey, DoRoute>>;

const ID_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Path params are opaque IDs; malformed ones are "unavailable" (404) without reaching a DO. */
export function validateParams(params: Record<string, string>): void {
  for (const [name, value] of Object.entries(params)) {
    if (name === "projectId") {
      if (!PROJECT_ID_RE.test(value)) throw notFound();
    } else if (name === "currency") {
      if (!CURRENCY_RE.test(value)) throw new ApiError("VALIDATION", "Invalid currency code", { field: "currency" });
    } else if (!ID_PARAM_RE.test(value)) {
      throw notFound();
    }
  }
}

export function splitEndpoint(key: EndpointKey): { method: string; path: string } {
  const [method, path] = ENDPOINTS[key].split(" ");
  if (!method || !path) throw new Error(`bad endpoint ${key}`);
  return { method, path: path.split("?")[0] ?? path };
}

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.get("/api/projects", async (c) => {
  const { principal } = await requireSession(c);
  return c.json(await listProjects(c.env.DB, principal.id));
});

projectRoutes.post("/api/projects", async (c) => {
  const { principal } = await requireSession(c);
  if (principal.kind !== "ACCOUNT") {
    throw new ApiError("FORBIDDEN", "Sign in with your email to create a group, so you can always get back to it.", {
      details: { reason: "ACCOUNT_REQUIRED" },
    });
  }
  const idempotencyKey = requireIdempotencyKey(c);
  await enforceLimit(c.env.RL_CREATE_PROJECT, `principal:${principal.id}`);
  // Only signed-in accounts get here (verified email + session), so no Turnstile; the rate limit stays.
  // A client may still send a token; it is ignored.
  const { turnstileToken: _ignored, ...input } = parseWith(CreateProjectSchema, await readJsonBody(c.req.raw));

  // Derived from (principal, idempotency key) so a retried create lands on the same DO, which
  // then replays its committed response instead of creating a second project.
  const projectId = `p_${(await sha256Hex(`${principal.id}:${idempotencyKey}`)).slice(0, 32)}`;
  const res = await callProject(c.env, {
    op: "createProject",
    projectId,
    principal: toPrincipal(principal),
    body: { ...input, projectId },
    idempotencyKey,
    requestId: c.get("requestId"),
  });
  if (isOk(res)) {
    await recordMembership(c, principal.id, res.body, input.ownerDisplayName);
  }
  return toHttpResponse(c, res, "createProject");
});

for (const [key, route] of Object.entries(PROJECT_ROUTES) as [EndpointKey, DoRoute][]) {
  const { method, path } = splitEndpoint(key);
  projectRoutes.on(method, path, async (c) => {
    const { principal } = await requireSession(c);
    const params = c.req.param() as Record<string, string>;
    validateParams(params);
    const projectId = params.projectId;
    if (!projectId) throw notFound();

    let body: unknown = null;
    let idempotencyKey: string | null = null;
    if (method !== "GET") {
      idempotencyKey = requireIdempotencyKey(c);
      await enforceLimit(c.env.RL_MUTATION, `principal:${principal.id}`);
      const raw = await readJsonBody(c.req.raw);
      body = route.schema ? parseWith(route.schema, raw) : (raw ?? null);
    }

    const res = await callProject(c.env, {
      op: route.op,
      projectId,
      principal: toPrincipal(principal),
      params,
      body,
      idempotencyKey,
      requestId: c.get("requestId"),
    });
    // Edge-only fields (`transient`) never reach browsers from any op.
    return toHttpResponse(c, { status: res.status, body: res.body, headers: res.headers }, route.op);
  });
}

/**
 * Upserts the caller's "My groups" row right away (same version guard as the queue projection),
 * so the dashboard doesn't wait for the outbox. Best effort: the DO already committed.
 */
export async function recordMembership(c: AppContext, principalId: string, view: unknown, displayName: string): Promise<void> {
  try {
    const row = rowFromProjectView(principalId, view);
    const statements = [];
    if (row) statements.push(upsertStatement(c.env.DB, row, ">"));
    // Prefill only: an account name set via PATCH /api/me (or an earlier group) wins.
    statements.push(
      c.env.DB.prepare(
        "UPDATE principals SET display_name = COALESCE(display_name, ?), updated_at = ? WHERE id = ?",
      ).bind(displayName, Date.now(), principalId),
    );
    await c.env.DB.batch(statements);
  } catch (err) {
    logError("directory upsert failed", err, { requestId: c.get("requestId") });
  }
}
