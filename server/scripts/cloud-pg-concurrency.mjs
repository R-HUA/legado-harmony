// Run via stdin as postgres, from the deployed application root.
// All business writes target a newly-created empty database. Object storage is in memory.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function checkCloudConcurrency({ db, tx, race, cloud, membership, report }) {
  const { CloudFileService, CLOUD_QUOTA_BYTES: quota } = cloud;
  const { quoteMembership, purchaseMembership } = membership;
  let clock = Date.now(), failSign = false;
  const objects = new Map();
  const hash = (body, algorithm = 'sha256') => createHash(algorithm).update(body).digest('hex');
  const store = {
    signUpload: key => `https://objects.invalid/${key}`,
    signDownload(key) {
      if (failSign) throw Object.assign(new Error('test signing failure'), { code: 'TEST_SIGN_FAILURE' });
      return `https://objects.invalid/${key}`;
    },
    async head(key) {
      const body = objects.get(key);
      assert.ok(body, 'test object missing');
      return { bytes: body.length, etag: `"${hash(body, 'md5')}"` };
    },
    async copy(source, target, etag) {
      const body = objects.get(source);
      assert.ok(body);
      assert.equal(etag, `"${hash(body, 'md5')}"`);
      objects.set(target, Buffer.from(body));
    },
    async delete(key) { objects.delete(key); }
  };
  const service = new CloudFileService(tx, store, () => clock);
  // Each contender gets its own transaction runner; this also models multiple service instances.
  const compete = jobs => race(jobs.map(job => runner => job(new CloudFileService(runner, store, () => clock))));
  const eight = job => Array.from({ length: 8 }, (_, i) => svc => job(svc, i));
  const input = (bytes, requestId = randomUUID()) => ({ requestId, kind: 'BOOK', name: 'quota-test.txt', bytes });
  const count = async (table, id) => Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE user_id=$1`, [id])).rows[0].n);
  const allSuccess = results => {
    assert.equal(results.length, 8);
    for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.code);
  };
  const split = (results, accepted, error) => {
    assert.equal(results.filter(r => r.status === 'fulfilled').length, accepted);
    for (const r of results.filter(r => r.status === 'rejected')) assert.equal(r.reason.code, error);
  };
  async function user() {
    const id = randomUUID();
    await db.query('INSERT INTO app_users(id,huawei_open_id) VALUES($1,$2)', [id, id]);
    await db.query('INSERT INTO point_wallets(user_id,balance,paid_balance) VALUES($1,10000,10000)', [id]);
    const quote = await tx(c => quoteMembership(c, id, 'SUPER_LIFETIME', clock));
    await tx(c => purchaseMembership(c, id, quote.quoteId, randomUUID(), clock));
    return id;
  }
  async function readyFile(id) {
    const body = Buffer.from('abc');
    const file = await service.prepare(id, input(body.length));
    const ticket = await service.uploadTicket(id, file.id, { index: 0, bytes: body.length,
      sha256: hash(body), md5: createHash('md5').update(body).digest('base64') });
    objects.set(new URL(ticket.url).pathname.slice(1), body);
    await service.confirmChunk(id, file.id, 0);
    await service.complete(id, file.id);
    return file.id;
  }

  // Only the isolated test DB is passed into this function.
  await db.query('UPDATE membership_products SET sales_enabled=true');

  let step = '8 competing reservations cannot exceed storage quota';
  report(step);
  const full = await user();
  split(await compete(eight(s => s.prepare(full, input(quota / 4)))), 4, 'CLOUD_STORAGE_LIMIT');
  assert.equal((await service.summary(full)).usedBytes, quota);
  assert.equal(await count('cloud_files', full), 4);
  report(step, true);

  step = '8 identical upload requests reserve storage once'; report(step);
  const retry = await user(), same = input(4096);
  const repeated = await compete(eight(s => s.prepare(retry, same)));
  allSuccess(repeated);
  assert.equal(new Set(repeated.map(r => r.value.id)).size, 1);
  assert.equal((await service.summary(retry)).usedBytes, 4096);
  assert.equal(await count('cloud_files', retry), 1);
  report(step, true);

  step = 'competing uploads respect pending task limit'; report(step);
  const pending = await user();
  for (let i = 0; i < 9; i++) await service.prepare(pending, input(1));
  split(await compete(eight(s => s.prepare(pending, input(1)))), 1, 'CLOUD_PENDING_LIMIT');
  assert.equal(await count('cloud_files', pending), 10);
  assert.equal((await service.summary(pending)).usedBytes, 10);
  report(step, true);

  step = '8 identical download requests debit once'; report(step);
  const owner = await user(), file = await readyFile(owner), requestId = randomUUID();
  const downloads = await compete(eight(s => s.downloadTicket(owner, file, 0, requestId)));
  allSuccess(downloads);
  assert.equal(new Set(downloads.map(r => r.value.expiresAt)).size, 1);
  assert.equal((await service.summary(owner)).downloadBytes, 3);
  assert.equal(await count('cloud_download_tickets', owner), 1);
  report(step, true);

  step = 'competing download requests cannot exceed monthly quota'; report(step);
  await db.query('UPDATE cloud_download_monthly_usage SET bytes=$2 WHERE user_id=$1', [owner, quota - 6]);
  split(await compete(eight(s => s.downloadTicket(owner, file, 0, randomUUID()))), 2, 'CLOUD_TRAFFIC_LIMIT');
  assert.equal((await service.summary(owner)).downloadBytes, quota);
  assert.equal(await count('cloud_download_tickets', owner), 3);
  // A retry still succeeds at the cap without another charge.
  await service.downloadTicket(owner, file, 0, requestId);
  assert.equal((await service.summary(owner)).downloadBytes, quota);
  report(step, true);

  step = 'failed signing rolls back competing charges and tickets'; report(step);
  const rollback = await user(), rollbackFile = await readyFile(rollback);
  failSign = true;
  try {
    split(await compete(eight(s => s.downloadTicket(rollback, rollbackFile, 0, randomUUID()))), 0, 'TEST_SIGN_FAILURE');
  } finally { failSign = false; }
  assert.equal(await count('cloud_download_tickets', rollback), 0);
  assert.equal(await count('cloud_download_monthly_usage', rollback), 0);
  await service.downloadTicket(rollback, rollbackFile, 0, randomUUID());
  assert.equal((await service.summary(rollback)).downloadBytes, 3);
  report(step, true);

  step = 'foreign account cannot download or delete another account file'; report(step);
  const foreign = await user();
  split(await compete(eight(s => s.downloadTicket(foreign, file, 0, randomUUID()))), 0, 'CLOUD_FILE_NOT_FOUND');
  allSuccess(await compete(eight(s => s.remove(foreign, file))));
  assert.equal(await count('cloud_download_tickets', foreign), 0);
  assert.equal(await count('cloud_download_monthly_usage', foreign), 0);
  assert.equal((await service.manifest(owner, file)).state, 'READY');
  report(step, true);

  step = 'concurrent deletes retain reservation until upload expiry and release once'; report(step);
  allSuccess(await compete(eight(s => s.remove(owner, file))));
  assert.equal((await service.manifest(owner, file)).state, 'DELETING');
  assert.equal((await service.summary(owner)).usedBytes, 3);
  assert.equal([...objects.keys()].filter(key => key.includes(`/${file}/`)).length, 2);
  clock += 120000 + 300000 + 1;
  allSuccess(await compete(eight(s => s.remove(owner, file))));
  assert.equal(await count('cloud_files', owner), 0);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM cloud_chunks WHERE file_id=$1', [file])).rows[0].n), 0);
  assert.equal([...objects.keys()].filter(key => key.includes(`/${file}/`)).length, 0);
  assert.equal((await service.summary(owner)).usedBytes, 0);
  assert.equal((await service.summary(owner)).downloadBytes, quota, 'deletion must not refund issued downloads');
  report(step, true);
}

async function main() {
  const root = process.cwd();
  const require = createRequire(resolve(root, 'package.json'));
  const pg = require('pg');
  const cloud = await import(pathToFileURL(resolve(root, 'cloudFileService.js')).href);
  const membership = await import(pathToFileURL(resolve(root, 'membershipService.js')).href);
  const database = 'qingye_cloud_test_' + randomUUID().replaceAll('-', '');
  const connection = { host: '/tmp', port: 5432, user: 'postgres', connectionTimeoutMillis: 10000,
    statement_timeout: 20000, lock_timeout: 10000, idle_in_transaction_session_timeout: 30000 };
  const admin = new pg.Client({ ...connection, database: 'postgres' });
  let pool, created = false, step = 'connect local PostgreSQL', passed = 0;
  async function tx(work) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; }
    finally { c.release(); }
  }
  async function race(jobs) {
    let arrived = 0, release;
    const pids = new Set();
    const gate = new Promise(resolveGate => { release = resolveGate; });
    const timer = setTimeout(() => release(), 12000);
    try {
      return await Promise.allSettled(jobs.map(job => {
        let first = true;
        return job(work => tx(async c => {
          if (first) {
            first = false;
            pids.add((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
            if (++arrived === jobs.length) release();
            await gate;
            assert.equal(arrived, jobs.length, 'concurrent start barrier timed out');
            assert.equal(pids.size, jobs.length, 'contenders must use independent PostgreSQL sessions');
          }
          return work(c);
        }));
      }));
    } finally { clearTimeout(timer); }
  }
  try {
    await admin.connect();
    step = 'create disposable database';
    assert.match(database, /^qingye_cloud_test_[a-f0-9]{32}$/);
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
      await pool.query((await readFile(resolve(root, 'migrations', file), 'utf8')).replace(/^VACUUM[^;]*;/gm, ''));
    }
    await checkCloudConcurrency({ db: pool, tx, race, cloud, membership, report(label, done) {
      step = label;
      if (done) { passed++; console.log('PASS', label); }
    } });
  } catch (error) {
    const code = String(error.code || 'CHECK_FAILED');
    console.error('FAIL', step, /^[A-Z0-9_]+$/.test(code) ? code : 'CHECK_FAILED');
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
    if (created) {
      try {
        assert.match(database, /^qingye_cloud_test_[a-f0-9]{32}$/);
        await admin.query(`DROP DATABASE "${database}"`);
        console.log('PASS temporary database removed');
      } catch {
        console.error('FAIL temporary database cleanup; retained database:', database);
        process.exitCode = 1;
      }
    }
    await admin.end();
  }
  if (!process.exitCode) console.log(`PASS ALL: ${passed} PostgreSQL checks; production database and OBS were not accessed`);
}

// Direct invocation or the documented stdin invocation. Importing only exposes the fixture checks.
if (!process.argv[1] || resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error('FAIL test setup', /^[A-Z0-9_]+$/.test(String(error.code)) ? error.code : 'CHECK_FAILED');
    process.exitCode = 1;
  });
}
