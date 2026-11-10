BEGIN;

-- Products go on sale automatically at sales_starts_at. sales_enabled still opens a product early
-- (and the account pilot still applies); clearing both stops sales again.
ALTER TABLE membership_products ADD COLUMN IF NOT EXISTS sales_starts_at TIMESTAMPTZ;
UPDATE membership_products
SET sales_starts_at = TIMESTAMPTZ '2026-11-01 00:00:00+08'
WHERE sales_starts_at IS NULL;

-- Time-boxed prices. The base price stays in membershipPolicy.ts; a promotion only lowers it.
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

-- Launch: permanent and permanent super at half price from 2026-11-01 through 2026-12-25 (UTC+8).
INSERT INTO membership_promotions(id, sku, price_points, label, starts_at, ends_at) VALUES
  ('launch-2026-lifetime', 'LIFETIME', 645, '首发半价',
    TIMESTAMPTZ '2026-11-01 00:00:00+08', TIMESTAMPTZ '2026-12-26 00:00:00+08'),
  ('launch-2026-super', 'SUPER_LIFETIME', 1245, '首发半价',
    TIMESTAMPTZ '2026-11-01 00:00:00+08', TIMESTAMPTZ '2026-12-26 00:00:00+08')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE membership_orders ADD COLUMN IF NOT EXISTS promotion_id TEXT REFERENCES membership_promotions(id);

COMMIT;
