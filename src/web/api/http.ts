import type {
  AddMemberResultDTO,
  ApiKeyDTO,
  AttachmentDTO,
  CreatedApiKeyDTO,
  ConfigDTO,
  DeletionPreviewDTO,
  HistoryDTO,
  InvitationDTO,
  InvitationPreviewDTO,
  JoinResultDTO,
  LiveMessage,
  MeDTO,
  MemberDTO,
  MemberInvitePreviewDTO,
  ProjectSummaryDTO,
  ProjectViewDTO,
  ReviewDTO,
  RoundDTO,
  RoundViewDTO,
  SignInRequestedDTO,
  SignInVerifiedDTO,
} from "@shared/api";
import { ApiError, networkError, parseErrorBody } from "./errors";
import type { Api, LiveHandlers, LiveSubscription, MutationOptions } from "./types";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpOptions {
  /** Defaults to globalThis.fetch; injectable for tests. */
  fetch?: typeof fetch;
  /** Attempts for a mutation when nothing (or a 502–504) came back. Same key every time. */
  maxAttempts?: number;
  /** Delay before retry n (1-based). */
  retryDelayMs?: (attempt: number) => number;
  /** WebSocket constructor; injectable for tests. */
  WebSocket?: typeof WebSocket;
  /** Origin used to build ws(s):// URLs. */
  location?: { protocol: string; host: string };
}

const enc = encodeURIComponent;

