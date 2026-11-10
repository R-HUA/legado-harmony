BEGIN;

CREATE TABLE IF NOT EXISTS membership_products (
  sku TEXT PRIMARY KEY CHECK (sku IN ('MONTHLY','ANNUAL','LIFETIME','SUPER_LIFETIME')),
  sales_enabled BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO membership_products(sku) VALUES
  ('MONTHLY'), ('ANNUAL'), ('LIFETIME'), ('SUPER_LIFETIME') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS membership_periods (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  sku TEXT NOT NULL REFERENCES membership_products(sku),
  anchor_at TIMESTAMPTZ NOT NULL,
  paid_months INTEGER NOT NULL CHECK (paid_months >= 0),
  expires_at TIMESTAMPTZ,
  permanent_credit_points BIGINT NOT NULL DEFAULT 0 CHECK (permanent_credit_points >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((sku IN ('LIFETIME','SUPER_LIFETIME') AND expires_at IS NULL AND paid_months = 0)
    OR (sku IN ('MONTHLY','ANNUAL') AND expires_at > anchor_at AND paid_months > 0)),
  UNIQUE (user_id, id)
);
CREATE TABLE IF NOT EXISTS membership_accounts (
  user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  period_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  FOREIGN KEY (user_id, period_id) REFERENCES membership_periods(user_id, id)
);
CREATE TABLE IF NOT EXISTS membership_quotes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  policy_version INTEGER NOT NULL,
  plan JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS membership_quotes_expiry_idx ON membership_quotes(expires_at);
CREATE TABLE IF NOT EXISTS membership_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  period_id UUID NOT NULL REFERENCES membership_periods(id),
  sku TEXT NOT NULL REFERENCES membership_products(sku),
  request_id TEXT NOT NULL,
  quote_id UUID NOT NULL UNIQUE REFERENCES membership_quotes(id),
  list_points BIGINT NOT NULL CHECK (list_points > 0),
  credit_points BIGINT NOT NULL CHECK (credit_points >= 0),
  points_spent BIGINT NOT NULL CHECK (points_spent >= 0),
  term_starts_at TIMESTAMPTZ,
  term_ends_at TIMESTAMPTZ,
  point_ledger_id UUID NOT NULL REFERENCES point_ledger(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id),
  CHECK (points_spent + credit_points = list_points),
  CHECK ((term_starts_at IS NULL AND term_ends_at IS NULL)
    OR (term_starts_at IS NOT NULL AND term_ends_at > term_starts_at))
);
CREATE INDEX IF NOT EXISTS membership_orders_period_idx ON membership_orders(period_id, created_at);

ALTER TABLE tts_quota_grants DROP CONSTRAINT IF EXISTS tts_quota_grants_source_check;
ALTER TABLE tts_quota_grants ADD CONSTRAINT tts_quota_grants_source_check
  CHECK (source IN ('TRIAL','POINT_REDEEM','ADMIN','REFUND','MEMBERSHIP'));
ALTER TABLE tts_quota_grants ADD COLUMN IF NOT EXISTS membership_period_id UUID REFERENCES membership_periods(id);
CREATE INDEX IF NOT EXISTS tts_quota_membership_period_idx
  ON tts_quota_grants(membership_period_id) WHERE membership_period_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS membership_gift_claims (
  period_id UUID NOT NULL REFERENCES membership_periods(id),
  cycle_index INTEGER NOT NULL CHECK (cycle_index >= 0),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('STANDARD','PREMIUM')),
  chars INTEGER NOT NULL CHECK (chars > 0),
  quota_grant_id UUID NOT NULL REFERENCES tts_quota_grants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (period_id, cycle_index)
);

ALTER TABLE theme_catalog ADD COLUMN IF NOT EXISTS member_included BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;
