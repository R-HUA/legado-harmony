// Test deployed/candidate sync.js with an empty disposable database and no real external services.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function configureTestEnvironment(databaseUrl) {
  // Overwrite (never inherit) connection/auth settings before importing config/db/sync.
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, SESSION_SECRET: 'isolated-test-session-secret-not-for-production',
    HUAWEI_CLIENT_ID: 'test', HUAWEI_CLIENT_SECRET: 'test', HUAWEI_APP_ID: 'test',
    HUAWEI_IAP_KEY_ID: 'test', HUAWEI_IAP_ISSUER_ID: 'test',
    HUAWEI_IAP_PRIVATE_KEY_PATH: 'unused-test.pem', HUAWEI_IAP_ROOT_CA_PATH: 'unused-test.pem',
    HUAWEI_IAP_ROOT_URL: 'https://unused.invalid', HUAWEI_IAP_DELIVERABLE_STATUSES: '0,PAID',
    MEMBERSHIP_ENABLED: 'true', MEMBERSHIP_SOURCE_LIMITS_ENABLED: 'false', CLOUD_FILES_ENABLED: 'true'
  });
}

export async function checkSourceQuota({ db, tx, race, exchangeSync, config, cloud, membership, report }) {
  const { CloudFileService, CLOUD_QUOTA_BYTES: quota } = cloud;
  const { quoteMembership, purchaseMembership } = membership;
  const never = () => { throw new Error('Unexpected object storage access'); };
  const service = new CloudFileService(tx, {
    signUpload: never, signDownload: never, head: never, copy: never, delete: never
  });
  await db.query('UPDATE membership_products SET sales_enabled=true');
  async function user(sku = '') {
    const id = randomUUID();
    await db.query('INSERT INTO app_users(id,huawei_open_id) VALUES($1,$2)', [id, id]);
    if (sku) {
      await db.query('INSERT INTO point_wallets(user_id,balance,paid_balance) VALUES($1,10000,10000)', [id]);
      const quote = await tx(c => quoteMembership(c, id, sku));
      await tx(c => purchaseMembership(c, id, quote.quoteId, randomUUID()));
    }
    return { id, deviceId: randomUUID() };
  }
  const operation = (entityId, payload, baseRevision = 0) => ({ opId: randomUUID(), entityType: 'book_source',
    entityId, baseRevision, operation: payload === null ? 'delete' : 'upsert', payload });
  const sync = (account, operations) => exchangeSync(account.id, { protocolVersion: 1,
    deviceId: account.deviceId, cursor: 0, operations });
  const upload = (account, bytes) => service.prepare(account.id, {
    requestId: randomUUID(), kind: 'BOOK', name: 'shared-quota.txt', bytes
  });
  const sourceCount = async account => Number((await db.query(`SELECT count(*) AS n FROM sync_entities
    WHERE user_id=$1 AND entity_type='book_source' AND deleted_at IS NULL`, [account.id])).rows[0].n);
  const accepted = reply => { assert.equal(reply.acknowledgements.length, 1); return reply.acknowledgements[0]; };
  const payload = { rules: 'x'.repeat(4096) };
  const size = Number((await db.query('SELECT octet_length($1::jsonb::text) AS n', [JSON.stringify(payload)])).rows[0].n);

  let step = 'cloud cap applies with source-tier limits disabled; shrink/delete remain usable'; report(step);
  config.membershipSourceLimitsEnabled = false;
  const owner = await user('SUPER_LIFETIME');
  assert.equal(accepted(await sync(owner, [operation('existing', payload)])).accepted, true);
  await upload(owner, quota - size);
  const rejected = accepted(await sync(owner, [operation('extra', payload)]));
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.error.code, 'SYNC_SOURCE_QUOTA_EXCEEDED');
  assert.equal((await service.summary(owner.id)).usedBytes, quota);
  assert.equal((await sync(owner, [])).changes.length, 1, 'existing source remains downloadable');
  const smaller = { rules: 'x' };
  assert.equal(accepted(await sync(owner, [operation('existing', smaller, 1)])).accepted, true);
  assert.equal(accepted(await sync(owner, [operation('existing', null, 2)])).accepted, true);
  assert.equal((await service.summary(owner.id)).usedBytes, quota - size);
  await upload(owner, size);
  assert.equal((await service.summary(owner.id)).usedBytes, quota);
  report(step, true);

  for (const enabled of [false, true]) {
    step = `8 mixed source/file requests share one storage cap (source limits ${enabled ? 'on' : 'off'})`; report(step);
    config.membershipSourceLimitsEnabled = enabled;
    const account = await user('SUPER_LIFETIME');
    await upload(account, quota - size * 2);
    const jobs = Array.from({ length: 8 }, (_, i) => async () => {
      if (i % 2) return { accepted: true, file: await upload(account, size) };
      return accepted(await sync(account, [operation(`source_${i}`, payload)]));
    });
    const results = await race(jobs);
    assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.accepted).length, 2);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        assert.equal(i % 2, 1);
        assert.equal(r.reason.code, 'CLOUD_STORAGE_LIMIT');
      } else if (!r.value.accepted) {
        assert.equal(i % 2, 0);
        assert.equal(r.value.error.code, 'SYNC_SOURCE_QUOTA_EXCEEDED');
      }
    });
    assert.equal((await service.summary(account.id)).usedBytes, quota);
    const sources = await sourceCount(account);
    const files = Number((await db.query('SELECT count(*) AS n FROM cloud_files WHERE user_id=$1', [account.id])).rows[0].n);
    assert.equal(sources + files, 3);
    report(step, true);
  }

  for (const [sku, limit] of [['', 50], ['MONTHLY', 500]]) {
    step = `8 source requests respect ${limit}-source account limit`; report(step);
    config.membershipSourceLimitsEnabled = true;
    const account = await user(sku);
    for (let i = 0; i < limit - 1; i += 100) {
      const batch = Array.from({ length: Math.min(100, limit - 1 - i) }, (_, j) => operation(`seed_${i + j}`, { rules: 'x' }));
      const response = await sync(account, batch);
      assert.ok(response.acknowledgements.every(a => a.accepted));
    }
    const results = await race(Array.from({ length: 8 }, (_, i) => async () =>
      accepted(await sync(account, [operation(`race_${i}`, { rules: 'x' })]))));
    assert.ok(results.every(r => r.status === 'fulfilled'));
    assert.equal(results.filter(r => r.value.accepted).length, 1);
    for (const r of results.filter(r => !r.value.accepted)) assert.equal(r.value.error.code, 'SYNC_SOURCE_QUOTA_EXCEEDED');
    assert.equal(await sourceCount(account), limit);
    report(step, true);
  }

  step = 'disabled source-tier limits preserve free-account behavior; old excess sources may shrink'; report(step);
  config.membershipSourceLimitsEnabled = false;
  const free = await user();
  const seed = Array.from({ length: 51 }, (_, i) => operation(`legacy_${i}`, { rules: 'x' }));
  seed[0].payload = { rules: 'x'.repeat(70 * 1024) };
  assert.ok((await sync(free, seed)).acknowledgements.every(a => a.accepted));
  config.membershipSourceLimitsEnabled = true;
  assert.equal(accepted(await sync(free, [operation('legacy_0', { rules: 'x'.repeat(60 * 1024) }, 1)])).accepted, true);
  assert.equal(accepted(await sync(free, [operation('legacy_0', { rules: 'x'.repeat(71 * 1024) }, 2)])).error.code, 'SYNC_SOURCE_QUOTA_EXCEEDED');
  assert.equal(await sourceCount(free), 51);
  assert.equal(accepted(await sync(free, [operation('legacy_0', null, 2)])).accepted, true);
  assert.equal(await sourceCount(free), 50);
  report(step, true);

  step = 'only active super members sync single sources above 512 KiB, within the technical ceiling'; report(step);
  config.membershipSourceLimitsEnabled = false;
  const large = { rules: 'x'.repeat(700 * 1024) };
  const annual = await user('ANNUAL');
  await assert.rejects(sync(annual, [operation('large', large)]),
    { statusCode: 413, code: 'SYNC_PAYLOAD_TOO_LARGE', message: '单项同步数据不能超过 512KB' });
  const superAccount = await user('SUPER_LIFETIME');
  assert.equal(accepted(await sync(superAccount, [operation('large', large)])).accepted, true);
  await assert.rejects(sync(superAccount, [operation('huge', { rules: 'x'.repeat(1000 * 1024) })]),
    { statusCode: 413, code: 'SYNC_PAYLOAD_TOO_LARGE', message: '单项同步数据不能超过 960KB' });
  assert.equal(await sourceCount(superAccount), 1);
  report(step, true);

  step = 'legacy clients receive their account limit even above the super-member ceiling'; report(step);
  const exactPayload = bytes => ({ rules: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify({ rules: '' }))) });
  const legacySync = (account, operations) => exchangeSync(account.id, { protocolVersion: 1,
    appVersion: '3.0.0', deviceId: account.deviceId, cursor: 0, operations });
  const ordinaryError = { statusCode: 413, code: 'SYNC_PAYLOAD_TOO_LARGE', message: '单项同步数据不能超过 512KB' };
  for (const sku of ['', 'MONTHLY', 'ANNUAL', 'LIFETIME']) {
    const account = await user(sku);
    assert.equal(accepted(await legacySync(account, [operation('boundary', exactPayload(512 * 1024))])).accepted, true);
    for (const bytes of [512 * 1024 + 1, 960 * 1024, 960 * 1024 + 1, 1000 * 1024]) {
      // Preserve all-or-nothing rejection: the valid operation in this batch must not be saved either.
      await assert.rejects(legacySync(account, [operation('small', { rules: 'x' }),
        operation('too_large', exactPayload(bytes))]), ordinaryError);
      assert.equal(await sourceCount(account), 1);
    }
  }
  assert.equal(accepted(await legacySync(superAccount,
    [operation('boundary', exactPayload(960 * 1024))])).accepted, true);
  await assert.rejects(legacySync(superAccount, [operation('too_large', exactPayload(960 * 1024 + 1))]),
    { statusCode: 413, code: 'SYNC_PAYLOAD_TOO_LARGE', message: '单项同步数据不能超过 960KB' });
  // Disabling the membership system must also restore the legacy 512 KiB ceiling and message.
  config.membershipEnabled = false;
  try {
    await assert.rejects(legacySync(superAccount, [operation('disabled', exactPayload(1000 * 1024))]), ordinaryError);
  } finally {
    config.membershipEnabled = true;
  }
  report(step, true);
}