export function createHttpApi(opts: HttpOptions = {}): Api {
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelay = opts.retryDelayMs ?? ((n) => 400 * 2 ** (n - 1));

  async function once(method: Method, path: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal) {
    let res: Response;
    const raw = body instanceof Blob;
    try {
      res = await doFetch(path, {
        method,
        credentials: "same-origin",
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": raw ? body.type : "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw networkError();
    }
    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        /* non-JSON error page */
      }
      throw parseErrorBody(res.status, parsed);
    }
    return res;
  }

  async function request<T>(method: Method, path: string, body?: unknown, o?: MutationOptions): Promise<T> {
    const headers: Record<string, string> = {};
    if (method !== "GET") {
      if (!o?.idempotencyKey) throw new Error(`Mutation ${method} ${path} needs an idempotency key`);
      headers["Idempotency-Key"] = o.idempotencyKey;
    }
    // GETs are safe to retry; mutations are safe because the key is the same on every attempt.
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await once(method, path, body, headers, o?.signal);
        if (res.status === 204) return undefined as T;
        const type = res.headers.get("Content-Type") ?? "";
        if (!type.includes("json")) return undefined as T;
        return (await res.json()) as T;
      } catch (e) {
        if (!(e instanceof ApiError) || !e.retryable || attempt >= maxAttempts) throw e;
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
      }
    }
  }

  const get = <T>(path: string) => request<T>("GET", path);
  const P = (projectId: string) => `/api/projects/${enc(projectId)}`;
  const R = (projectId: string, roundId: string) => `${P(projectId)}/rounds/${enc(roundId)}`;

  return {
    getConfig: () => get<ConfigDTO>("/api/config"),
    listApiKeys: () => get<ApiKeyDTO[]>("/api/me/api-keys"),
    async createApiKey(body) {
      const res = await once("POST", "/api/me/api-keys", body, {});
      return (await res.json()) as CreatedApiKeyDTO;
    },
    async revokeApiKey(id) {
      await once("DELETE", `/api/me/api-keys/${enc(id)}`, undefined, {});
    },
    async getMe() {
      try {
        return await get<MeDTO>("/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    requestSignIn: (body, o) => request<SignInRequestedDTO>("POST", "/api/auth/email", body, o),
    verifySignIn: (token, o) => request<SignInVerifiedDTO>("POST", "/api/auth/verify", { token }, o),
    signOut: (o) => request<void>("POST", "/api/auth/logout", {}, o),
    attachEmail: (body, o) => request<SignInRequestedDTO>("POST", "/api/me/email", body, o),
    updateMe: (body, o) => request<MeDTO>("PATCH", "/api/me", body, o),
    getDeletionPreview: () => get<DeletionPreviewDTO>("/api/me/deletion-preview"),
    deleteAccount: (body, o) => request<void>("DELETE", "/api/me", body, o),

    async listProjects() {
      const r = await get<{ projects: ProjectSummaryDTO[] } | ProjectSummaryDTO[]>("/api/projects");
      return Array.isArray(r) ? r : r.projects;
    },
    createProject: (body, o) => request<ProjectViewDTO>("POST", "/api/projects", body, o),
    getProject: (id) => get<ProjectViewDTO>(P(id)),
    updateSettings: (id, body, o) => request("PATCH", `${P(id)}/settings`, body, o),
    putRate: (id, cur, body, o) => request("PUT", `${P(id)}/rates/${enc(cur)}`, body, o),
    deleteRate: (id, cur, o) => request("DELETE", `${P(id)}/rates/${enc(cur)}`, undefined, o),

    createInvite: (id, o) => request<InvitationDTO>("POST", `${P(id)}/invitations`, {}, o),
    revokeInvite: (id, inv, o) => request("DELETE", `${P(id)}/invitations/${enc(inv)}`, undefined, o),
    previewInvite: (token) => get<InvitationPreviewDTO>(`/api/invitations/${enc(token)}`),
    join: (body, o) => request<{ projectId: string; memberId?: string }>("POST", "/api/invitations/join", body, o),

    removeMember: (id, m, o) => request("DELETE", `${P(id)}/members/${enc(m)}`, undefined, o),
    leave: (id, o) => request("POST", `${P(id)}/leave`, {}, o),
    transferOwnership: (id, body, o) => request("POST", `${P(id)}/ownership`, body, o),
    acceptOwnership: (id, o) => request("POST", `${P(id)}/ownership/accept`, {}, o),
    renameMe: (id, body, o) => request<MemberDTO>("PATCH", `${P(id)}/members/me`, body, o),
    addMember: (id, body, o) => request<AddMemberResultDTO>("POST", `${P(id)}/members`, body, o),
    renameMember: (id, m, body, o) => request<MemberDTO>("PATCH", `${P(id)}/members/${enc(m)}/name`, body, o),
    inviteMember: (id, m, body, o) => request<AddMemberResultDTO>("POST", `${P(id)}/members/${enc(m)}/invite`, body, o),
    cancelMemberInvite: (id, m, o) => request<MemberDTO>("DELETE", `${P(id)}/members/${enc(m)}/invite`, undefined, o),
    previewMemberInvite: (token) => get<MemberInvitePreviewDTO>(`/api/member-invites/${enc(token)}`),
    acceptMemberInvite: (body, o) => request<JoinResultDTO>("POST", "/api/member-invites/accept", body, o),

    createEntry: (id, r, body, o) => request("POST", `${R(id, r)}/entries`, body, o),
    updateEntry: (id, r, e, body, o) => request("PATCH", `${R(id, r)}/entries/${enc(e)}`, body, o),
    deleteEntry: (id, r, e, body, o) => request("DELETE", `${R(id, r)}/entries/${enc(e)}`, body, o),
    createAdjustment: (id, r, body, o) => request("POST", `${R(id, r)}/adjustments`, body, o),
    uploadAttachment: (id, image, o) => request<AttachmentDTO>("POST", `${P(id)}/attachments`, image, o),
    attachmentUrl: (id, attachmentId) => `${P(id)}/attachments/${enc(attachmentId)}`,

    setReadiness: (id, r, body, o) => request("PUT", `${R(id, r)}/readiness/me`, body, o),
    getReview: (id, r) => get<ReviewDTO>(`${R(id, r)}/review`),
    freeze: (id, r, body, o) => request("POST", `${R(id, r)}/freeze`, body, o),
    setFreezeSchedule: (id, r, body, o) => request<RoundDTO>("PUT", `${R(id, r)}/freeze-schedule`, body, o),
    getRound: (id, r) => get<RoundViewDTO>(R(id, r)),

    markSent: (id, r, i, body, o) => request("POST", `${R(id, r)}/instructions/${enc(i)}/sent`, body, o),
    markReceived: (id, r, i, body, o) => request("POST", `${R(id, r)}/instructions/${enc(i)}/received`, body, o),
    markDisputed: (id, r, i, body, o) => request("POST", `${R(id, r)}/instructions/${enc(i)}/dispute`, body, o),

    startRound: (id, o) => request("POST", `${P(id)}/rounds`, {}, o),
    getHistory: (id) => get<HistoryDTO>(`${P(id)}/history`),
    async exportCsv(id) {
      const res = await once("GET", `${P(id)}/export`, undefined, { Accept: "text/csv" });
      return res.blob();
    },

    live: (id, handlers) =>
      connectLive(`${P(id)}/live`, handlers, {
        WebSocket: opts.WebSocket ?? globalThis.WebSocket,
        location: opts.location ?? globalThis.location,
      }),
  };
}

/** Reconnect delays: 1s, 2s, 4s … capped at 30s, with ±25% jitter. */
export function backoffDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

export function connectLive(
  path: string,
  handlers: LiveHandlers,
  env: { WebSocket: typeof WebSocket; location: { protocol: string; host: string } },
): LiveSubscription {
  const url = `${env.location.protocol === "https:" ? "wss:" : "ws:"}//${env.location.host}${path}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let everOpened = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (closed || timer) return;
    attempt++;
    handlers.onStatus(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "reconnecting");
    timer = setTimeout(() => {
      timer = null;
      open();
    }, backoffDelay(attempt));
  };

  const open = () => {
    if (closed) return;
    handlers.onStatus(everOpened ? "reconnecting" : "connecting");
    try {
      ws = new env.WebSocket(url);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      const reconnected = everOpened;
      everOpened = true;
      attempt = 0;
      handlers.onStatus("open");
      // Anything may have changed while we were away.
      if (reconnected) handlers.onChange("reconnected");
    };
    ws.onmessage = (ev) => {
      let msg: LiveMessage;
      try {
        msg = JSON.parse(String(ev.data)) as LiveMessage;
      } catch {
        return;
      }
      if (msg.type === "changed") handlers.onChange(msg.reason);
    };
    ws.onclose = () => {
      ws = null;
      schedule();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  };

  const onOnline = () => {
    if (closed || ws) return;
    if (timer) clearTimeout(timer);
    timer = null;
    attempt = 0;
    open();
  };
  const onOffline = () => handlers.onStatus("offline");
  globalThis.addEventListener?.("online", onOnline);
  globalThis.addEventListener?.("offline", onOffline);

  open();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      globalThis.removeEventListener?.("online", onOnline);
      globalThis.removeEventListener?.("offline", onOffline);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    },
  };
}
