-- Read-only storage report: where the space goes and whether retention jobs keep up.
-- Prints aggregates only (no user ids, no payload content). Safe to run on production:
--   sudo -u postgres psql -d legado_commerce -f server/scripts/db-size-audit.sql
-- The book-source duplicate section hashes every live source; expect it to take a while on large data.
\pset pager off
\timing on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15min';

\echo '== 1. Database size'
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;

\echo '== 2. Tables by total size (heap + TOAST + indexes), with dead-row bloat'
SELECT c.relname AS table_name,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
  pg_size_pretty(pg_relation_size(c.oid)) AS heap,
  pg_size_pretty(COALESCE(pg_total_relation_size(c.reltoastrelid), 0)) AS toast,
  pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
  s.n_live_tup AS live_rows, s.n_dead_tup AS dead_rows,
  s.last_autovacuum, s.last_vacuum
FROM pg_class c JOIN pg_stat_user_tables s ON s.relid = c.oid
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 25;

\echo '== 3. Sync entities by type: live rows, tombstones, stored payload size'
SELECT entity_type,
  count(*) FILTER (WHERE deleted_at IS NULL) AS live,
  count(*) FILTER (WHERE deleted_at IS NOT NULL) AS tombstones,
  count(*) FILTER (WHERE deleted_at < now() - interval '90 days') AS tombstones_90d,
  pg_size_pretty(COALESCE(sum(pg_column_size(payload)), 0)) AS stored_payload,
  pg_size_pretty(COALESCE(avg(pg_column_size(payload)) FILTER (WHERE payload IS NOT NULL), 0)::bigint) AS avg_payload
FROM sync_entities GROUP BY entity_type ORDER BY sum(pg_column_size(payload)) DESC NULLS LAST;

\echo '== 4. Book sources: how much is the same content stored by many accounts'
WITH sources AS (
  SELECT md5(payload::text) AS digest, pg_column_size(payload) AS bytes
  FROM sync_entities WHERE entity_type = 'book_source' AND deleted_at IS NULL
), uniq AS (
  SELECT digest, max(bytes) AS bytes, count(*) AS copies FROM sources GROUP BY digest
)
SELECT (SELECT count(*) FROM sources) AS live_sources,
  count(*) AS distinct_contents,
  pg_size_pretty((SELECT sum(bytes) FROM sources)) AS stored_now,
  pg_size_pretty(sum(bytes)) AS if_each_content_stored_once,
  count(*) FILTER (WHERE copies >= 10) AS contents_with_10plus_copies
FROM uniq;

\echo '== 5. Accounts by book-source volume (ranks only)'
WITH per_user AS (
  SELECT user_id, count(*) AS sources, sum(pg_column_size(payload)) AS bytes
  FROM sync_entities WHERE entity_type = 'book_source' AND deleted_at IS NULL GROUP BY user_id
)
SELECT width_bucket(sources, ARRAY[51, 501, 2001, 5001]) AS bucket,
  CASE width_bucket(sources, ARRAY[51, 501, 2001, 5001])
    WHEN 0 THEN '1-50' WHEN 1 THEN '51-500' WHEN 2 THEN '501-2000' WHEN 3 THEN '2001-5000' ELSE '5001+' END AS sources_per_account,
  count(*) AS accounts, sum(sources) AS sources, pg_size_pretty(sum(bytes)) AS stored
FROM per_user GROUP BY 1, 2 ORDER BY 1;

\echo '== 6. Retention jobs: rows that should already be gone (expect ~0)'
SELECT 'sync_operation_receipts > 7d' AS item, count(*) AS rows FROM sync_operation_receipts WHERE created_at < now() - interval '8 days'
UNION ALL SELECT 'tts_usage finished > 30d', count(*) FROM tts_usage
  WHERE status IN ('SUCCEEDED','FAILED','REFUNDED') AND created_at < now() - interval '31 days'
UNION ALL SELECT 'auth_sessions expired', count(*) FROM auth_sessions WHERE expires_at < now()
UNION ALL SELECT 'api_rate_limits > 1h', count(*) FROM api_rate_limits WHERE window_start < now() - interval '1 hour'
UNION ALL SELECT 'membership_quotes unused > 1d', count(*) FROM membership_quotes q
  WHERE expires_at < now() - interval '1 day' AND NOT EXISTS (SELECT 1 FROM membership_orders o WHERE o.quote_id = q.id)
UNION ALL SELECT 'cloud_download_tickets > 1d', count(*) FROM cloud_download_tickets WHERE expires_at < now() - interval '1 day';

\echo '== 7. Kept on purpose, but worth knowing (history / financial / small)'
SELECT 'sync_devices revoked > 30d' AS item, count(*) AS rows FROM sync_devices WHERE revoked_at < now() - interval '30 days'
UNION ALL SELECT 'sync_devices unseen > 180d (not revoked)', count(*) FROM sync_devices
  WHERE revoked_at IS NULL AND last_seen_at < now() - interval '180 days'
UNION ALL SELECT 'receipts carrying conflict payloads', count(*) FROM sync_operation_receipts WHERE conflict_payload IS NOT NULL
UNION ALL SELECT 'tts_quota_grants used up or expired', count(*) FROM tts_quota_grants WHERE remaining_chars = 0 OR expires_at < now()
UNION ALL SELECT 'tts_quota_ledger rows', count(*) FROM tts_quota_ledger
UNION ALL SELECT 'point_ledger rows', count(*) FROM point_ledger
UNION ALL SELECT 'app_users with stored avatar', count(*) FROM app_users WHERE avatar_data IS NOT NULL;

SELECT pg_size_pretty(COALESCE(sum(octet_length(avatar_data)), 0)) AS avatar_bytes FROM app_users;
SELECT pg_size_pretty(COALESCE(sum(pg_column_size(conflict_payload)), 0)) AS receipt_conflict_payload_bytes
FROM sync_operation_receipts;

ROLLBACK;
