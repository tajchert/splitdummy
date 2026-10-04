/**
 * ProjectDO SQLite schema. One Durable Object holds exactly one project.
 * Money columns are TEXT decimal integers (minor units) so values never pass through JS numbers.
 * Migrations are append-only; `meta.schema_version` records how many have been applied.
 */

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE project (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_member_id TEXT NOT NULL,
    pending_owner_member_id TEXT,
    base_currency TEXT NOT NULL,
    base_exponent INTEGER NOT NULL,
    multi_currency_enabled INTEGER NOT NULL,
    base_currency_locked INTEGER NOT NULL DEFAULT 0,
    active_round_id TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    is_guest INTEGER NOT NULL,
    has_recoverable_account INTEGER NOT NULL,
    joined_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','LEFT','REMOVED')),
    status_changed_at TEXT
  );

  CREATE TABLE rounds (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('COLLECTING','SETTLING','SETTLED')),
    ledger_version INTEGER NOT NULL,
    review_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    frozen_at TEXT,
    settled_at TEXT,
    early_freeze_reason TEXT,
    frozen_by_member_id TEXT
  );

  CREATE TABLE readiness (
    round_id TEXT NOT NULL REFERENCES rounds(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    ready INTEGER NOT NULL,
    marked_at TEXT,
    PRIMARY KEY (round_id, member_id)
  );

  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES rounds(id),
    type TEXT NOT NULL CHECK (type IN ('EXPENSE','REFUND','ADJUSTMENT')),
    creator_member_id TEXT NOT NULL REFERENCES members(id),
    last_edited_by_member_id TEXT,
    occurred_at TEXT NOT NULL,
    description TEXT NOT NULL,
    original_amount TEXT NOT NULL,
    original_currency TEXT NOT NULL,
    original_exponent INTEGER NOT NULL,
    base_amount TEXT NOT NULL,
    base_currency TEXT NOT NULL,
    base_exponent INTEGER NOT NULL,
    conversion_method TEXT NOT NULL CHECK (conversion_method IN ('IDENTITY','MANUAL_RATE','ACTUAL_BASE_AMOUNT')),
    rate TEXT NOT NULL,
    rate_source TEXT NOT NULL CHECK (rate_source IN ('IDENTITY','OWNER_DEFAULT','ENTRY_OVERRIDE','ACTUAL_CHARGE')),
    rate_set_by_member_id TEXT,
    rate_set_at TEXT,
    conversion_note TEXT,
    payer_member_id TEXT,
    split_mode TEXT,
    corrected_entry_id TEXT,
    corrected_round_id TEXT,
    revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    deleted_by_member_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX entries_round ON entries(round_id, deleted);

  CREATE TABLE contributions (
    entry_id TEXT NOT NULL REFERENCES entries(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    original_amount TEXT NOT NULL,
    base_amount TEXT NOT NULL,
    PRIMARY KEY (entry_id, member_id)
  );
  CREATE TABLE allocations (
    entry_id TEXT NOT NULL REFERENCES entries(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    original_amount TEXT NOT NULL,
    base_amount TEXT NOT NULL,
    PRIMARY KEY (entry_id, member_id)
  );
  CREATE TABLE adjustment_effects (
    entry_id TEXT NOT NULL REFERENCES entries(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    base_amount TEXT NOT NULL,
    PRIMARY KEY (entry_id, member_id)
  );

  CREATE TABLE rate_defaults (
    currency TEXT PRIMARY KEY,
    rate TEXT NOT NULL,
    set_by_member_id TEXT NOT NULL,
    set_at TEXT NOT NULL,
    revision INTEGER NOT NULL
  );

  CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,
    created_by_member_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE TABLE settlement_snapshots (
    round_id TEXT PRIMARY KEY REFERENCES rounds(id),
    ledger_version INTEGER NOT NULL,
    review_version INTEGER NOT NULL,
    cutoff_at TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  );

  CREATE TABLE instructions (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES rounds(id),
    position INTEGER NOT NULL,
    from_member_id TEXT NOT NULL REFERENCES members(id),
    to_member_id TEXT NOT NULL REFERENCES members(id),
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    exponent INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PROPOSED','SENT','CONFIRMED','DISPUTED')),
    sent_at TEXT,
    confirmed_at TEXT,
    disputed_at TEXT,
    dispute_note TEXT,
    revision INTEGER NOT NULL,
    UNIQUE (round_id, position)
  );

  CREATE TABLE confirmed_transfers (
    id TEXT PRIMARY KEY,
    instruction_id TEXT NOT NULL UNIQUE REFERENCES instructions(id),
    round_id TEXT NOT NULL REFERENCES rounds(id),
    from_member_id TEXT NOT NULL,
    to_member_id TEXT NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    sent_at TEXT,
    confirmed_at TEXT NOT NULL,
    confirmed_by_member_id TEXT NOT NULL
  );

  CREATE TABLE audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL,
    actor_member_id TEXT,
    action TEXT NOT NULL,
    round_id TEXT,
    entity_id TEXT,
    entity_revision INTEGER,
    summary TEXT NOT NULL,
    details_json TEXT
  );

  CREATE TABLE idempotency (
    principal_id TEXT NOT NULL,
    op TEXT NOT NULL,
    key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (principal_id, op, key)
  );

  CREATE TABLE outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_version INTEGER NOT NULL,
    type TEXT NOT NULL,
    message_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT
  );
  CREATE INDEX outbox_pending ON outbox(sent_at, next_attempt_at);
  `,
  `
  ALTER TABLE members ADD COLUMN account_deleted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rounds ADD COLUMN scheduled_freeze_date TEXT;
  ALTER TABLE rounds ADD COLUMN scheduled_freeze_time_zone TEXT;
  ALTER TABLE rounds ADD COLUMN scheduled_freeze_at TEXT;
  ALTER TABLE rounds ADD COLUMN frozen_by_schedule INTEGER NOT NULL DEFAULT 0;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(sql: SqlStorage): void {
  const hasMeta = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  let applied = 0;
  if (hasMeta) {
    const row = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
    applied = row ? Number(row.value) : 0;
  }
  for (let i = applied; i < MIGRATIONS.length; i++) {
    sql.exec(MIGRATIONS[i]!);
    sql.exec(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(i + 1),
    );
  }
}
