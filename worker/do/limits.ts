/** Conservative per-project caps. Enforced before mutating (429 LIMIT_EXCEEDED); never truncate a settlement. */
export const LIMITS = {
  /** Non-removed members. */
  members: 50,
  /** All member rows ever (bounds join/remove churn). */
  memberRows: 200,
  /** Entry rows per round, including deleted ones and adjustments. */
  entriesPerRound: 2000,
  rounds: 500,
  invitations: 200,
  rateDefaults: 100,
  /** Uploaded but not yet saved with an entry, per member. */
  pendingAttachmentsPerMember: 20,
  /** Pending and attached photos in the project. */
  attachments: 1000,
} as const;

/** Unattached uploads are purged after this long. */
export const PENDING_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Trash ids handed to the cron per call (R2 deletes up to 1000 keys per call). */
export const ATTACHMENT_TRASH_BATCH = 500;

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Email invitations to a placeholder. */
export const MEMBER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
