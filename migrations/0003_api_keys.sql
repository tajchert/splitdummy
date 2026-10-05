-- Personal access keys: secrets are shown once and only SHA-256 hashes are stored.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('READ', 'WRITE')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX api_keys_principal ON api_keys(principal_id);
