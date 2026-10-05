import type { z } from "zod";
import type {
  AcceptMemberInviteSchema,
  AddMemberResultDTO,
  AddMemberSchema,
  AdjustmentInputSchema,
  ApiKeyDTO,
  CreatedApiKeyDTO,
  CreateApiKeySchema,
  AttachEmailSchema,
  ConfigDTO,
  CreateProjectSchema,
  DeleteAccountSchema,
  DeleteEntrySchema,
  DeletionPreviewDTO,
  EntryInput,
  FreezeScheduleSchema,
  FreezeSchema,
  HistoryDTO,
  InstructionActionSchema,
  InvitationDTO,
  InvitationPreviewDTO,
  InviteMemberSchema,
  JoinResultDTO,
  JoinSchema,
  MeDTO,
  MemberDTO,
  MemberInvitePreviewDTO,
  ProjectSummaryDTO,
  ProjectViewDTO,
  PutRateSchema,
  ReadinessSchema,
  RenameMemberSchema,
  RequestSignInSchema,
  ReviewDTO,
  RoundDTO,
  RoundViewDTO,
  SignInRequestedDTO,
  SignInVerifiedDTO,
  TransferOwnershipSchema,
  UpdateEntrySchema,
  UpdateMeSchema,
  UpdateSettingsSchema,
} from "@shared/api";

export type RequestSignInBody = z.input<typeof RequestSignInSchema>;
export type AttachEmailBody = z.input<typeof AttachEmailSchema>;
export type CreateProjectBody = z.input<typeof CreateProjectSchema>;
export type UpdateSettingsBody = z.input<typeof UpdateSettingsSchema>;
export type PutRateBody = z.input<typeof PutRateSchema>;
export type JoinBody = z.input<typeof JoinSchema>;
export type EntryBody = EntryInput;
export type UpdateEntryBody = z.input<typeof UpdateEntrySchema>;
export type DeleteEntryBody = z.input<typeof DeleteEntrySchema>;
export type AdjustmentBody = z.input<typeof AdjustmentInputSchema>;
export type ReadinessBody = z.input<typeof ReadinessSchema>;
export type FreezeBody = z.input<typeof FreezeSchema>;
export type InstructionActionBody = z.input<typeof InstructionActionSchema>;
export type TransferOwnershipBody = z.input<typeof TransferOwnershipSchema>;
export type UpdateMeBody = z.input<typeof UpdateMeSchema>;
export type RenameMemberBody = z.input<typeof RenameMemberSchema>;
export type FreezeScheduleBody = z.input<typeof FreezeScheduleSchema>;
export type DeleteAccountBody = z.input<typeof DeleteAccountSchema>;
export type AddMemberBody = z.input<typeof AddMemberSchema>;
export type InviteMemberBody = z.input<typeof InviteMemberSchema>;
export type AcceptMemberInviteBody = z.input<typeof AcceptMemberInviteSchema>;

/** Every mutation carries the key of its logical submit; retries of that submit reuse it. */
export interface MutationOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

export type LiveStatus = "connecting" | "open" | "reconnecting" | "offline";

export interface LiveHandlers {
  /** Server reported a change, or the socket reconnected: refetch. */
  onChange: (reason: string) => void;
  onStatus: (status: LiveStatus) => void;
}

export interface LiveSubscription {
  close(): void;
}

/** The single client surface; the HTTP client and the mock both implement it. */
export interface Api {
  getConfig(): Promise<ConfigDTO>;
  /** null when there is no session (401). */
  getMe(): Promise<MeDTO | null>;
  listApiKeys(): Promise<ApiKeyDTO[]>;
  /** Single attempt: the secret is shown once and creation must not be auto-retried. */
  createApiKey(body: z.input<typeof CreateApiKeySchema>): Promise<CreatedApiKeyDTO>;
  revokeApiKey(id: string): Promise<void>;
  requestSignIn(body: RequestSignInBody, o: MutationOptions): Promise<SignInRequestedDTO>;
  /** Exchange the /auth/confirm#token=… fragment for a session; resolves with where to go next. */
  verifySignIn(token: string, o: MutationOptions): Promise<SignInVerifiedDTO>;
  signOut(o: MutationOptions): Promise<void>;
  attachEmail(body: AttachEmailBody, o: MutationOptions): Promise<SignInRequestedDTO>;
  /** Account-level default name; null clears it. */
  updateMe(body: UpdateMeBody, o: MutationOptions): Promise<MeDTO>;
  getDeletionPreview(): Promise<DeletionPreviewDTO>;
  /** 409 ACCOUNT_HAS_OPEN_TRANSFERS while any joined group has collecting expense references or unconfirmed transfers. Clears the session. */
  deleteAccount(body: DeleteAccountBody, o: MutationOptions): Promise<void>;

