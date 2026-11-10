BEGIN;
ALTER TABLE cloud_chunks ADD COLUMN IF NOT EXISTS upload_md5 varchar(24);
ALTER TABLE cloud_chunks ADD COLUMN IF NOT EXISTS upload_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS cloud_chunks_staging_cleanup ON cloud_chunks(upload_expires_at)
  WHERE upload_expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS cloud_download_tickets (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  request_id varchar(100) NOT NULL,
  file_id uuid NOT NULL REFERENCES cloud_files(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  period_id uuid NOT NULL REFERENCES membership_periods(id),
  cycle_index integer NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,request_id)
);
CREATE INDEX IF NOT EXISTS cloud_download_tickets_expiry ON cloud_download_tickets(expires_at);
COMMIT;
