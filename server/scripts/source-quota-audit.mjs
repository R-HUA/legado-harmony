// Read-only rollout impact report. No user identifiers or source payloads are printed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function auditSources(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    const accounts = new Map();
    let afterUser = null, afterEntity = '';
    for (;;) {
      const { rows } = await client.query(`SELECT e.user_id,e.entity_id,e.payload,
        CASE WHEN p.anchor_at<=CURRENT_TIMESTAMP AND (p.expires_at IS NULL OR p.expires_at>CURRENT_TIMESTAMP)
          AND COALESCE(d.iap_debt_points,0)<=0 THEN p.sku ELSE 'FREE' END AS tier
        FROM sync_entities e
        LEFT JOIN membership_accounts a ON a.user_id=e.user_id
        LEFT JOIN membership_periods p ON p.id=a.period_id
        LEFT JOIN account_debts d ON d.user_id=e.user_id
        WHERE e.entity_type='book_source' AND e.deleted_at IS NULL
          AND ($1::uuid IS NULL OR (e.user_id,e.entity_id)>($1::uuid,$2::text))
        ORDER BY e.user_id,e.entity_id LIMIT 64`, [afterUser, afterEntity]);
      if (!rows.length) break;
      for (const row of rows) {
        const tier = row.tier === 'SUPER_LIFETIME' ? 'SUPER' : row.tier === 'FREE' ? 'FREE' : 'MEMBER';
        const record = accounts.get(row.user_id) || { tier, count: 0, oversize: 0, maxBytes: 0 };
        // Matches applyOperation's actual per-source limit, not PostgreSQL's spaced JSONB text size.
        const bytes = Buffer.byteLength(JSON.stringify(row.payload), 'utf8');
        record.count++;
        record.maxBytes = Math.max(record.maxBytes, bytes);
        if (tier !== 'SUPER' && bytes > (tier === 'FREE' ? 50 : 512) * 1024) record.oversize++;
        accounts.set(row.user_id, record);
      }
      afterUser = rows.at(-1).user_id;
      afterEntity = rows.at(-1).entity_id;
    }
    const summary = ['FREE', 'MEMBER', 'SUPER'].map(tier => {
      const rows = [...accounts.values()].filter(row => row.tier === tier);
      const limit = tier === 'FREE' ? 50 : tier === 'MEMBER' ? 500 : Infinity;
      return {
        tier, usersWithSources: rows.length,
        sources: rows.reduce((sum, row) => sum + row.count, 0),
        usersAtCountLimit: rows.filter(row => row.count === limit).length,
        usersOverCountLimit: rows.filter(row => row.count > limit).length,
        usersWithOversizeSources: rows.filter(row => row.oversize > 0).length,
        oversizeSources: rows.reduce((sum, row) => sum + row.oversize, 0),
        usersFacingNewOrGrowthLimits: rows.filter(row => row.count >= limit || row.oversize > 0).length,
        maxSourcesPerUser: rows.reduce((max, row) => Math.max(max, row.count), 0),
        maxSourceBytes: rows.reduce((max, row) => Math.max(max, row.maxBytes), 0)
      };
    });
    const versions = (await client.query(`SELECT app_version,count(*) AS devices,count(DISTINCT user_id) AS users
      FROM sync_devices WHERE revoked_at IS NULL AND last_seen_at>=CURRENT_TIMESTAMP-interval '30 days'
      GROUP BY app_version ORDER BY count(*) DESC,app_version LIMIT 10`)).rows;
    await client.query('ROLLBACK');
    return { summary, versions };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

async function main() {
  const require = createRequire(resolve(process.cwd(), 'package.json'));
  const pg = require('pg');
  const client = new pg.Client({ host: '/tmp', port: 5432, user: 'postgres', database: 'legado_commerce',
    options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 10000,
    statement_timeout: 30000, idle_in_transaction_session_timeout: 30000 });
  try {
    await client.connect();
    const { summary, versions } = await auditSources(client);
    console.log('Source limit impact (accounts with active sources only):');
    console.table(summary.map(row => ({
      tier: row.tier, users: row.usersWithSources, sources: row.sources,
      atCap: row.usersAtCountLimit, overCap: row.usersOverCountLimit,
      largeUsers: row.usersWithOversizeSources, largeSources: row.oversizeSources,
      affectedUsers: row.usersFacingNewOrGrowthLimits
    })));
    console.table(summary.map(row => ({ tier: row.tier,
      maxSourcesPerUser: row.maxSourcesPerUser, maxSourceKiB: (row.maxSourceBytes / 1024).toFixed(2) })));
    console.log('Sync device versions seen in the last 30 days (top 10):');
    console.table(versions);
    console.log('FREE=50 sources/50 KiB; MEMBER=500 sources/512 KiB; SUPER=no separate source-tier cap.');
    console.log('This report does not measure the shared 1 GiB cap or simulate all sync safety limits.');
    console.log('PASS read-only audit; no data, configuration or sales settings changed');
  } finally { await client.end(); }
}

if (!process.argv[1] || resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    const code = String(error.code || 'CHECK_FAILED');
    console.error('FAIL read-only audit', /^[A-Z0-9_]+$/.test(code) ? code : 'CHECK_FAILED');
    process.exitCode = 1;
  });
}
