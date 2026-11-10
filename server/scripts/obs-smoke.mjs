// Run explicitly with the server's OBS environment. Never logs credentials or signed URLs.
import { createHash, randomUUID } from 'node:crypto';
import { createObsStore } from '../dist/cloudObjectStore.js';

const md5 = body => createHash('md5').update(body).digest('base64');
const hex = body => createHash('md5').update(body).digest('hex');
const e = process.env;
let store;
try {
  for (const key of ['ENDPOINT', 'REGION', 'BUCKET', 'AK', 'SK']) {
    if (!e['HUAWEICLOUD_OBS_' + key]) throw new Error('Missing config');
  }
  store = createObsStore({ endpoint: e.HUAWEICLOUD_OBS_ENDPOINT,
    region: e.HUAWEICLOUD_OBS_REGION, bucket: e.HUAWEICLOUD_OBS_BUCKET,
    ak: e.HUAWEICLOUD_OBS_AK, sk: e.HUAWEICLOUD_OBS_SK });
} catch {
  console.error('OBS configuration missing or invalid; no request sent');
  process.exit(1);
}

const suffix = 'v1/_connection-test/' + randomUUID() + '/';
const staging = 'qingye/staging/' + suffix + '0';
const target = 'qingye/' + suffix + '0';
const wrongMd5 = 'qingye/staging/' + suffix + 'wrong-md5';
const staleTarget = 'qingye/' + suffix + 'stale';
const keys = [staging, target, wrongMd5, staleTarget];
const original = Buffer.from('qingye-obs-connection-test');
let step = 'upload';
let unverifiedAbsence = 0;

async function upload(key, body, checksum = md5(body)) {
  const response = await fetch(store.signUpload(key, checksum, 120), {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-MD5': checksum },
    body, redirect: 'error', signal: AbortSignal.timeout(20000)
  });
  const payload = await response.text();
  return { status: response.status, ok: response.ok,
    code: /<Code>([A-Za-z0-9]+)<\/Code>/.exec(payload)?.[1] };
}
async function checkAbsence(key) {
  try { await store.head(key); } catch (err) {
    if (err.message === 'OBS operation failed (404)') return;
    // Without ListBucket, OBS can mask a missing object with 403. This is
    // inconclusive, not proof of absence and not a failed DeleteObject call.
    if (err.message === 'OBS operation failed (403)') {
      unverifiedAbsence++;
      console.log('WARN absence unverified (HEAD 403):', key);
      return;
    }
    throw err;
  }
  throw new Error('CHECK_FAILED');
}
async function downloadOriginal() {
  const response = await fetch(store.signDownload(target, 60), {
    redirect: 'error', signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  if (!Buffer.from(await response.arrayBuffer()).equals(original)) throw new Error('CHECK_FAILED');
}
try {
  const put = await upload(staging, original);
  if (!put.ok) throw new Error('HTTP ' + put.status);
  console.log('PASS direct upload');
  step = 'metadata';
  const meta = await store.head(staging);
  if (meta.bytes !== original.length || meta.etag.replace(/"/g, '').toLowerCase() !== hex(original)) {
    throw new Error('CHECK_FAILED');
  }
  console.log('PASS size and MD5');
  step = 'conditional copy';
  await store.copy(staging, target, meta.etag);
  console.log('PASS conditional copy');
  step = 'download';
  await downloadOriginal();
  console.log('PASS direct download and content');

  step = 'incorrect MD5 rejection';
  const wrong = await upload(wrongMd5, Buffer.from('different'), md5(original));
  if (wrong.status !== 400 || wrong.code !== 'BadDigest') throw new Error('CHECK_FAILED');
  console.log('PASS incorrect MD5 rejected');
  step = 'incorrect MD5 object absence';
  await checkAbsence(wrongMd5);

  step = 'changed source rejection';
  const changed = await upload(staging, Buffer.from('changed-source-content'));
  if (!changed.ok) throw new Error('HTTP ' + changed.status);
  let rejected = false;
  try { await store.copy(staging, staleTarget, meta.etag); } catch (err) {
    if (err.message !== 'OBS operation failed (412)') throw err;
    rejected = true;
  }
  if (!rejected) throw new Error('CHECK_FAILED');
  await downloadOriginal();
  console.log('PASS stale ETag rejected; published content unchanged');
  step = 'stale copy object absence';
  await checkAbsence(staleTarget);
} catch (err) {
  const message = String(err.message || '');
  const safe = /^(HTTP \d+|OBS operation failed \(\d+\)|CHECK_FAILED)$/.test(message);
  console.error('FAIL', step, safe ? message : 'REQUEST_FAILED');
  process.exitCode = 1;
} finally {
  for (const key of keys) {
    try { await store.delete(key); }
    catch (err) {
      const status = /OBS operation failed \(\d+\)/.exec(String(err.message || ''))?.[0];
      console.error('FAIL delete request:', key, status || 'REQUEST_FAILED');
      process.exitCode = 1;
      continue;
    }
    console.log('PASS delete request:', key);
    try { await checkAbsence(key); }
    catch { console.error('FAIL post-delete verification:', key); process.exitCode = 1; }
  }
}
if (!process.exitCode) {
  console.log('PASS core operations: upload, MD5 rejection, conditional copy, stale ETag rejection, download, delete requests');
  if (unverifiedAbsence) {
    console.log('WARN: independent absence checks remain inconclusive; verify probe keys in the OBS console if needed');
  } else {
    console.log('PASS all absence checks');
  }
}
