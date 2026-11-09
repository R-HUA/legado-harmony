// Patch only the two verified defects in the installed runtime; preserve all other deployed code.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function patchIndex(source) {
  assert.match(source, /error instanceof AccountRateLimitError/);
  const fixed = 'errorResponseBuilder: (_request, context) => new AccountRateLimitError(Math.max(1, Math.ceil(context.ttl / 1000)))';
  const old = /errorResponseBuilder:\s*\(_request,\s*context\)\s*=>\s*\(\{\s*code:\s*'RATE_LIMITED',\s*message:\s*'请求过于频繁，请稍后重试',\s*retryAfter:\s*context\.after\s*\}\)/g;
  if (/errorResponseBuilder:\s*\(_request,\s*context\)\s*=>\s*new AccountRateLimitError\(Math\.max\(1,\s*Math\.ceil\(context\.ttl\s*\/\s*1000\)\)\)/.test(source)) return source;
  assert.equal([...source.matchAll(old)].length, 1, 'Unexpected index.js limiter: refuse to patch');
  return source.replace(old, fixed);
}

export function patchCloud(source) {
  if (source.includes("'CLOUD_SOURCE_SYNC_ONLY'")) return source;
  const start = /async prepare\(userId, input\) \{\s*this\.configured\(\);/g;
  assert.equal([...source.matchAll(start)].length, 1, 'Unexpected cloudFileService.js: refuse to patch');
  return source.replace(start, match => match + "\n        if (input?.kind === 'SOURCE') fail(400, 'CLOUD_SOURCE_SYNC_ONLY', '书源请通过数据同步管理，无需上传到云文件');");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [live, output] = process.argv.slice(2);
  assert.ok(live && output, 'Usage: node patch-cloud-files-20261022.mjs LIVE CANDIDATE_DIRECTORY');
  const index = patchIndex(await readFile(resolve(live, 'index.js'), 'utf8'));
  const cloud = patchCloud(await readFile(resolve(live, 'cloudFileService.js'), 'utf8'));
  // Validate both patches before writing either candidate. The caller installs only after syntax checks.
  await writeFile(resolve(output, 'index.js'), index);
  await writeFile(resolve(output, 'cloudFileService.js'), cloud);
  console.log('PASS: prepared targeted cloud-file runtime patches');
}
