/**
 * Splitdummy HTTP API — CONTRACT shared by worker and web.
 *
 * - All amounts in JSON are decimal-string integer MINOR units ("43000").
 * - Rates are canonical decimal strings with "." ("4.3").
 * - Dates: occurredAt is "YYYY-MM-DD"; timestamps are ISO-8601 UTC strings.
 * - Group mutations require `Idempotency-Key: <uuid>`; cookie mutations require same-origin `Origin`.
 * - Public API clients use `Authorization: Bearer <API key>` instead of cookies/Origin.
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
  | "ACCOUNT_HAS_OPEN_TRANSFERS"
  | "RATE_LIMITED"
  | "TURNSTILE_FAILED"
  | "LIMIT_EXCEEDED"
  | "INTERNAL"
  | "SIGNIN_LINK_INVALID"
  /** Joining by link needs a signed-in account with a verified email. */
  | "EMAIL_REQUIRED"
  /** Accepting an email invite while already in the group under another identity. */
  | "ALREADY_MEMBER";

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

/** POST /api/auth/email response. devLink is ONLY returned in development/test (never staging/production). */
export interface SignInRequestedDTO {
  sent: true;
  /** `${origin}/auth/confirm#token=…` — same link the email contains. */
  devLink?: string;
}

/**
 * POST /api/auth/verify response: session cookie is set; navigate to `next` (relative path).
 * When attaching an email that already belongs to another account, the session is unchanged and
 * `next` carries `?error=email_in_use`.
 */
export interface SignInVerifiedDTO {
  next: string;
}

export interface MeDTO {
  principalId: string;
  kind: "ACCOUNT" | "GUEST";
  email: string | null; // verified email when present
  displayName: string | null;
}

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1, "Enter a key name").max(80),
  scope: z.enum(["READ", "WRITE"]).default("READ"),
});
export interface ApiKeyDTO {
  id: string;
  name: string;
  prefix: string;
  scope: "READ" | "WRITE";
  createdAt: string;
  expiresAt: string;
}
/** The secret is returned only by creation. It cannot be retrieved later. */
export interface CreatedApiKeyDTO extends ApiKeyDTO { token: string }

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
  /** The member's account was deleted; displayName is then a neutral placeholder ("Deleted account"). */
  accountDeleted: boolean;
  /** PLACEHOLDER: added by the owner by name; no account until someone claims it through an email invite. */
  kind: "PERSON" | "PLACEHOLDER";
  /** Placeholders with an email invite: INVITED until it expires, then INVITE_EXPIRED. */
  inviteState: "INVITED" | "INVITE_EXPIRED" | null;
  inviteExpiresAt: string | null;
  /** Owner view only (absent for everyone else). */
  invitedEmail?: string | null;
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
  /** Owner-scheduled freeze (COLLECTING only). Date as picked + IANA zone; freezes at the END of that day in that zone. */
  scheduledFreezeDate: string | null;
  scheduledFreezeTimeZone: string | null;
  /** ISO instant when the scheduled freeze fires (start of the next day in scheduledFreezeTimeZone). */
  scheduledFreezeAt: string | null;
  /** True when this round was frozen automatically by the schedule. */
  frozenBySchedule: boolean;
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
  /** When false only the owner changes display names (renameMe is 403 for others). */
  membersCanRename: boolean;
  /** True once any ledger entry has ever been committed. */
  baseCurrencyLocked: boolean;
  activeRoundId: string | null;
  /** Member offered ownership (pending acceptance), if any. */
  pendingOwnerMemberId?: string | null;
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
  next: z.string().regex(/^\/[^/]/).max(500).optional(),
});

/** POST /api/auth/verify body; the token comes from the /auth/confirm#token=… fragment. */
export const VerifySignInSchema = z.object({
  token: z.string().min(1).max(200),
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
  membersCanRename: z.boolean().optional(),
  baseCurrency: CurrencyCodeSchema.optional(),
});