async function main() {
  const root = process.cwd(), require = createRequire(resolve(root, 'package.json'));
  const pg = require('pg');
  const database = 'qingye_source_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Client({ host: '/tmp', port: 5432, user: 'postgres', database: 'postgres',
    connectionTimeoutMillis: 10000, statement_timeout: 20000 });
  let pool, created = false, passed = 0, step = 'create disposable database';
  try {
    await admin.connect();
    assert.match(database, /^qingye_source_test_[a-f0-9]{32}$/);
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    created = true;
    console.log('Temporary database:', database);
    configureTestEnvironment(`postgresql://postgres@localhost/${database}?host=%2Ftmp`);
    const load = name => import(pathToFileURL(resolve(root, name)).href);
    const dbModule = await load('db.js'); pool = dbModule.pool;
    pool.on('error', () => { console.error('FAIL idle test connection'); process.exitCode = 1; });
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, database);
    step = 'migrate empty test database';
    const files = (await readdir(resolve(root, 'migrations'))).filter(n => /^\d{3}_.+\.sql$/.test(n)).sort();
    assert.ok(files.includes('016_memberships.sql') && files.includes('018_cloud_direct_transfers.sql'));
    for (const file of files) await pool.query((await readFile(resolve(root, 'migrations', file), 'utf8')).replace(/^VACUUM[^;]*;/gm, ''));

    // Synchronize the first connection of each request; all queries still use the real application transaction path.
    const requests = new AsyncLocalStorage();
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await connect(), request = requests.getStore();
      if (request && !request.started) {
        request.started = true;
        try {
          request.group.pids.add((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          if (++request.group.arrived === request.group.total) request.group.release();
          await request.group.gate;
          assert.equal(request.group.arrived, request.group.total);
          assert.equal(request.group.pids.size, request.group.total);
        } catch (error) { client.release(); throw error; }
      }
      return client;
    };
    async function race(jobs) {
      const group = { arrived: 0, total: jobs.length, pids: new Set(), release: null, gate: null };
      group.gate = new Promise(resolveGate => { group.release = resolveGate; });
      const timer = setTimeout(() => group.release(), 10000);
      try { return await Promise.allSettled(jobs.map(job => requests.run({ started: false, group }, job))); }
      finally { clearTimeout(timer); }
    }
    // Fixture queries use the original connect, so only service requests join the barrier.
    const queryAdapter = { query: async (...args) => {
      const client = await connect();
      try { return await client.query(...args); } finally { client.release(); }
    } };
    const { config } = await load('config.js');
    const { exchangeSync } = await load('sync.js');
    await checkSourceQuota({ db: queryAdapter, tx: dbModule.inTransaction, race, exchangeSync, config,
      cloud: await load('cloudFileService.js'), membership: await load('membershipService.js'),
      report(label, done) { step = label; if (done) { passed++; console.log('PASS', label); } }
    });
  } catch (error) {
    const code = String(error.code || 'CHECK_FAILED');
    console.error('FAIL', step, /^[A-Z0-9_]+$/.test(code) ? code : 'CHECK_FAILED');
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
    if (created) {
      try {
        assert.match(database, /^qingye_source_test_[a-f0-9]{32}$/);
        await admin.query(`DROP DATABASE "${database}"`);
        console.log('PASS temporary database removed');
      } catch { console.error('FAIL cleanup; retained database:', database); process.exitCode = 1; }
    }
    await admin.end();
  }
  if (!process.exitCode) console.log(`PASS ALL: ${passed} PostgreSQL checks; production database and OBS were not accessed`);
}

if (!process.argv[1] || resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => { console.error('FAIL test setup'); process.exitCode = 1; });
}
