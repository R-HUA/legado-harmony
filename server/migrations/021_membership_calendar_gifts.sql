BEGIN;

-- Legacy claims keep their original period/cycle identity and quota grants.
-- New claims use an absolute Beijing month (year * 12 + zero-based month).
ALTER TABLE membership_gift_claims ADD COLUMN IF NOT EXISTS gift_month INTEGER
  CHECK (gift_month >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS membership_gift_user_month_idx
  ON membership_gift_claims(user_id, gift_month) WHERE gift_month IS NOT NULL;
-- Read historical claims by their actual claim time; never rewrite or drop old grants,
-- including two legacy anniversary claims that happened in the same calendar month.
CREATE INDEX IF NOT EXISTS membership_gift_legacy_time_idx
  ON membership_gift_claims(user_id, created_at) WHERE gift_month IS NULL;

COMMIT;
