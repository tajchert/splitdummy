-- Identity and project directory. D1 is a directory, never accounting authority:
-- ProjectDO checks membership on every request; project_directory only drives "My groups".
-- Timestamps are epoch milliseconds unless noted.

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ACCOUNT', 'GUEST')),
  email TEXT UNIQUE,
  -- Last display name used when creating/joining; only a form prefill hint.
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Raw session tokens live only in the cookie; we store SHA-256 hex.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_principal ON sessions(principal_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- Magic-link tokens: hashed, single-use (consumed_at set atomically), short-lived.
CREATE TABLE sign_in_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('SIGN_IN', 'ATTACH')),
  -- The un-emailed guest that requested the link (upgrade target), if any.
  principal_id TEXT REFERENCES principals(id) ON DELETE CASCADE,
  next TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX sign_in_tokens_expires ON sign_in_tokens(expires_at);

CREATE TABLE project_directory (
  principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'LEFT', 'REMOVED')),
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  round_status TEXT CHECK (round_status IN ('COLLECTING', 'SETTLING', 'SETTLED')),
  round_sequence INTEGER,
  next_action TEXT,
  project_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL, -- ISO-8601
  PRIMARY KEY (principal_id, project_id)
);
CREATE INDEX project_directory_project ON project_directory(project_id);
CREATE INDEX project_directory_principal_updated ON project_directory(principal_id, updated_at);

-- Queue consumer dedupe (outbox event IDs, plus per-recipient notification keys).
CREATE TABLE processed_events (
  id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
CREATE INDEX processed_events_at ON processed_events(processed_at);
