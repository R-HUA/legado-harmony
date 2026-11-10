BEGIN;

-- Small client metadata (book title/author/format/content fingerprint, font display name) so another
-- device can show a cloud item before downloading it.
ALTER TABLE cloud_files ADD COLUMN IF NOT EXISTS meta JSONB;

-- When a synced font or book is removed, its bytes are deleted but a marker remains, so devices that
-- still hold a copy can tell "removed elsewhere" (REMOVED: remove it too) or "cloud copy dropped"
-- (DETACHED: keep the local file, stop uploading it) from "new, please upload". Markers expire.
CREATE TABLE IF NOT EXISTS cloud_file_tombstones (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('BOOK','FONT','SOURCE')),
  manifest_hash VARCHAR(64),
  meta JSONB,
  reason VARCHAR(16) NOT NULL CHECK (reason IN ('REMOVED','DETACHED')),
  removed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_file_tombstones_owner ON cloud_file_tombstones(user_id, removed_at);

COMMIT;