export const PutRateSchema = z.object({
  rate: RateStringSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const JoinSchema = z.object({
  token: z.string().min(16).max(200),
  displayName: DisplayNameSchema,
  /** Accepted for compatibility and ignored: joining requires a signed-in verified email instead. */
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

/** PATCH /api/me → MeDTO. Account-level default name (prefills new groups). null clears it. */
export const UpdateMeSchema = z.object({ displayName: DisplayNameSchema.nullable() });

/** PATCH /api/projects/:projectId/members/me → MemberDTO. Own name inside one group; audited as MEMBER_RENAMED. */
export const RenameMemberSchema = z.object({ displayName: DisplayNameSchema });

/**
 * PUT /api/projects/:projectId/rounds/:roundId/freeze-schedule → RoundDTO. Owner only, COLLECTING only.
 * date null clears. date must be today or later in timeZone. Audited FREEZE_SCHEDULED / FREEZE_SCHEDULE_CLEARED.
 * When the instant passes, the DO freezes the round exactly like an owner freeze (not-ready members are recorded,
 * earlyFreezeReason "Scheduled freeze date reached" when anyone wasn't ready), with frozenBySchedule = true.
 */
export const FreezeScheduleSchema = z.object({
  date: DateSchema.nullable(),
  timeZone: z.string().min(1).max(64),
});

/** DELETE /api/me → OkDTO (clears session cookie). Body must confirm. 409 ACCOUNT_HAS_OPEN_TRANSFERS when blocked. */
export const DeleteAccountSchema = z.object({ confirm: z.literal("DELETE") });

/** GET /api/me/deletion-preview */
export interface DeletionPreviewDTO {
  /** Groups you own — deleted entirely, for every member. */
  ownedProjects: { id: string; name: string; memberCount: number }[];
  /** Groups you joined — kept; your name there becomes "Deleted account". */
  memberProjects: { id: string; name: string }[];
  /** Joined groups where you still have unconfirmed transfers (as sender or recipient); deletion is blocked until they are confirmed. */
  blockingProjects: { id: string; name: string }[];
}

export const TransferOwnershipSchema = z.object({ toMemberId: IdSchema });

const InviteEmailSchema = z.string().trim().toLowerCase().email("Enter an email address like name@example.com").max(254);

/** POST /api/projects/:projectId/members → 201 AddMemberResultDTO. Owner only; email sends a 7-day invite. */
export const AddMemberSchema = z.object({ displayName: DisplayNameSchema, email: InviteEmailSchema.optional() });
/** POST /api/projects/:projectId/members/:memberId/invite → AddMemberResultDTO. Attach an email or resend (new link). */
export const InviteMemberSchema = z.object({ email: InviteEmailSchema });
/** POST /api/member-invites/accept → JoinResultDTO + session cookie for the invited email's account. */
export const AcceptMemberInviteSchema = z.object({
  token: z.string().min(16).max(200),
  displayName: DisplayNameSchema.optional(),
});

/** GET /api/member-invites/:token (public; never includes the invited email). */
export interface MemberInvitePreviewDTO {
  projectName: string;
  baseCurrency: string;
  /** The placeholder's current name. */
  displayName: string;
  status: "OPEN" | "EXPIRED" | "CLAIMED";
  /** Whether the invitee may change the name while accepting. */
  canRename: boolean;
  alreadyMemberProjectId: string | null;
}

export interface AddMemberResultDTO extends MemberDTO {
  /** null when no email was involved or this was a replay; false when sending failed (owner can resend). */
  emailSent: boolean | null;
  /** Local dev only: the invite link, since there may be no inbox. */
  devLink?: string;
}

// ---------- endpoints (reference) ----------
export const ENDPOINTS = {
  config: "GET /api/config", // -> ConfigDTO (public)
  me: "GET /api/me", // -> MeDTO | 401
  signIn: "POST /api/auth/email",
  verify: "GET /api/auth/verify?token=", // legacy links: 303 → /auth/confirm#token=… (consumes nothing)
  verifySignIn: "POST /api/auth/verify", // { token } -> SignInVerifiedDTO + session cookie; 410 SIGNIN_LINK_INVALID
  signOut: "POST /api/auth/logout",
  attachEmail: "POST /api/me/email",
  updateMe: "PATCH /api/me", // -> MeDTO
  deletionPreview: "GET /api/me/deletion-preview", // -> DeletionPreviewDTO
  deleteAccount: "DELETE /api/me", // -> OkDTO
  renameMe: "PATCH /api/projects/:projectId/members/me", // -> MemberDTO
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
  addMember: "POST /api/projects/:projectId/members", // -> 201 AddMemberResultDTO
  renameMember: "PATCH /api/projects/:projectId/members/:memberId/name", // -> MemberDTO (owner)
  inviteMember: "POST /api/projects/:projectId/members/:memberId/invite", // -> AddMemberResultDTO
  cancelMemberInvite: "DELETE /api/projects/:projectId/members/:memberId/invite", // -> MemberDTO
  previewMemberInvite: "GET /api/member-invites/:token", // -> MemberInvitePreviewDTO
  acceptMemberInvite: "POST /api/member-invites/accept", // -> JoinResultDTO
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
  freezeSchedule: "PUT /api/projects/:projectId/rounds/:roundId/freeze-schedule", // -> RoundDTO
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

// ---------- mutation responses ----------
// createProject → 201 ProjectViewDTO · getProject → ProjectViewDTO · getRound → RoundViewDTO
// getReview → ReviewDTO · getHistory → HistoryDTO · previewInvite → InvitationPreviewDTO
// updateSettings / transferOwnership / acceptOwnership → ProjectDTO
// putRate → RateDefaultDTO · deleteRate → OkDTO
// createInvite → 201 InvitationDTO (url = `${APP_ORIGIN}/join#${projectId}.${secret}` — token in the
//   fragment so it never reaches server logs; the join page reads location.hash) · revokeInvite → InvitationDTO
// join → JoinResultDTO · removeMember / leave → MemberDTO
// createEntry / createAdjustment → 201 EntryDTO · updateEntry → EntryDTO · deleteEntry → OkDTO
// setReadiness → ReadinessDTO · freeze → FreezeResultDTO
// markSent / markReceived / markDisputed → InstructionResultDTO (round.status shows SETTLED completion)
// startRound → 201 RoundDTO · export → text/csv with content-disposition
export interface OkDTO {
  ok: true;
}
export interface JoinResultDTO {
  projectId: string;
  memberId: string;
}
export interface FreezeResultDTO {
  round: RoundDTO;
  instructions: InstructionDTO[];
}
export interface InstructionResultDTO {
  instruction: InstructionDTO;
  round: RoundDTO;
}
