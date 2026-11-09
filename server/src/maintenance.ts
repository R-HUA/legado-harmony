import { pool } from './db.js';

/**
 * Repeats a bounded DELETE until a batch comes back short. A single batch per run fell behind
 * the write rate (240k receipts past retention in production on 2026-10-22); each batch is its
 * own short statement so locks and WAL stay small.
 */
async function drain(deleteBatch: () => Promise<number>, batchSize: number, maxBatches: number): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const deleted = await deleteBatch();
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

export async function cleanupExpiredSyncReceipts(
  retentionDays: number,
  batchSize = 5000,
  maxBatches = 200
): Promise<number> {
  const safeRetentionDays = Math.max(1, Math.floor(retentionDays));
  const safeBatchSize = Math.max(1, Math.min(20_000, Math.floor(batchSize)));
  return drain(async () => (await pool.query(
    `DELETE FROM sync_operation_receipts
     WHERE ctid IN (
       SELECT ctid
       FROM sync_operation_receipts
       WHERE created_at < now() - make_interval(days => $1)
       ORDER BY created_at
       LIMIT $2
     )`,
    [safeRetentionDays, safeBatchSize]
  )).rowCount || 0, safeBatchSize, maxBatches);
}

/** Revoked devices were only pruned when their owner synced again; accounts that never return kept them. */
export async function cleanupRevokedSyncDevices(batchSize = 5000): Promise<number> {
  const safeBatchSize = Math.max(1, Math.min(20_000, Math.floor(batchSize)));
  const result = await pool.query(
    `DELETE FROM sync_devices
     WHERE id IN (
       SELECT id FROM sync_devices
       WHERE revoked_at < now() - interval '30 days'
       ORDER BY revoked_at
       LIMIT $1
     )`,
    [safeBatchSize]
  );
  return result.rowCount || 0;
}

export async function cleanupExpiredTtsUsage(
  retentionDays: number,
  batchSize = 5000,
  maxBatches = 200
): Promise<number> {
  const safeRetentionDays = Math.max(1, Math.floor(retentionDays));
  const safeBatchSize = Math.max(1, Math.min(20_000, Math.floor(batchSize)));
  return drain(async () => (await pool.query(
    `DELETE FROM tts_usage
     WHERE ctid IN (
       SELECT ctid
       FROM tts_usage
       WHERE status IN ('SUCCEEDED', 'FAILED', 'REFUNDED')
         AND created_at < now() - make_interval(days => $1)
         AND (completed_at IS NULL OR completed_at < now() - make_interval(days => $1))
       ORDER BY created_at
       LIMIT $2
     )`,
    [safeRetentionDays, safeBatchSize]
  )).rowCount || 0, safeBatchSize, maxBatches);
}