  listProjects(): Promise<ProjectSummaryDTO[]>;
  createProject(body: CreateProjectBody, o: MutationOptions): Promise<ProjectViewDTO>;
  getProject(projectId: string): Promise<ProjectViewDTO>;
  updateSettings(projectId: string, body: UpdateSettingsBody, o: MutationOptions): Promise<void>;
  putRate(projectId: string, currency: string, body: PutRateBody, o: MutationOptions): Promise<void>;
  deleteRate(projectId: string, currency: string, o: MutationOptions): Promise<void>;

  createInvite(projectId: string, o: MutationOptions): Promise<InvitationDTO>;
  revokeInvite(projectId: string, inviteId: string, o: MutationOptions): Promise<void>;
  previewInvite(token: string): Promise<InvitationPreviewDTO>;
  join(body: JoinBody, o: MutationOptions): Promise<{ projectId: string; memberId?: string }>;

  removeMember(projectId: string, memberId: string, o: MutationOptions): Promise<void>;
  leave(projectId: string, o: MutationOptions): Promise<void>;
  transferOwnership(projectId: string, body: TransferOwnershipBody, o: MutationOptions): Promise<void>;
  acceptOwnership(projectId: string, o: MutationOptions): Promise<void>;
  /** Your own display name in this group. */
  renameMe(projectId: string, body: RenameMemberBody, o: MutationOptions): Promise<MemberDTO>;
  /** Owner: add someone by name; with an email they get a 7-day invitation to claim the spot. */
  addMember(projectId: string, body: AddMemberBody, o: MutationOptions): Promise<AddMemberResultDTO>;
  renameMember(projectId: string, memberId: string, body: RenameMemberBody, o: MutationOptions): Promise<MemberDTO>;
  /** Owner: email (or re-email) a placeholder; the earlier link stops working. */
  inviteMember(projectId: string, memberId: string, body: InviteMemberBody, o: MutationOptions): Promise<AddMemberResultDTO>;
  cancelMemberInvite(projectId: string, memberId: string, o: MutationOptions): Promise<MemberDTO>;
  previewMemberInvite(token: string): Promise<MemberInvitePreviewDTO>;
  /** Signs this browser in as the invited email's account and claims the placeholder. */
  acceptMemberInvite(body: AcceptMemberInviteBody, o: MutationOptions): Promise<JoinResultDTO>;

  createEntry(projectId: string, roundId: string, body: EntryBody, o: MutationOptions): Promise<void>;
  updateEntry(projectId: string, roundId: string, entryId: string, body: UpdateEntryBody, o: MutationOptions): Promise<void>;
  deleteEntry(projectId: string, roundId: string, entryId: string, body: DeleteEntryBody, o: MutationOptions): Promise<void>;
  createAdjustment(projectId: string, roundId: string, body: AdjustmentBody, o: MutationOptions): Promise<void>;

  setReadiness(projectId: string, roundId: string, body: ReadinessBody, o: MutationOptions): Promise<void>;
  getReview(projectId: string, roundId: string): Promise<ReviewDTO>;
  freeze(projectId: string, roundId: string, body: FreezeBody, o: MutationOptions): Promise<void>;
  /** Owner sets (date) or clears (null) the automatic freeze date of the collecting round. */
  setFreezeSchedule(projectId: string, roundId: string, body: FreezeScheduleBody, o: MutationOptions): Promise<RoundDTO>;
  getRound(projectId: string, roundId: string): Promise<RoundViewDTO>;

  markSent(projectId: string, roundId: string, instructionId: string, body: InstructionActionBody, o: MutationOptions): Promise<void>;
  markReceived(projectId: string, roundId: string, instructionId: string, body: InstructionActionBody, o: MutationOptions): Promise<void>;
  markDisputed(projectId: string, roundId: string, instructionId: string, body: InstructionActionBody, o: MutationOptions): Promise<void>;

  startRound(projectId: string, o: MutationOptions): Promise<void>;
  getHistory(projectId: string): Promise<HistoryDTO>;
  exportCsv(projectId: string): Promise<Blob>;

  live(projectId: string, handlers: LiveHandlers): LiveSubscription;
}
