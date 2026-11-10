import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { configureTestEnvironment } from './source-pg-concurrency.mjs';

configureTestEnvironment('postgresql://test:test@127.0.0.1:1/unused');
const { pool } = await import('../dist/db.js');
const { cleanupExpiredSyncReceipts, cleanupRevokedSyncDevices } = await import('../dist/maintenance.js');

test('retention cleanup drains every expired row in one run, not one batch', async t => {
  const db = new PGlite();
  t.after(async () => { await db.close(); await pool.end(); });
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(n => /^\d{3}_.+\.sql$/.test(n)).sort()) {
    await db.exec((await readFile(new URL(name, migrations), 'utf8')).replace(/^VACUUM[^;]*;/gm, ''));
  }
  // Cleanup uses pool.query directly; route it to PGlite and expose rowCount like node-postgres.
  t.mock.method(pool, 'query', async (text, values) => {
    const result = await db.query(text, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  });
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,huawei_open_id) VALUES($1::uuid,$1::text)', [user]);
  // 2,500 expired receipts with a batch size of 1,000 needs three batches; 7 recent ones must survive.
  await db.query(`INSERT INTO sync_operation_receipts
      (user_id,operation_id,device_id,entity_type,entity_id,accepted,revision,created_at)
    SELECT $1, gen_random_uuid(), gen_random_uuid(), 'book_source', 'source_' || g, TRUE, 1,
      CASE WHEN g <= 2500 THEN now() - interval '5 days' ELSE now() - interval '1 day' END
    FROM generate_series(1, 2507) g`, [user]);
  assert.equal(await cleanupExpiredSyncReceipts(3, 1000), 2500);
  const left = await db.query('SELECT count(*)::int AS n FROM sync_operation_receipts');
  assert.equal(left.rows[0].n, 7);
  assert.equal(await cleanupExpiredSyncReceipts(3, 1000), 0);

  await db.query(`INSERT INTO sync_devices(id,user_id,revoked_at) VALUES
    (gen_random_uuid(), $1, now() - interval '31 days'),
    (gen_random_uuid(), $1, now() - interval '2 days'),
    (gen_random_uuid(), $1, NULL)`, [user]);
  assert.equal(await cleanupRevokedSyncDevices(), 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sync_devices')).rows[0].n, 2);
});
