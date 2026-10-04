import type { z } from "zod";
import type {
  AdjustmentInputSchema,
  AttachEmailSchema,
  ConfigDTO,
  CreateProjectSchema,
  DeleteEntrySchema,
  EntryInput,
  FreezeSchema,
  HistoryDTO,
  InstructionActionSchema,
  InvitationDTO,
  InvitationPreviewDTO,
  JoinSchema,
  MeDTO,
  ProjectSummaryDTO,
  ProjectViewDTO,
  PutRateSchema,
  ReadinessSchema,
  RequestSignInSchema,
  ReviewDTO,
  RoundViewDTO,
  SignInRequestedDTO,
  TransferOwnershipSchema,
  UpdateEntrySchema,
  UpdateSettingsSchema,
} from "@shared/api";

export type RequestSignInBody = z.input<typeof RequestSignInSchema>;
export type AttachEmailBody = z.input<typeof AttachEmailSchema>;
export type CreateProjectBody = z.input<typeof CreateProjectSchema>;
export type UpdateSettingsBody = z.input<typeof UpdateSettingsSchema>;
export type PutRateBody = z.input<typeof PutRateSchema>;
/** turnstileToken is sent additively; the edge validates it on join. */
export type JoinBody = z.input<typeof JoinSchema> & { turnstileToken?: string };
export type EntryBody = EntryInput;
export type UpdateEntryBody = z.input<typeof UpdateEntrySchema>;
export type DeleteEntryBody = z.input<typeof DeleteEntrySchema>;
export type AdjustmentBody = z.input<typeof AdjustmentInputSchema>;
export type ReadinessBody = z.input<typeof ReadinessSchema>;
export type FreezeBody = z.input<typeof FreezeSchema>;
export type InstructionActionBody = z.input<typeof InstructionActionSchema>;
export type TransferOwnershipBody = z.input<typeof TransferOwnershipSchema>;

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
  requestSignIn(body: RequestSignInBody, o: MutationOptions): Promise<SignInRequestedDTO>;
  signOut(o: MutationOptions): Promise<void>;
  attachEmail(body: AttachEmailBody, o: MutationOptions): Promise<SignInRequestedDTO>;

  listProjects(): Promise<ProjectSummaryDTO[]>;
  createProject(body: CreateProjectBody, o: MutationOptions): Promise<ProjectViewDTO>;
  getProject(projectId: string): Promise<ProjectViewDTO>;
  updateSettings(projectId: string, body: UpdateSettingsBody, o: MutationOptions): Promise<void>;
  putRate(projectId: string, currency: string, body: PutRateBody, o: MutationOptions): Promise<void>;
  deleteRate(projectId: string, currency: string, o: MutationOptions): Promise<void>;

  createInvite(projectId: string, o: MutationOptions): Promise<InvitationDTO>;
  revokeInvite(projectId: string, inviteId: string, o: MutationOptions): Promise<void>;
  previewInvite(token: string): Promise<InvitationPreviewDTO>;
  join(body: JoinBody, o: MutationOptions): Promise<{ projectId: string }>;

  removeMember(projectId: string, memberId: string, o: MutationOptions): Promise<void>;
  leave(projectId: string, o: MutationOptions): Promise<void>;
  transferOwnership(projectId: string, body: TransferOwnershipBody, o: MutationOptions): Promise<void>;
  acceptOwnership(projectId: string, o: MutationOptions): Promise<void>;

  createEntry(projectId: string, roundId: string, body: EntryBody, o: MutationOptions): Promise<void>;
  updateEntry(projectId: string, roundId: string, entryId: string, body: UpdateEntryBody, o: MutationOptions): Promise<void>;
  deleteEntry(projectId: string, roundId: string, entryId: string, body: DeleteEntryBody, o: MutationOptions): Promise<void>;
  createAdjustment(projectId: string, roundId: string, body: AdjustmentBody, o: MutationOptions): Promise<void>;

  setReadiness(projectId: string, roundId: string, body: ReadinessBody, o: MutationOptions): Promise<void>;
  getReview(projectId: string, roundId: string): Promise<ReviewDTO>;
  freeze(projectId: string, roundId: string, body: FreezeBody, o: MutationOptions): Promise<void>;
  getRound(projectId: string, roundId: string): Promise<RoundViewDTO>;

  markSent(projectId: string, roundId: string, instructionId: string, body: InstructionActionBody, o: MutationOptions): Promise<void>;
  markReceived(projectId: string, roundId: string, instructionId: string, body: InstructionActionBody, o: MutationOptions): Promise<void>;
  markDisputed(projectId: string, roundId: string, instructionId: string, body: InstructionActionBody, o: MutationOptions): Promise<void>;

  startRound(projectId: string, o: MutationOptions): Promise<void>;
  getHistory(projectId: string): Promise<HistoryDTO>;
  exportCsv(projectId: string): Promise<Blob>;

  live(projectId: string, handlers: LiveHandlers): LiveSubscription;
}
