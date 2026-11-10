-- Only the manually granted icyn test period. Preserve its audit history and all files/points.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('membership:d105489a-3d17-4f18-af36-7a15e5e1b3ae',0));
SELECT pg_advisory_xact_lock(hashtextextended('sync-user:d105489a-3d17-4f18-af36-7a15e5e1b3ae',0));
SELECT user_id FROM point_wallets WHERE user_id='d105489a-3d17-4f18-af36-7a15e5e1b3ae' FOR UPDATE;
SELECT pg_advisory_xact_lock(hashtextextended('tts-quota:d105489a-3d17-4f18-af36-7a15e5e1b3ae:STANDARD',0));
SELECT pg_advisory_xact_lock(hashtextextended('tts-quota:d105489a-3d17-4f18-af36-7a15e5e1b3ae:PREMIUM',0));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_users WHERE id='d105489a-3d17-4f18-af36-7a15e5e1b3ae' AND display_name='icyn') THEN
    RAISE EXCEPTION 'Test account does not match; no changes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM membership_periods WHERE id='10537fff-4a2e-4663-93fd-7b2f7f4c24ff'
    AND user_id='d105489a-3d17-4f18-af36-7a15e5e1b3ae' AND sku='SUPER_LIFETIME'
    AND paid_months=0 AND expires_at IS NULL AND permanent_credit_points=0) THEN
    RAISE EXCEPTION 'Manual test period does not match; no changes';
  END IF;
  IF EXISTS (SELECT 1 FROM membership_orders WHERE user_id='d105489a-3d17-4f18-af36-7a15e5e1b3ae') OR
     EXISTS (SELECT 1 FROM membership_accounts WHERE user_id='d105489a-3d17-4f18-af36-7a15e5e1b3ae'
       AND (period_id<>'10537fff-4a2e-4663-93fd-7b2f7f4c24ff' OR revision<>1)) THEN
    RAISE EXCEPTION 'Account already has a purchase or changed entitlement; no changes';
  END IF;
END $$;

CREATE TEMP TABLE icyn_before ON COMMIT DROP AS SELECT
  (SELECT to_jsonb(w) FROM point_wallets w WHERE user_id='d105489a-3d17-4f18-af36-7a15e5e1b3ae') AS wallet,
  (SELECT to_jsonb(a) FROM membership_accounts a WHERE user_id='d105489a-3d17-4f18-af36-7a15e5e1b3ae') AS account,
  (SELECT jsonb_agg(to_jsonb(g)) FROM tts_quota_grants g WHERE membership_period_id='10537fff-4a2e-4663-93fd-7b2f7f4c24ff') AS grants;
SELECT 'BEFORE' AS audit, to_jsonb(b) AS record FROM icyn_before b;

UPDATE tts_quota_grants SET expires_at=LEAST(expires_at,now()), updated_at=now()
WHERE membership_period_id='10537fff-4a2e-4663-93fd-7b2f7f4c24ff' AND source='MEMBERSHIP';
UPDATE membership_quotes SET expires_at=LEAST(expires_at,now())
WHERE user_id='d105489a-3d17-4f18-af36-7a15e5e1b3ae'
  AND NOT EXISTS(SELECT 1 FROM membership_orders o WHERE o.quote_id=membership_quotes.id);
DELETE FROM membership_accounts WHERE user_id='d105489a-3d17-4f18-af36-7a15e5e1b3ae'
  AND period_id='10537fff-4a2e-4663-93fd-7b2f7f4c24ff';

DO $$
BEGIN
  IF (SELECT wallet FROM icyn_before) IS DISTINCT FROM
     (SELECT to_jsonb(w) FROM point_wallets w WHERE user_id='d105489a-3d17-4f18-af36-7a15e5e1b3ae') THEN
    RAISE EXCEPTION 'Wallet changed unexpectedly';
  END IF;
END $$;
SELECT 'AFTER' AS audit,
  NOT EXISTS(SELECT 1 FROM membership_accounts WHERE user_id='d105489a-3d17-4f18-af36-7a15e5e1b3ae') AS no_membership,
  NOT EXISTS(SELECT 1 FROM tts_quota_grants WHERE membership_period_id='10537fff-4a2e-4663-93fd-7b2f7f4c24ff'
    AND expires_at>now()) AS test_gift_expired;
COMMIT;
