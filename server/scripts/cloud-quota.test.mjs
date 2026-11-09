import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { checkCloudConcurrency } from './cloud-pg-concurrency.mjs';
import * as cloud from '../dist/cloudFileService.js';
import * as membership from '../dist/membershipService.js';

test('cloud calendar quota: retry, competing requests and signing rollback fixtures', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) {
    await db.exec((await readFile(new URL(file, migrations), 'utf8')).replace(/^VACUUM[^;]*;/gm, ''));
  }
  const tx = work => db.transaction(client => work({ query: client.query.bind(client) }));
  let passed = 0;
  // PGlite serializes these transactions; the standalone fixture additionally tests independent PG sessions.
  await checkCloudConcurrency({ db, tx, cloud, membership,
    race: jobs => Promise.allSettled(jobs.map(job => job(tx))),
    report(label, done) { if (done) { passed++; t.diagnostic(`PASS fixture: ${label}`); } }
  });
  assert.equal(passed, 8);
});
