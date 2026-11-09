// Exercises the actual deployment heredoc against an isolated PGlite database.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { membershipCatalog, membershipSnapshot } from '../dist/membershipService.js';
import { membershipGiftChars, membershipCalendarCycle } from '../dist/membershipPolicy.js';
import { CloudFileService } from '../dist/cloudFileService.js';

const script = readFileSync(new URL('./deploy-calendar-allowances.sh', import.meta.url), 'utf8');
const blocks = [...script.matchAll(/<<'(PREFLIGHT|MIGRATE|HEALTH)'\n([\s\S]*?)\n\1/g)];
assert.equal(blocks.length, 3);
const temp = mkdtempSync(join(tmpdir(), 'calendar-deploy-check-'));
try {
  for (const [, name, body] of blocks) {
    const path = join(temp, name + '.mjs');
    writeFileSync(path, body);
    const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
const body = blocks.find(b => b[1] === 'MIGRATE')[2].replace(/^import .*;\n/gm, '');
const run = new (Object.getPrototypeOf(async function() {}).constructor)(
  'assert', 'readFileSync', 'writeFileSync', 'pool', 'membershipCatalog', 'membershipSnapshot',
  'membershipGiftChars', 'membershipCalendarCycle', 'CloudFileService', body);
const migrations = new URL('../migrations/', import.meta.url);
for (const fail of [false, true]) {
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE qingye SUPERUSER; SET ROLE qingye;');
    for (const name of readdirSync(migrations).filter(n => /^0(0\d|1[0-8])_.*\.sql$/.test(n)).sort()) {
      await db.exec(readFileSync(new URL(name, migrations), 'utf8').replace(/^VACUUM[^;]*;/gm, ''));
    }
    await db.exec(`UPDATE membership_products SET sales_enabled=true WHERE sku='SUPER_LIFETIME';
      INSERT INTO app_users(id,huawei_open_id) VALUES('00000000-0000-4000-8000-000000000001','deploy-test');
      INSERT INTO membership_periods(id,user_id,sku,anchor_at,paid_months)
      VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','SUPER_LIFETIME',now()-interval '1 day',0);
      INSERT INTO membership_accounts(user_id,period_id,revision)
      VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',1);`);
    const client = {
      async query(sql, params) {
        if (sql.includes('SELECT current_database() AS db')) {
          const result = await db.query(sql);
          // Embedded fixture database has a different name; retain the real role check.
          result.rows[0].db = 'legado_commerce';
          return result;
        }
        if (fail && sql.includes('CREATE TABLE IF NOT EXISTS cloud_download_monthly_usage')) {
          throw new Error('injected migration failure');
        }
        if (sql.includes('ALTER TABLE') || sql.includes('CREATE TABLE')) return db.exec(sql);
        return db.query(sql, params);
      },
      release() {}
    };
    const execute = () => run(assert, path => {
      const name = path.split('/').pop();
      return readFileSync(name === '000_schema_prerequisites.sql'
        ? new URL('./calendar-allowances-prerequisites.sql', import.meta.url)
        : new URL(name, migrations), 'utf8');
    },
      () => {}, { connect: async () => client, end: async () => {} }, membershipCatalog, membershipSnapshot,
      membershipGiftChars, membershipCalendarCycle, CloudFileService);
    if (fail) {
      await assert.rejects(execute, /injected migration failure/);
      const result = await db.query(`SELECT to_regclass('public.membership_promotions') AS promotions,
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='membership_gift_claims' AND column_name='gift_month') AS gifts`);
      assert.deepEqual(result.rows[0], { promotions: null, gifts: false });
      console.log('PASS: failure in third migration rolls back first and second migrations');
    } else {
      await execute();
      assert.equal((await db.query('SELECT count(*)::int AS n FROM cloud_download_monthly_usage')).rows[0].n, 0);
      console.log('PASS: deployment migration transaction and existing-account read checks');
    }
  } finally { await db.close(); }
}
