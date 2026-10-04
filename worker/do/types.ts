/**
 * Internal contract between the API Worker (edge) and ProjectDO (authority).
 * Never exposed to browsers. The edge authenticates and passes a Principal;
 * the DO checks membership/role against its own tables.
 */

export interface Principal {
  /** Stable random ID for an account or guest. */
  principalId: string;
  kind: "ACCOUNT" | "GUEST";
  /** Verified email, if any. */
  email: string | null;
  /** ACCOUNT, or GUEST with a verified attached email. Required to accept ownership. */
  hasRecoverableAccount: boolean;
}

export type DoOp =
  | "createProject" // body: CreateProjectSchema (minus turnstileToken) + { projectId }
  | "getProject"
  | "updateSettings"
  | "putRate"
  | "deleteRate"
  | "createInvite"
  | "revokeInvite"
  | "previewInvite" // principal may be null; params.tokenSecret
  | "join" // params.tokenSecret, body: { displayName }
  | "removeMember"
  | "leave"
  | "transferOwnership"
  | "acceptOwnership"
  | "createEntry"
  | "updateEntry"
  | "deleteEntry"
  | "createAdjustment"
  | "setReadiness"
  | "getReview"
  | "freeze"
  | "getRound"
  | "markSent"
  | "markReceived"
  | "markDisputed"
  | "startRound"
  | "getHistory"
  | "exportCsv" // returns body as CSV string with content-type header
  | "renameMe" // body: RenameMemberSchema
  | "setFreezeSchedule" // body: FreezeScheduleSchema
  | "accountDeletionInfo" // internal (edge, no idempotency): principal = the deleting account → { role: "OWNER"|"MEMBER"|"NONE", name, memberCount, hasOpenTransfers }
  | "deleteProject" // internal: principal must be owner → { memberPrincipalIds: string[] }, then wipes all DO storage (deleteAll) and alarms
  | "anonymizeMember" // internal: principal = deleting account → marks member accountDeleted, displayName "Deleted account", status LEFT if collecting; audited MEMBER_ACCOUNT_DELETED
  | "backupSnapshot" // internal (principal null, edge cron only): full JSON dump of all tables for R2
  | "principalUpdated"; // edge notifies that a principal attached a verified email; body: Principal

export interface DoRequest {
  op: DoOp;
  principal: Principal | null;
  /** Path params: projectId, roundId, entryId, instructionId, inviteId, memberId, currency, tokenSecret. */
  params: Record<string, string>;
  body: unknown;
  /** Required for mutations; DO stores (principal, op, key, requestHash) → committed response. */
  idempotencyKey: string | null;
  requestId: string;
}

export interface DoResponse {
  status: number;
  /** JSON-serializable body (ApiErrorBody on error), or a string for CSV. */
  body: unknown;
  headers?: Record<string, string>;
}

/** RPC surface of ProjectDO (extends DurableObject). */
export interface ProjectDORpc {
  handle(req: DoRequest): Promise<DoResponse>;
}

/**
 * WebSocket: the edge forwards the upgrade Request to `stub.fetch()` with header
 * `X-Splitdummy-Principal: <JSON Principal>` (set by the edge only; the edge strips any
 * client-supplied value). The DO accepts with hibernation and broadcasts LiveMessage.
 */
export const PRINCIPAL_HEADER = "X-Splitdummy-Principal";

/**
 * Invitation token format: `${projectId}.${secret}` where secret is 32 random bytes base64url.
 * The edge routes by projectId; the DO stores only SHA-256(secret) and validates.
 */

/** Outbox → Queue message envelope (consumer dedups by id; projections apply by increasing version). */
export type OutboxMessage =
  | {
      id: string;
      type: "DIRECTORY_UPSERT";
      projectId: string;
      projectVersion: number;
      payload: {
        name: string;
        baseCurrency: string;
        roundStatus: "COLLECTING" | "SETTLING" | "SETTLED" | null;
        roundSequence: number | null;
        members: {
          principalId: string;
          memberId: string;
          isOwner: boolean;
          status: "ACTIVE" | "LEFT" | "REMOVED";
          nextAction: string | null;
        }[];
      };
    }
  | {
      id: string;
      type: "NOTIFY";
      projectId: string;
      projectVersion: number;
      payload: {
        kind: "ROUND_FROZEN" | "TRANSFER_SENT" | "TRANSFER_CONFIRMED" | "TRANSFER_DISPUTED" | "ROUND_SETTLED";
        principalIds: string[];
        summary: string;
      };
    };
