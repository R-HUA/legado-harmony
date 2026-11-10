// Local fixture validation only. PGlite serializes transactions; it cannot prove concurrency safety.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import * as cloud from '../dist/cloudFileService.js';
import * as membership from '../dist/membershipService.js';
import { checkCloudConcurrency } from './cloud-pg-concurrency.mjs';

const db = new PGlite();
let passed = 0;
try {
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(n => /^\d{3}_.+\.sql$/.test(n)).sort()) {
    await db.exec((await readFile(new URL(name, migrations), 'utf8')).replace(/^VACUUM[^;]*;/gm, ''));
  }
  const tx = work => db.transaction(c => work({ query: c.query.bind(c) }));
  await checkCloudConcurrency({ db, tx, cloud, membership,
    race: jobs => Promise.allSettled(jobs.map(job => job(tx))),
    report(label, done) { if (done) { passed++; console.log('PASS fixture:', label); } }
  });
  assert.equal(passed, 8);
  console.log('PASS all 8 fixtures; independent PostgreSQL concurrency remains a separate server check');
} finally { await db.close(); }
