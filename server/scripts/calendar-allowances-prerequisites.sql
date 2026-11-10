-- Compatibility schema for the confirmed production baseline (019/020 absent).
-- Intentionally does NOT enable sales, schedule a launch or create promotions.
BEGIN;
ALTER TABLE membership_products ADD COLUMN IF NOT EXISTS sales_starts_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS membership_promotions (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES membership_products(sku),
  price_points BIGINT NOT NULL CHECK (price_points > 0),
  label TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS membership_promotions_window_idx
  ON membership_promotions(sku, starts_at, ends_at);
ALTER TABLE membership_orders ADD COLUMN IF NOT EXISTS promotion_id TEXT REFERENCES membership_promotions(id);

ALTER TABLE cloud_files ADD COLUMN IF NOT EXISTS meta JSONB;
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
