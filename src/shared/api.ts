/**
 * Splitdummy HTTP API — CONTRACT shared by worker and web.
 *
 * - All amounts in JSON are decimal-string integer MINOR units ("43000").
 * - Rates are canonical decimal strings with "." ("4.3").
 * - Dates: occurredAt is "YYYY-MM-DD"; timestamps are ISO-8601 UTC strings.
 * - Every mutation requires header `Idempotency-Key: <uuid>` and a same-origin `Origin`.
 * - Errors: HTTP status + body ApiErrorBody. Status map: 401 no session, 403 role,
 *   404 unavailable (never leaks membership), 409 frozen/stale/state, 422 invalid input, 429 limits.
 */
import { z } from "zod";

// ---------- primitives ----------
export const MinorSchema = z.string().regex(/^-?\d{1,16}$/, "Invalid amount");
export const PositiveMinorSchema = z.string().regex(/^[1-9]\d{0,15}$/, "Amount must be positive");
export const RateStringSchema = z.string().regex(/^\d{1,10}(\.\d{1,12})?$/, "Invalid rate");
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Invalid currency code");
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");
export const IdSchema = z.string().min(1).max(64);
export const DisplayNameSchema = z.string().trim().min(1, "Enter a name").max(40);
export const ProjectNameSchema = z.string().trim().min(1, "Enter a group name").max(80);
export const DescriptionSchema = z.string().trim().min(1, "Enter a description").max(140);

export type RoundStatus = "COLLECTING" | "SETTLING" | "SETTLED";
export type InstructionState = "PROPOSED" | "SENT" | "CONFIRMED" | "DISPUTED";
export type EntryType = "EXPENSE" | "REFUND" | "ADJUSTMENT";
export type SplitMode = "EQUAL" | "EXACT";
export type ConversionMethod = "IDENTITY" | "MANUAL_RATE" | "ACTUAL_BASE_AMOUNT";

// ---------- errors ----------
export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "ROUND_NOT_COLLECTING"
  | "ROUND_NOT_SETTLING"
  | "STALE_VERSION"
  | "REVIEW_STALE"
  | "NOT_READY_UNACKNOWLEDGED"
  | "IDEMPOTENCY_CONFLICT"
  | "MULTI_CURRENCY_DISABLED"
  | "FOREIGN_ENTRIES_EXIST"
  | "CURRENCY_LOCKED"
  | "MEMBER_REFERENCED"
  | "INVITE_INVALID"
  | "INVALID_TRANSITION"
  | "RATE_LIMITED"
  | "TURNSTILE_FAILED"
  | "LIMIT_EXCEEDED"
  | "INTERNAL";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string; // user-friendly
    /** Field path for form errors, e.g. "amount", "participants.0.amount". */
    field?: string;
    /** Extra machine data, e.g. { currentReviewVersion: 7 } or { notReady: ["m_1"] }. */
    details?: Record<string, unknown>;
  };
}

// ---------- DTOs (responses) ----------
export interface ConfigDTO {
  /** Turnstile site key; null disables the widget (local dev/tests). */
  turnstileSiteKey: string | null;
  environment: "production" | "staging" | "development" | "test";
}

/** POST /api/auth/email response. devLink is ONLY returned outside production for local testing. */
export interface SignInRequestedDTO {
  sent: true;
  devLink?: string;
}

export interface MeDTO {
  principalId: string;
  kind: "ACCOUNT" | "GUEST";
  email: string | null; // verified email when present
  displayName: string | null;
}

export interface ProjectSummaryDTO {
  id: string;
  name: string;
  baseCurrency: string;
  roundStatus: RoundStatus | null;
  roundSequence: number | null;
  isOwner: boolean;
  /** Personal next action hint computed by directory projection; may lag. */
  nextAction: "ADD_EXPENSES" | "MARK_READY" | "REVIEW_FREEZE" | "SEND_MONEY" | "CONFIRM_RECEIPT" | "WAITING" | "DONE" | null;
  updatedAt: string;
}

