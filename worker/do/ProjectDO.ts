/**
 * ProjectDO — the only accounting and permission authority for one project.
 *
 * Every mutation runs inside one `transactionSync`: idempotency lookup, membership/role checks,
 * state + version validation, the change itself, audit, outbox and the idempotency record all
 * commit together or not at all. Network work (queue publication, socket broadcasts) happens
 * only after commit.
 */
import { DurableObject } from "cloudflare:workers";
import type { LiveMessage } from "@shared/api";
import { ApiError, invalid, unauthenticated } from "./errors";
import { accountDeletionInfo, anonymizeMember, deletionPrincipals } from "./ops/account";
import { acceptOwnership, createInvite, createProject, deleteRate, join, leave, previewInvite, principalUpdated, putRate, removeMember, renameMe, revokeInvite, transferOwnership, updateSettings, type OpResult } from "./ops/project";
import { acceptMemberInvite, addMember, cancelMemberInvite, inviteMember, previewMemberInvite, renameMember } from "./ops/members";
import { createAdjustment, createEntry, deleteEntry, setReadiness, updateEntry } from "./ops/ledger";
import { backupSnapshot, exportCsv, getHistory, getProject, getReview, getRound } from "./ops/read";
import { freeze, markDisputed, markReceived, markSent, scheduledFreeze, setFreezeSchedule, startRound } from "./ops/settlement";
import { logError } from "../lib/log";
import { migrate } from "./schema";
import { Store } from "./store";
import { Tx } from "./tx";
import { PRINCIPAL_HEADER, type DoOp, type DoRequest, type DoResponse, type OutboxMessage, type Principal, type ProjectDORpc } from "./types";

type Prepared = { secret?: string; secretHash?: string };
type MutationOp = Exclude<DoOp, ReadOp | "deleteProject">;
type ReadOp =
  | "getProject"
  | "previewInvite"
  | "previewMemberInvite"
  | "getReview"
  | "getRound"
  | "getHistory"
  | "exportCsv"
  | "backupSnapshot"
  | "accountDeletionInfo";

const READ_OPS: Record<ReadOp, (tx: Tx, req: DoRequest, prepared: Prepared) => DoResponse> = {
  getProject: (tx) => getProject(tx),
  previewMemberInvite: (tx, _req, p) => previewMemberInvite(tx, { secretHash: p.secretHash! }),
  previewInvite: (tx, _req, p) => previewInvite(tx, { secretHash: p.secretHash! }),
  getReview: (tx, req) => getReview(tx, req),
  getRound: (tx, req) => getRound(tx, req),
  getHistory: (tx) => getHistory(tx),
  exportCsv: (tx) => exportCsv(tx),
  backupSnapshot: (tx) => backupSnapshot(tx),
  accountDeletionInfo: (tx) => accountDeletionInfo(tx),
};

/** Ops that the edge calls on its own behalf without an idempotency key. */
const KEYLESS_OPS = new Set<DoOp>(["principalUpdated", "anonymizeMember"]);

const OUTBOX_BATCH = 20;
const OUTBOX_MAX_BACKOFF_MS = 10 * 60 * 1000;
const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A scheduled freeze that failed (it never should) is retried after this delay, not in a tight loop. */
const SCHEDULED_FREEZE_RETRY_MS = 10 * 60 * 1000;

