BEGIN;
ALTER TABLE theme_catalog ADD COLUMN IF NOT EXISTS acquisition TEXT NOT NULL DEFAULT 'POINTS'
  CHECK (acquisition IN ('POINTS', 'SUPER_CLAIM'));
ALTER TABLE theme_catalog DROP CONSTRAINT IF EXISTS theme_catalog_price_check;
ALTER TABLE theme_catalog ADD CONSTRAINT theme_catalog_price_check CHECK (
  (acquisition = 'POINTS' AND price_points BETWEEN 1 AND 1000000) OR
  (acquisition = 'SUPER_CLAIM' AND price_points = 0 AND member_included = FALSE)
);
INSERT INTO theme_catalog (theme_id, display_name, price_points, valid_days, enabled, member_included, acquisition)
VALUES ('obsidian-archive', '曜金藏书', 0, 365, TRUE, FALSE, 'SUPER_CLAIM')
ON CONFLICT (theme_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS membership_theme_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  theme_id TEXT NOT NULL REFERENCES theme_catalog(theme_id),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  claimed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, request_id),
  CHECK (expires_at > claimed_at)
);
CREATE INDEX IF NOT EXISTS membership_theme_claims_owner_idx
  ON membership_theme_claims(user_id, theme_id, claimed_at DESC);
COMMIT;