export interface MemberDTO {
  id: string;
  displayName: string;
  isOwner: boolean;
  isGuest: boolean;
  hasRecoverableAccount: boolean;
  joinedAt: string;
  status: "ACTIVE" | "LEFT" | "REMOVED";
  /** True when any ledger entry or settlement references this member. */
  referenced: boolean;
}

export interface RoundDTO {
  id: string;
  sequence: number;
  status: RoundStatus;
  ledgerVersion: number;
  reviewVersion: number;
  createdAt: string;
  frozenAt: string | null;
  settledAt: string | null;
  earlyFreezeReason: string | null;
  frozenByMemberId: string | null;
}

export interface AmountSplitDTO {
  memberId: string;
  originalAmount: string; // minor, signed for adjustments
  baseAmount: string;
}

export interface EntryDTO {
  id: string;
  roundId: string;
  type: EntryType;
  creatorMemberId: string;
  lastEditedByMemberId: string | null;
  occurredAt: string;
  description: string;
  originalAmount: string;
  originalCurrency: string;
  originalExponent: number;
  baseAmount: string;
  baseCurrency: string;
  baseExponent: number;
  conversion: {
    method: ConversionMethod;
    rate: string; // stored rate, or derived display rate for ACTUAL_BASE_AMOUNT
    rateSource: "IDENTITY" | "OWNER_DEFAULT" | "ENTRY_OVERRIDE" | "ACTUAL_CHARGE";
    rateSetByMemberId: string | null;
    rateSetAt: string | null;
    note: string | null;
  };
  /** EXPENSE: payer. REFUND: who received the refunded money. ADJUSTMENT: null. */
  payerMemberId: string | null;
  splitMode: SplitMode | null;
  contributions: AmountSplitDTO[];
  allocations: AmountSplitDTO[];
  /** ADJUSTMENT only: signed balanced base effects. */
  adjustmentEffects: AmountSplitDTO[] | null;
  correctedEntryId: string | null;
  correctedRoundId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReadinessDTO {
  memberId: string;
  ready: boolean;
  markedAt: string | null;
}

export interface BalanceDTO {
  memberId: string;
  paid: string;
  share: string;
  adjustments: string;
  net: string; // + receives, - owes
  /** Settling only: confirmed received(+)/sent(-) progress, and remaining = net - progress. */
  confirmedProgress: string | null;
  remaining: string | null;
}

export interface InstructionDTO {
  id: string;
  roundId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: string;
  currency: string;
  exponent: number;
  state: InstructionState;
  sentAt: string | null;
  confirmedAt: string | null;
  disputedAt: string | null;
  disputeNote: string | null;
  revision: number;
}

export interface RateDefaultDTO {
  currency: string; // original currency; pair is currency→baseCurrency
  rate: string;
  setByMemberId: string;
  setAt: string;
  revision: number;
}

export interface ProjectDTO {
  id: string;
  name: string;
  ownerMemberId: string;
  baseCurrency: string;
  baseExponent: number;
  multiCurrencyEnabled: boolean;
  /** True once any ledger entry has ever been committed. */
  baseCurrencyLocked: boolean;
  activeRoundId: string | null;
  version: number;
  createdAt: string;
}

export interface CurrencySubtotalDTO {
  currency: string;
  exponent: number;
  expenses: string; // original minor
  refunds: string;
  baseEquivalent: string; // base minor (expenses - refunds)
}

/** Full view of one round. Used for active round and historical rounds. */
export interface RoundViewDTO {
  round: RoundDTO;
  entries: EntryDTO[]; // excludes deleted
  readiness: ReadinessDTO[];
  balances: BalanceDTO[];
  instructions: InstructionDTO[]; // empty while collecting
  totals: { expenses: string; refunds: string; adjustments: string };
  currencySubtotals: CurrencySubtotalDTO[];
}

/** GET /api/projects/:projectId */
export interface ProjectViewDTO {
  project: ProjectDTO;
  me: { memberId: string; isOwner: boolean };
  members: MemberDTO[];
  rates: RateDefaultDTO[];
  /** Current (latest) round view; the active round or the most recent settled one. */
  current: RoundViewDTO;
  rounds: RoundDTO[]; // all rounds, newest first
  invitations: InvitationDTO[] | null; // owner only
}

/** GET .../rounds/:roundId/review */
export interface ReviewDTO {
  roundId: string;
  reviewVersion: number;
  ledgerVersion: number;
  notReadyMemberIds: string[];
  view: RoundViewDTO;
  /** Provisional plan (not saved). */
  proposedTransfers: { fromMemberId: string; toMemberId: string; amount: string }[];
}

export interface InvitationDTO {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** Only returned once on creation. */
  url?: string;
}

export interface AuditEventDTO {
  id: string;
  at: string;
  actorMemberId: string | null;
  action: string; // e.g. ENTRY_CREATED, ENTRY_UPDATED, READY_SET, ROUND_FROZEN, INSTRUCTION_SENT...
  roundId: string | null;
  entityId: string | null;
  summary: string; // human-readable
  details: Record<string, unknown> | null;
}

/** GET /api/projects/:projectId/history */
export interface HistoryDTO {
  rounds: RoundDTO[];
  events: AuditEventDTO[];
}

/** GET /api/invitations/:token (public preview for the join page; no membership leak beyond name/state). */
export interface InvitationPreviewDTO {
  projectName: string;
  baseCurrency: string;
  status: "OPEN" | "EXPIRED" | "REVOKED" | "MEMBERSHIP_FROZEN";
  alreadyMemberProjectId: string | null;
}

// ---------- requests ----------
export const RequestSignInSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  turnstileToken: z.string().max(4096).optional(),
  /** Where to land after verification (relative path only). */
  next: z.string().regex(/^\/[^/]/).max(200).optional(),
});

