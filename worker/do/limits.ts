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
} as const;

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
