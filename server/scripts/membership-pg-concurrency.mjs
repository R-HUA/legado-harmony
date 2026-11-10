// Run via stdin as the PostgreSQL OS user, with cwd = deployed application root.
// Uses only /tmp PostgreSQL socket and a newly-created, empty disposable database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const require = createRequire(resolve(root, 'package.json'));
const pg = require('pg');
const service = await import(pathToFileURL(resolve(root, 'membershipService.js')).href);
const { quoteMembership, purchaseMembership, claimMembershipGift, readMembership } = service;
const database = 'qingye_member_test_' + randomUUID().replaceAll('-', '');
const connection = { host: '/tmp', port: 5432, user: 'postgres',
  connectionTimeoutMillis: 10000, statement_timeout: 20000,
  lock_timeout: 10000, idle_in_transaction_session_timeout: 30000 };
const admin = new pg.Client({ ...connection, database: 'postgres' });
let pool, created = false, step = 'connect local PostgreSQL';
const now = Date.now();
let passed = 0;
function pass(label) { passed++; console.log('PASS', label); }
async function tx(work) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const value = await work(c);
    await c.query('COMMIT');
    return value;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
// Hold one separate session per contender before releasing the start barrier.
async function race(jobs) {
  let arrived = 0, release;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  const timer = setTimeout(() => release(), 12000);
  try {
    return await Promise.allSettled(jobs.map(job => tx(async c => {
      if (++arrived === jobs.length) release();
      await gate;
      assert.equal(arrived, jobs.length, 'not all concurrent sessions connected');
      return job(c);
    })));
  } finally { clearTimeout(timer); }
}
async function user(paid = 10000, promo = 300) {
  const id = randomUUID();
  await pool.query('INSERT INTO app_users(id,huawei_open_id) VALUES($1,$2)', [id, id]);
  await pool.query('INSERT INTO point_wallets(user_id,balance,paid_balance,promo_balance) VALUES($1,$2,$3,$4)',
    [id, paid + promo, paid, promo]);
  return id;
}
async function wallet(id, paid, orders) {
  const row = (await pool.query('SELECT paid_balance,promo_balance,balance FROM point_wallets WHERE user_id=$1', [id])).rows[0];
  assert.equal(Number(row.paid_balance), paid);
  assert.equal(Number(row.promo_balance), 300);
  assert.equal(Number(row.balance), paid + 300);
  for (const table of ['membership_orders', 'point_ledger']) {
    assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE user_id=$1`, [id])).rows[0].count), orders);
  }
}
async function buy(id, sku) {
  const q = await tx(c => quoteMembership(c, id, sku, now));
  await tx(c => purchaseMembership(c, id, q.quoteId, randomUUID(), now));
}
async function giftRows(id) {
  const claims = (await pool.query('SELECT * FROM membership_gift_claims WHERE user_id=$1', [id])).rows;
  const grants = (await pool.query('SELECT * FROM tts_quota_grants WHERE user_id=$1', [id])).rows;
  const ledger = (await pool.query('SELECT * FROM tts_quota_ledger WHERE user_id=$1', [id])).rows;
  assert.equal(claims.length, 1); assert.equal(grants.length, 1); assert.equal(ledger.length, 1);
  const expected = claims[0].tier === 'STANDARD' ? 12000 : 6000;
  assert.equal(Number(claims[0].chars), expected);
  assert.equal(Number(grants[0].total_chars), expected);
  assert.equal(Number(grants[0].remaining_chars), expected);
  assert.equal(Number(ledger[0].delta_chars), expected);
  assert.equal(claims[0].quota_grant_id, grants[0].id);
  assert.equal(ledger[0].grant_id, grants[0].id);
  return claims[0];
}
try {
  await admin.connect();
  step = 'create disposable database';
  assert.match(database, /^qingye_member_test_[a-f0-9]{32}$/);
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  created = true;
  console.log('Temporary database:', database);
  pool = new pg.Pool({ ...connection, database, max: 8 });
  pool.on('error', () => { console.error('FAIL idle test connection'); process.exitCode = 1; });
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, database);

  step = 'migrate empty test database';
  const files = (await readdir(resolve(root, 'migrations'))).filter(n => /^\d{3}_.+\.sql$/.test(n)).sort();
  assert.ok(files.includes('016_memberships.sql') && files.includes('018_cloud_direct_transfers.sql'));
  for (const file of files) {
    // Operational VACUUM is irrelevant on empty fixtures and cannot run in a multi-statement query.
    const sql = (await readFile(resolve(root, 'migrations', file), 'utf8')).replace(/^VACUUM[^;]*;/gm, '');
    const c = await pool.connect();
    try { await c.query(sql); } finally { c.release(); }
  }
  // Migration 019 schedules the 2026-11-01 launch; these checks exercise manual opening at any date.
  await pool.query('UPDATE membership_products SET sales_starts_at=NULL');

  step = 'sales default closed';
  const closedUser = await user();
  await assert.rejects(tx(c => quoteMembership(c, closedUser, 'MONTHLY', now)),
    e => e.code === 'MEMBERSHIP_NOT_ON_SALE');
  pass(step);
  // This statement runs ONLY in the fresh disposable database.
  step = 'pilot account/SKU isolation, expiry and concurrent payment retries';
  const { parseMembershipSalesPilot } = await import(pathToFileURL(resolve(root, 'membershipSales.js')).href);
  const pilotUser = await user();
  const pilot = parseMembershipSalesPilot(pilotUser, 'MONTHLY', new Date(now + 60000).toISOString());
  await assert.rejects(tx(c => quoteMembership(c, closedUser, 'MONTHLY', now, pilot)), e => e.code === 'MEMBERSHIP_NOT_ON_SALE');
  await assert.rejects(tx(c => quoteMembership(c, pilotUser, 'ANNUAL', now, pilot)), e => e.code === 'MEMBERSHIP_NOT_ON_SALE');
  const pilotQuote = await tx(c => quoteMembership(c, pilotUser, 'MONTHLY', now, pilot));
  await assert.rejects(tx(c => purchaseMembership(c, pilotUser, pilotQuote.quoteId, 'expired', now + 60000, pilot)), e => e.code === 'MEMBERSHIP_NOT_ON_SALE');
  await wallet(pilotUser, 10000, 0);
  const pilotResults = await race(Array.from({ length: 8 }, (_, i) =>
    c => purchaseMembership(c, pilotUser, pilotQuote.quoteId, 'pilot-' + i, now, pilot)));
  assert.ok(pilotResults.every(r => r.status === 'fulfilled'));
  assert.equal(new Set(pilotResults.map(r => r.value.orderId)).size, 1);
  const recovered = await tx(c => purchaseMembership(c, pilotUser, pilotQuote.quoteId, 'pilot-0', now + 60000));
  assert.equal(recovered.duplicate, true);
  await wallet(pilotUser, 9940, 1);
  pass(step);
  await pool.query('UPDATE membership_products SET sales_enabled=true');

  for (const sameRequest of [true, false]) {
    step = sameRequest ? '8 simultaneous identical purchases charge once' : '8 request IDs sharing a quote charge once';
    const id = await user();
    const q = await tx(c => quoteMembership(c, id, 'MONTHLY', now));
    const results = await race(Array.from({ length: 8 }, (_, i) =>
      c => purchaseMembership(c, id, q.quoteId, sameRequest ? 'same-request' : 'request-' + i, now)));
    assert.ok(results.every(r => r.status === 'fulfilled'));
    assert.equal(new Set(results.map(r => r.value.orderId)).size, 1);
    await wallet(id, 9940, 1);
    pass(step);
  }

  step = 'competing quotes cannot overwrite each other';
  const competing = await user();
  const quotes = await Promise.all(['MONTHLY', 'ANNUAL'].map(sku => tx(c => quoteMembership(c, competing, sku, now))));
  const competition = await race(quotes.map((q, i) => c => purchaseMembership(c, competing, q.quoteId, 'compete-' + i, now)));
  assert.equal(competition.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(competition.find(r => r.status === 'rejected').reason.code, 'MEMBERSHIP_OFFER_CHANGED');
  const spent = Number((await pool.query('SELECT points_spent FROM membership_orders WHERE user_id=$1', [competing])).rows[0].points_spent);
  assert.ok([60, 480].includes(spent));
  await wallet(competing, 10000 - spent, 1);
  pass(step);

  for (const mixed of [false, true]) {
    step = mixed ? 'competing gift tiers issue only one grant' : '8 simultaneous gift claims issue only one grant';
    const id = await user();
    await buy(id, 'SUPER_LIFETIME');
    const tiers = Array.from({ length: 8 }, (_, i) => mixed && i % 2 ? 'PREMIUM' : 'STANDARD');
    const results = await race(tiers.map(tier => c => claimMembershipGift(c, id, tier, now)));
    const claim = await giftRows(id);
    results.forEach((r, i) => {
      if (tiers[i] === claim.tier) assert.equal(r.status, 'fulfilled');
      else { assert.equal(r.status, 'rejected'); assert.equal(r.reason.code, 'MEMBERSHIP_GIFT_ALREADY_CLAIMED'); }
    });
    await wallet(id, 7510, 1);
    pass(step);
  }

  step = 'insufficient paid points rolls back every competing purchase';
  const poor = await user(59, 10000);
  const q = await tx(c => quoteMembership(c, poor, 'MONTHLY', now));
  const results = await race(Array.from({ length: 8 }, (_, i) => c => purchaseMembership(c, poor, q.quoteId, 'poor-' + i, now)));
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'INSUFFICIENT_PAID_POINTS'));
  const balance = (await pool.query('SELECT paid_balance,promo_balance FROM point_wallets WHERE user_id=$1', [poor])).rows[0];
  assert.equal(Number(balance.paid_balance), 59); assert.equal(Number(balance.promo_balance), 10000);
  assert.equal(await readMembership(pool, poor), null);
  for (const table of ['membership_orders', 'point_ledger']) {
    assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE user_id=$1`, [poor])).rows[0].count), 0);
  }
  pass(step);
} catch (e) {
  const code = String(e.code || 'CHECK_FAILED');
  console.error('FAIL', step, /^[A-Z0-9_]+$/.test(code) ? code : 'CHECK_FAILED');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (created) {
    try {
      assert.match(database, /^qingye_member_test_[a-f0-9]{32}$/);
      await admin.query(`DROP DATABASE "${database}"`);
      console.log('PASS temporary database removed');
    } catch {
      console.error('FAIL temporary database cleanup; retained database:', database);
      process.exitCode = 1;
    }
  }
  await admin.end();
}
if (!process.exitCode) console.log(`PASS ALL: ${passed} PostgreSQL checks; production database was not connected`);