export const AttachEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  turnstileToken: z.string().max(4096).optional(),
});

export const CreateProjectSchema = z.object({
  name: ProjectNameSchema,
  baseCurrency: CurrencyCodeSchema,
  multiCurrencyEnabled: z.boolean().default(false),
  ownerDisplayName: DisplayNameSchema,
  turnstileToken: z.string().max(4096).optional(),
});

export const UpdateSettingsSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  name: ProjectNameSchema.optional(),
  multiCurrencyEnabled: z.boolean().optional(),
  baseCurrency: CurrencyCodeSchema.optional(),
});

export const PutRateSchema = z.object({
  rate: RateStringSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const JoinSchema = z.object({
  token: z.string().min(16).max(200),
  displayName: DisplayNameSchema,
  turnstileToken: z.string().max(4096).optional(),
});

export const ConversionRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("IDENTITY") }),
  z.object({ method: z.literal("MANUAL_RATE"), rate: RateStringSchema, note: z.string().max(140).optional() }),
  z.object({ method: z.literal("ACTUAL_BASE_AMOUNT"), baseAmount: PositiveMinorSchema, note: z.string().max(140).optional() }),
]);

export const EntryInputSchema = z.object({
  type: z.enum(["EXPENSE", "REFUND"]),
  description: DescriptionSchema,
  occurredAt: DateSchema,
  originalAmount: PositiveMinorSchema,
  originalCurrency: CurrencyCodeSchema,
  conversion: ConversionRequestSchema,
  /** EXPENSE: payer. REFUND: who received the money. */
  payerMemberId: IdSchema,
  splitMode: z.enum(["EQUAL", "EXACT"]),
  /** EQUAL: amount omitted. EXACT: original minor per member, must sum to originalAmount. */
  participants: z
    .array(z.object({ memberId: IdSchema, amount: MinorSchema.optional() }))
    .min(1, "Pick at least one person")
    .max(100),
});
export type EntryInput = z.infer<typeof EntryInputSchema>;

export const UpdateEntrySchema = EntryInputSchema.extend({
  expectedRevision: z.number().int().positive(),
});

export const DeleteEntrySchema = z.object({
  expectedRevision: z.number().int().positive(),
});

