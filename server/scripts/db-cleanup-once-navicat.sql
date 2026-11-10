-- 一次性清理，Navicat 中逐段选中运行（不要包在事务里：VACUUM 和 REINDEX CONCURRENTLY 不能在事务中执行）。
-- 建议在使用低峰期执行，并先确认已有数据库备份。
-- 只删除超过保留期的同步回执和撤销超过 30 天的设备；书源、书架、点数、订单等数据不动。

-- 0. 确认 PostgreSQL 版本（REINDEX ... CONCURRENTLY 需要 12 及以上）
SELECT version();

-- 1. 删除 3 天前的同步回执（回执只用于上传重试去重，新代码默认保留 3 天）
--    想保守一些可把 '3 days' 改成 '7 days'。
DELETE FROM sync_operation_receipts WHERE created_at < now() - interval '3 days';

-- 2. 删除撤销超过 30 天的设备
DELETE FROM sync_devices WHERE revoked_at < now() - interval '30 days';

-- 3. 回收删除和频繁更新留下的死行（不锁表，空间留给表复用，不会立刻缩小磁盘文件）
VACUUM (ANALYZE) sync_operation_receipts;
VACUUM (ANALYZE) sync_changes;
VACUUM (ANALYZE) sync_entities;

-- 4. 在线重建膨胀的索引（不阻塞读写，会把空出的索引空间还给磁盘）
--    sync_changes 每次同步都会改主键，索引 228 MB 远大于表本体 104 MB，收益最明显。
REINDEX TABLE CONCURRENTLY sync_changes;
REINDEX TABLE CONCURRENTLY sync_operation_receipts;
REINDEX TABLE CONCURRENTLY sync_entities;

-- 5.（可选）把回执表的空闲空间还给磁盘。会锁住回执表，期间同步上传会等待，表越大越久；
--    低峰期再执行，不执行也不影响功能，空间会被后续写入复用。
-- VACUUM FULL sync_operation_receipts;

-- 6. 清理后再看一次大小
SELECT pg_size_pretty(pg_database_size(current_database())) AS 数据库大小;
SELECT c.relname AS 表名,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS 总大小,
  pg_size_pretty(pg_relation_size(c.oid)) AS 表本体,
  pg_size_pretty(pg_indexes_size(c.oid)) AS 索引,
  s.n_live_tup AS 有效行,
  s.n_dead_tup AS 死行
FROM pg_class c
JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relname IN ('sync_entities', 'sync_operation_receipts', 'sync_changes')
ORDER BY pg_total_relation_size(c.oid) DESC;
