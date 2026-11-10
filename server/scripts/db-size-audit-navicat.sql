-- 只读的存储统计，Navicat 可直接全选运行，每条 SELECT 生成一个结果页。
-- 只输出汇总，不含账号标识和书源内容；只有 SELECT，不修改任何数据。
-- 第 4 条要对全部书源计算哈希，数据多时可能需要几分钟。

-- 1. 数据库总大小
SELECT pg_size_pretty(pg_database_size(current_database())) AS 数据库大小;

-- 2. 各表大小（表本体 + TOAST + 索引）与死行
SELECT c.relname AS 表名,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS 总大小,
  pg_size_pretty(pg_relation_size(c.oid)) AS 表本体,
  pg_size_pretty(COALESCE(pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0)) AS toast,
  pg_size_pretty(pg_indexes_size(c.oid)) AS 索引,
  s.n_live_tup AS 有效行,
  s.n_dead_tup AS 死行,
  s.last_autovacuum AS 最近自动清理,
  s.last_vacuum AS 最近手动清理
FROM pg_class c
JOIN pg_stat_user_tables s ON s.relid = c.oid
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 25;

-- 3. 同步数据按类型：有效条数、删除墓碑、实际占用
SELECT entity_type AS 类型,
  count(*) FILTER (WHERE deleted_at IS NULL) AS 有效,
  count(*) FILTER (WHERE deleted_at IS NOT NULL) AS 墓碑,
  count(*) FILTER (WHERE deleted_at < now() - interval '90 days') AS 墓碑超过90天,
  pg_size_pretty(COALESCE(sum(pg_column_size(payload)), 0)) AS 内容占用,
  pg_size_pretty(COALESCE(avg(pg_column_size(payload)) FILTER (WHERE payload IS NOT NULL), 0)::bigint) AS 平均每条
FROM sync_entities
GROUP BY entity_type
ORDER BY sum(pg_column_size(payload)) DESC NULLS LAST;

-- 4. 书源内容重复情况：相同内容被多少账号重复保存
WITH sources AS (
  SELECT md5(payload::text) AS digest, pg_column_size(payload) AS bytes
  FROM sync_entities
  WHERE entity_type = 'book_source' AND deleted_at IS NULL
), uniq AS (
  SELECT digest, max(bytes) AS bytes, count(*) AS copies
  FROM sources GROUP BY digest
)
SELECT (SELECT count(*) FROM sources) AS 有效书源,
  count(*) AS 不同内容数,
  pg_size_pretty((SELECT sum(bytes) FROM sources)) AS 当前占用,
  pg_size_pretty(sum(bytes)) AS 相同内容只存一份时,
  count(*) FILTER (WHERE copies >= 10) AS 被10个以上账号保存的内容
FROM uniq;

-- 5. 按书源数量分档的账号
WITH per_user AS (
  SELECT user_id, count(*) AS sources, sum(pg_column_size(payload)) AS bytes
  FROM sync_entities
  WHERE entity_type = 'book_source' AND deleted_at IS NULL
  GROUP BY user_id
)
SELECT CASE width_bucket(sources, ARRAY[51, 501, 2001, 5001])
    WHEN 0 THEN '1-50' WHEN 1 THEN '51-500' WHEN 2 THEN '501-2000'
    WHEN 3 THEN '2001-5000' ELSE '5001+' END AS 每账号书源数,
  count(*) AS 账号数,
  sum(sources) AS 书源条数,
  pg_size_pretty(sum(bytes)) AS 占用
FROM per_user
GROUP BY width_bucket(sources, ARRAY[51, 501, 2001, 5001])
ORDER BY width_bucket(sources, ARRAY[51, 501, 2001, 5001]);

-- 6. 定时清理是否跟上（正常应接近 0）
SELECT '同步回执超过7天' AS 项目, count(*) AS 行数 FROM sync_operation_receipts WHERE created_at < now() - interval '8 days'
UNION ALL SELECT '已完成朗读记录超过30天', count(*) FROM tts_usage
  WHERE status IN ('SUCCEEDED', 'FAILED', 'REFUNDED') AND created_at < now() - interval '31 days'
UNION ALL SELECT '已过期登录会话', count(*) FROM auth_sessions WHERE expires_at < now()
UNION ALL SELECT '限流窗口超过1小时', count(*) FROM api_rate_limits WHERE window_start < now() - interval '1 hour'
UNION ALL SELECT '未使用会员报价超过1天', count(*) FROM membership_quotes q
  WHERE expires_at < now() - interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM membership_orders o WHERE o.quote_id = q.id)
UNION ALL SELECT '云下载授权超过1天', count(*) FROM cloud_download_tickets WHERE expires_at < now() - interval '1 day';

-- 7. 有意保留的数据（财务、历史或体积小），了解即可
SELECT '已撤销超过30天的设备' AS 项目, count(*) AS 行数 FROM sync_devices WHERE revoked_at < now() - interval '30 days'
UNION ALL SELECT '180天未出现的设备', count(*) FROM sync_devices
  WHERE revoked_at IS NULL AND last_seen_at < now() - interval '180 days'
UNION ALL SELECT '带冲突内容的回执', count(*) FROM sync_operation_receipts WHERE conflict_payload IS NOT NULL
UNION ALL SELECT '已用完或过期的朗读额度', count(*) FROM tts_quota_grants WHERE remaining_chars = 0 OR expires_at < now()
UNION ALL SELECT '朗读额度流水', count(*) FROM tts_quota_ledger
UNION ALL SELECT '点数流水', count(*) FROM point_ledger
UNION ALL SELECT '保存了自定义头像的账号', count(*) FROM app_users WHERE avatar_data IS NOT NULL;

-- 8. 头像与冲突回执内容占用
SELECT pg_size_pretty(COALESCE((SELECT sum(octet_length(avatar_data)) FROM app_users), 0)) AS 头像占用,
  pg_size_pretty(COALESCE((SELECT sum(pg_column_size(conflict_payload)) FROM sync_operation_receipts), 0)) AS 冲突回执内容占用;