/** Owner-only historical correction, entered in the current collecting round. */
export const AdjustmentInputSchema = z.object({
  correctedEntryId: IdSchema,
  correctedRoundId: IdSchema,
  description: DescriptionSchema,
  occurredAt: DateSchema,
  /** Signed base minor effects; must sum to zero; at least two non-zero. */
  effects: z.array(z.object({ memberId: IdSchema, baseAmount: MinorSchema })).min(2).max(100),
});

export const ReadinessSchema = z.object({ ready: z.boolean() });

export const FreezeSchema = z.object({
  expectedReviewVersion: z.number().int().nonnegative(),
  /** Must list exactly the not-ready member IDs when anyone is not ready. */
  acknowledgeNotReady: z.array(IdSchema).default([]),
  earlyFreezeReason: z.string().trim().max(280).optional(),
});

export const InstructionActionSchema = z.object({
  expectedRevision: z.number().int().positive().optional(),
  note: z.string().trim().max(280).optional(),
});

export const TransferOwnershipSchema = z.object({ toMemberId: IdSchema });

// ---------- endpoints (reference) ----------
export const ENDPOINTS = {
  config: "GET /api/config", // -> ConfigDTO (public)
  me: "GET /api/me", // -> MeDTO | 401
  signIn: "POST /api/auth/email",
  verify: "GET /api/auth/verify?token=", // redirects to `next` after setting cookie
  signOut: "POST /api/auth/logout",
  attachEmail: "POST /api/me/email",
  listProjects: "GET /api/projects",
  createProject: "POST /api/projects", // -> ProjectViewDTO
  getProject: "GET /api/projects/:projectId", // -> ProjectViewDTO
  updateSettings: "PATCH /api/projects/:projectId/settings",
  putRate: "PUT /api/projects/:projectId/rates/:currency",
  deleteRate: "DELETE /api/projects/:projectId/rates/:currency",
  createInvite: "POST /api/projects/:projectId/invitations", // -> InvitationDTO with url
  revokeInvite: "DELETE /api/projects/:projectId/invitations/:inviteId",
  previewInvite: "GET /api/invitations/:token",
  join: "POST /api/invitations/join", // -> { projectId }
  removeMember: "DELETE /api/projects/:projectId/members/:memberId",
  leave: "POST /api/projects/:projectId/leave",
  transferOwnership: "POST /api/projects/:projectId/ownership", // offer
  acceptOwnership: "POST /api/projects/:projectId/ownership/accept",
  createEntry: "POST /api/projects/:projectId/rounds/:roundId/entries",
  updateEntry: "PATCH /api/projects/:projectId/rounds/:roundId/entries/:entryId",
  deleteEntry: "DELETE /api/projects/:projectId/rounds/:roundId/entries/:entryId",
  createAdjustment: "POST /api/projects/:projectId/rounds/:roundId/adjustments",
  readiness: "PUT /api/projects/:projectId/rounds/:roundId/readiness/me",
  review: "GET /api/projects/:projectId/rounds/:roundId/review",
  freeze: "POST /api/projects/:projectId/rounds/:roundId/freeze",
  getRound: "GET /api/projects/:projectId/rounds/:roundId", // -> RoundViewDTO (historical)
  sent: "POST /api/projects/:projectId/rounds/:roundId/instructions/:instructionId/sent",
  received: "POST /api/projects/:projectId/rounds/:roundId/instructions/:instructionId/received",
  dispute: "POST /api/projects/:projectId/rounds/:roundId/instructions/:instructionId/dispute",
  startRound: "POST /api/projects/:projectId/rounds",
  history: "GET /api/projects/:projectId/history",
  export: "GET /api/projects/:projectId/export", // text/csv
  live: "GET /api/projects/:projectId/live", // WebSocket; server pushes LiveMessage
} as const;

/** WebSocket server→client messages. Clients refetch on any `changed`; on reconnect always refetch. */
export type LiveMessage =
  | { type: "hello"; projectVersion: number }
  | { type: "changed"; projectVersion: number; roundId: string | null; reason: string };
