-- Deleted accounts and deleted projects. Outbox delivery is at-least-once and unordered, so a
-- DIRECTORY_UPSERT published before a deletion can arrive after it; directory upserts skip any
-- principal or project listed here. Holds only opaque IDs.
CREATE TABLE directory_tombstones (
  kind TEXT NOT NULL CHECK (kind IN ('PRINCIPAL', 'PROJECT')),
  id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
