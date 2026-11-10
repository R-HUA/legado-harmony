import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function patchSync(source, changes) {
  let result = source.replace(/\r\n/g, '\n');
  for (const { before, after } of changes) {
    assert.ok(before && after && before !== after, 'Invalid patch');
    const oldCount = result.split(before).length - 1;
    const newCount = result.split(after).length - 1;
    if (oldCount === 0 && newCount === 1) continue;
    assert.equal(oldCount, 1, 'Installed sync.js differs from the supported version; no files changed');
    assert.equal(newCount, 0, 'Ambiguous sync.js; no files changed');
    result = result.replace(before, () => after);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  assert.ok(input && output, 'Usage: node patch.mjs INPUT_SYNC_JS OUTPUT_SYNC_JS');
  assert.notEqual(resolve(input), resolve(output), 'Patch must be prepared separately from the live file');
  const changes = JSON.parse(await readFile(new URL('./patch.json', import.meta.url), 'utf8'));
  const result = patchSync(await readFile(input, 'utf8'), changes);
  await writeFile(output, result);
  console.log('PASS: prepared sync size-limit fix');
}