export class ProjectDO extends DurableObject<Env> implements ProjectDORpc {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql));
      await this.armAlarm();
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async handle(req: DoRequest): Promise<DoResponse> {
    try {
      return await this.dispatch(req);
    } catch (err) {
      if (err instanceof ApiError) return err.toResponse();
      // Never log request bodies: they hold private expense data.
      logError("ProjectDO op failed", err, { op: req.op, requestId: req.requestId });
      return {
        status: 500,
        body: { error: { code: "INTERNAL", message: "Something went wrong. Nothing was saved." } },
      };
    }
  }

  private async dispatch(req: DoRequest): Promise<DoResponse> {
    if (req.op === "deleteProject") return this.deleteProject(req);
    const prepared = await this.prepare(req);
    if (req.op in READ_OPS) {
      const tx = new Tx(this.store, req.principal);
      return READ_OPS[req.op as ReadOp](tx, req, prepared);
    }

    if (!req.principal && !KEYLESS_OPS.has(req.op)) throw unauthenticated();
    if (!req.idempotencyKey && !KEYLESS_OPS.has(req.op)) throw invalid(undefined, "Missing Idempotency-Key");
    const requestHash = await sha256Hex(canonicalJson({ op: req.op, params: req.params, body: req.body ?? null }));

    const outcome = this.ctx.storage.transactionSync(() => {
      const key = req.idempotencyKey && req.principal ? { p: req.principal.principalId, k: req.idempotencyKey } : null;
      if (key) {
        const prior = this.store.first<{ request_hash: string; status: number; response_json: string }>(
          "SELECT request_hash, status, response_json FROM idempotency WHERE principal_id = ? AND op = ? AND key = ?",
          key.p,
          req.op,
          key.k,
        );
        if (prior) {
          if (prior.request_hash !== requestHash) {
            throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This request was already used with different content.");
          }
          const response = JSON.parse(prior.response_json) as DoResponse;
          return { response, changed: false, projectVersion: 0, outbox: false, disconnect: [] as string[], roundId: null };
        }
      }

      const tx = new Tx(this.store, req.principal);
      const result = this.mutate(req.op as MutationOp, tx, req, prepared);
      const { projectVersion, outbox } = tx.finish();
      const response = typeof result === "function" ? result() : result;
      if (key && response.status < 300) {
        // `transient` (invite URLs, invited emails) is edge-only and must never be stored.
        const { transient: _edgeOnly, ...stored } = response;
        this.store.run(
          "INSERT INTO idempotency (principal_id, op, key, request_hash, status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          key.p,
          req.op,
          key.k,
          requestHash,
          response.status,
          JSON.stringify(stored),
          tx.now,
        );
      }
      return {
        response,
        changed: tx.changed,
        projectVersion,
        outbox,
        disconnect: tx.disconnect,
        roundId: this.store.project()?.active_round_id ?? req.params.roundId ?? null,
      };
    });

    if (outcome.changed) {
      this.broadcast({ type: "changed", projectVersion: outcome.projectVersion, roundId: outcome.roundId, reason: req.op });
      for (const memberId of outcome.disconnect) {
        for (const ws of this.ctx.getWebSockets(memberId)) closeQuietly(ws, 4403, "removed");
      }
      await this.armAlarm();
    }
    return outcome.response;
  }

  /**
   * Owner deletes the whole project (account deletion). Wipes all storage and the alarm; the
   * schema is recreated empty, so this and any later instance answer 404 until a createProject.
   */
  private async deleteProject(req: DoRequest): Promise<DoResponse> {
    // Checked before blockConcurrencyWhile (a throw inside it resets the object) but in the same
    // turn, so nothing can interleave between the owner check and the wipe.
    const memberPrincipalIds = deletionPrincipals(new Tx(this.store, req.principal));
    await this.ctx.blockConcurrencyWhile(async () => {
      for (const ws of this.ctx.getWebSockets()) closeQuietly(ws, 4404, "deleted");
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.ctx.storage.transactionSync(() => migrate(this.ctx.storage.sql));
    });
    return { status: 200, body: { memberPrincipalIds } };
  }

  /** Async work that must finish before the synchronous transaction starts. */
  private async prepare(req: DoRequest): Promise<Prepared> {
    if (req.op === "createInvite" || req.op === "addMember" || req.op === "inviteMember") {
      const secret = randomSecret();
      return { secret, secretHash: await sha256Hex(secret) };
    }
    if (req.op === "previewInvite" || req.op === "join" || req.op === "previewMemberInvite" || req.op === "acceptMemberInvite") {
      const raw = req.params.tokenSecret ?? "";
      const dot = raw.lastIndexOf(".");
      const secret = dot >= 0 ? raw.slice(dot + 1) : raw;
      const projectId = dot >= 0 ? raw.slice(0, dot) : null;
      const project = this.store.project();
      if (!secret || (projectId !== null && project && projectId !== project.id)) {
        throw new ApiError(404, "INVITE_INVALID", "This invitation link isn't valid.");
      }
      return { secretHash: await sha256Hex(secret) };
    }
    return {};
  }

  private mutate(op: MutationOp, tx: Tx, req: DoRequest, prepared: Prepared): OpResult {
    switch (op) {
      case "createProject":
        return createProject(tx, req);
      case "updateSettings":
        return updateSettings(tx, req);
      case "putRate":
        return putRate(tx, req);
      case "deleteRate":
        return deleteRate(tx, req);
      case "createInvite":
        return createInvite(tx, req, { secret: prepared.secret!, secretHash: prepared.secretHash! }, this.env.APP_ORIGIN);
      case "revokeInvite":
        return revokeInvite(tx, req);
      case "join":
        return join(tx, req, { secretHash: prepared.secretHash! });
      case "removeMember":
        return removeMember(tx, req);
      case "leave":
        return leave(tx);
      case "transferOwnership":
        return transferOwnership(tx, req);
      case "acceptOwnership":
        return acceptOwnership(tx);
      case "createEntry":
        return createEntry(tx, req);
      case "updateEntry":
        return updateEntry(tx, req);
      case "deleteEntry":
        return deleteEntry(tx, req);
      case "createAdjustment":
        return createAdjustment(tx, req);
      case "setReadiness":
        return setReadiness(tx, req);
      case "freeze":
        return freeze(tx, req);
      case "markSent":
        return markSent(tx, req);
      case "markReceived":
        return markReceived(tx, req);
      case "markDisputed":
        return markDisputed(tx, req);
      case "startRound":
        return startRound(tx);
      case "renameMe":
        return renameMe(tx, req);
      case "setFreezeSchedule":
        return setFreezeSchedule(tx, req);
      case "anonymizeMember":
        return anonymizeMember(tx);
      case "principalUpdated":
        return principalUpdated(tx, req);
      case "addMember":
        return addMember(tx, req, { secret: prepared.secret!, secretHash: prepared.secretHash! }, this.env.APP_ORIGIN);
      case "renameMember":
        return renameMember(tx, req);
      case "inviteMember":
        return inviteMember(tx, req, { secret: prepared.secret!, secretHash: prepared.secretHash! }, this.env.APP_ORIGIN);
      case "cancelMemberInvite":
        return cancelMemberInvite(tx, req);
      case "acceptMemberInvite":
        return acceptMemberInvite(tx, req, { secretHash: prepared.secretHash! });
      default: {
        const unknownOp: never = op;
        throw invalid(undefined, `Unknown operation ${String(unknownOp)}`);
      }
    }
  }

  // ---------- live updates ----------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const principal = parsePrincipal(request.headers.get(PRINCIPAL_HEADER));
    if (!principal) return Response.json(unauthenticated().toResponse().body, { status: 401 });
    const project = this.store.project();
    const member = project ? this.store.memberByPrincipal(principal.principalId) : undefined;
    if (!project || !member || member.status === "REMOVED") {
      return Response.json({ error: { code: "NOT_FOUND", message: "This group isn't available." } }, { status: 404 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [member.id]);
    server.serializeAttachment({ memberId: member.id });
    const hello: LiveMessage = { type: "hello", projectVersion: project.version };
    server.send(JSON.stringify(hello));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> {
    // Clients only listen; "ping" is answered by the auto-response without waking us.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    closeQuietly(ws, code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    closeQuietly(ws, 1011, "error");
  }

  private broadcast(message: LiveMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // A dead socket is cleaned up by its close handler; clients refetch on reconnect.
      }
    }
  }

  // ---------- alarm: scheduled freeze + outbox ----------

  /**
   * One alarm serves both the scheduled freeze and outbox publication. Never throws (a throwing
   * alarm is retried by the runtime); always re-arms for whatever is due next.
   */
  async alarm(): Promise<void> {
    let freezeFailed = false;
    try {
      this.runScheduledFreeze();
    } catch (err) {
      freezeFailed = true;
      logError("scheduled freeze failed", err);
    }
    try {
      await this.publishOutbox();
    } catch (err) {
      logError("outbox publication failed", err);
    }
    await this.armAlarm(freezeFailed);
  }

  /** Freezes the active round if its scheduled instant has passed; a no-op when nothing is due. */
  private runScheduledFreeze(): void {
    const outcome = this.ctx.storage.transactionSync(() => {
      const tx = new Tx(this.store, null);
      const roundId = scheduledFreeze(tx, Date.now());
      if (!roundId) return null;
      const { projectVersion } = tx.finish();
      return { projectVersion, roundId };
    });
    if (outcome) this.broadcast({ type: "changed", projectVersion: outcome.projectVersion, roundId: outcome.roundId, reason: "freeze" });
  }

  private async publishOutbox(): Promise<void> {
    const now = Date.now();
    const rows = this.store.all<{ seq: number; message_json: string; attempts: number }>(
      "SELECT seq, message_json, attempts FROM outbox WHERE sent_at IS NULL AND next_attempt_at <= ? ORDER BY seq LIMIT ?",
      now,
      OUTBOX_BATCH,
    );
    if (rows.length > 0) {
      try {
        await this.env.EVENTS.sendBatch(
          rows.map((r) => ({ body: JSON.parse(r.message_json) as OutboxMessage, contentType: "json" as const })),
        );
        const sentAt = new Date().toISOString();
        for (const r of rows) this.store.run("UPDATE outbox SET sent_at = ?, last_error = NULL WHERE seq = ?", sentAt, r.seq);
      } catch (err) {
        for (const r of rows) {
          const attempts = r.attempts + 1;
          const backoff = Math.min(OUTBOX_MAX_BACKOFF_MS, 1000 * 2 ** attempts);
          this.store.run(
            "UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE seq = ?",
            attempts,
            now + backoff,
            String(err).slice(0, 500),
            r.seq,
          );
        }
      }
    }
    this.store.run(
      "DELETE FROM outbox WHERE sent_at IS NOT NULL AND created_at < ?",
      new Date(now - OUTBOX_RETENTION_MS).toISOString(),
    );
  }

  /**
   * Sets the alarm to exactly min(next outbox retry, scheduled freeze instant), or clears it when
   * neither is pending. Derived from durable state each time, so it's safe to call after any change.
   */
  private async armAlarm(freezeFailed = false): Promise<void> {
    const now = Date.now();
    const outbox = this.store.first<{ t: number | null }>("SELECT MIN(next_attempt_at) AS t FROM outbox WHERE sent_at IS NULL");
    const round = this.store.first<{ at: string | null }>(
      `SELECT r.scheduled_freeze_at AS at FROM rounds r JOIN project p ON p.active_round_id = r.id
       WHERE r.status = 'COLLECTING' AND r.scheduled_freeze_at IS NOT NULL`,
    );
    const due: number[] = [];
    if (outbox?.t !== null && outbox?.t !== undefined) due.push(Number(outbox.t));
    if (round?.at) due.push(freezeFailed ? now + SCHEDULED_FREEZE_RETRY_MS : Date.parse(round.at));
    const current = await this.ctx.storage.getAlarm();
    if (due.length === 0) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const at = Math.max(Math.min(...due), now);
    if (current !== at) await this.ctx.storage.setAlarm(at);
  }
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // already closed
  }
}

function parsePrincipal(raw: string | null): Principal | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Principal>;
    if (typeof p.principalId !== "string" || !p.principalId) return null;
    return {
      principalId: p.principalId,
      kind: p.kind === "ACCOUNT" ? "ACCOUNT" : "GUEST",
      email: typeof p.email === "string" ? p.email : null,
      hasRecoverableAccount: p.hasRecoverableAccount === true,
    };
  } catch {
    return null;
  }
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with recursively sorted object keys, so equal requests hash equally. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
