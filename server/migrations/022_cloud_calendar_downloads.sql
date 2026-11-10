BEGIN;

-- Deliberately start a fresh calendar-month allowance at rollout, as approved.
-- Keep all legacy usage for audit; do not seed from anniversary totals.
CREATE TABLE IF NOT EXISTS cloud_download_monthly_usage (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  month_index integer NOT NULL CHECK (month_index >= 0),
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0 AND bytes <= 1073741824),
  PRIMARY KEY (user_id, month_index)
);
ALTER TABLE cloud_download_tickets ADD COLUMN IF NOT EXISTS download_month integer
  CHECK (download_month >= 0);

COMMIT;
