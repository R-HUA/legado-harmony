import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { auditSources } from './source-quota-audit.mjs';

test('read-only audit handles pagination, exact UTF-8 size, expired/debt memberships and deleted records', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE sync_entities(user_id uuid,entity_id text,entity_type text,payload jsonb,deleted_at timestamptz);
      CREATE TABLE membership_accounts(user_id uuid,period_id uuid);
      CREATE TABLE membership_periods(id uuid,sku text,anchor_at timestamptz,expires_at timestamptz);
      CREATE TABLE account_debts(user_id uuid,iap_debt_points bigint);
      CREATE TABLE sync_devices(user_id uuid,app_version text,revoked_at timestamptz,last_seen_at timestamptz);`);
    async function account(count, sku, expires, debt = 0, payload = { rules: '小' }) {
      const id = randomUUID(), period = randomUUID();
      if (sku) {
        await db.query("INSERT INTO membership_periods VALUES($1,$2,now()-interval '1 day',$3)", [period, sku, expires]);
        await db.query('INSERT INTO membership_accounts VALUES($1,$2)', [id, period]);
      }
      if (debt) await db.query('INSERT INTO account_debts VALUES($1,$2)', [id, debt]);
      for (let i = 0; i < count; i++) {
        await db.query("INSERT INTO sync_entities VALUES($1,$2,'book_source',$3,NULL)", [id, `source_${i}`, payload]);
      }
      return id;
    }
    const first = await account(50);
    await account(51, 'MONTHLY', new Date(Date.now() - 1000));
    await account(1, 'MONTHLY', new Date(Date.now() + 3600000));
    const oversized = { rules: '字'.repeat(18000) };
    await account(1, 'SUPER_LIFETIME', null, 1, oversized);
    await account(1, 'SUPER_LIFETIME', null, 0, oversized);
    await db.query("INSERT INTO sync_entities VALUES($1,'deleted','book_source',NULL,now())", [first]);
    await db.query("INSERT INTO sync_entities VALUES($1,'settings','reader_settings',$2,NULL)", [first, oversized]);
    await db.query("INSERT INTO sync_devices VALUES($1,'test-version',NULL,now())", [first]);
    const { summary, versions } = await auditSources(db);
    const free = summary.find(r => r.tier === 'FREE');
    assert.equal(free.usersWithSources, 3);
    assert.equal(free.sources, 102);
    assert.equal(free.usersAtCountLimit, 1);
    assert.equal(free.usersOverCountLimit, 1);
    assert.equal(free.usersWithOversizeSources, 1);
    assert.equal(free.oversizeSources, 1);
    assert.equal(free.usersFacingNewOrGrowthLimits, 3);
    assert.equal(free.maxSourceBytes, Buffer.byteLength(JSON.stringify(oversized)));
    assert.equal(summary.find(r => r.tier === 'MEMBER').sources, 1);
    assert.equal(summary.find(r => r.tier === 'SUPER').oversizeSources, 0);
    assert.equal(versions.length, 1);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM sync_entities')).rows[0].n), 106);
  } finally { await db.close(); }
});
