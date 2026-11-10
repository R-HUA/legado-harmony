import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { configureTestEnvironment, checkSourceQuota } from './source-pg-concurrency.mjs';

configureTestEnvironment('postgresql://test:test@127.0.0.1:1/unused');
const { pool, inTransaction } = await import('../dist/db.js');
const { config } = await import('../dist/config.js');
const { exchangeSync } = await import('../dist/sync.js');
const cloud = await import('../dist/cloudFileService.js');
const membership = await import('../dist/membershipService.js');

test('shared cloud/source cap and tier limits through the real sync transaction path', async t => {
  const db = new PGlite();
  t.after(async () => { await db.close(); await pool.end(); });
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(n => /^\d{3}_.+\.sql$/.test(n)).sort()) {
    await db.exec((await readFile(new URL(name, migrations), 'utf8')).replace(/^VACUUM[^;]*;/gm, ''));
  }
  // Local validation serializes entire BEGIN..COMMIT lifetimes on PGlite's one connection.
  let tail = Promise.resolve();
  t.mock.method(pool, 'connect', async () => {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    return { query: db.query.bind(db), release };
  });
  let passed = 0;
  await checkSourceQuota({ db, tx: inTransaction, exchangeSync, config, cloud, membership,
    race: jobs => Promise.allSettled(jobs.map(job => job())),
    report(label, done) { if (done) { passed++; t.diagnostic(`PASS fixture: ${label}`); } }
  });
  assert.equal(passed, 8);
});
