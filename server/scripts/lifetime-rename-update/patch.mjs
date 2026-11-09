import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const changes = JSON.parse(await readFile(new URL('./patch.json', import.meta.url), 'utf8'));
export const files = [...new Set(changes.map(change => change.file))];

// Only replaces the quoted text literals; already-renamed literals are skipped so the patch can be rerun.
export function patchFile(source, file) {
  let result = source;
  for (const { before, after } of changes.filter(change => change.file === file)) {
    assert.ok(before && after && before !== after, 'Invalid patch');
    const oldCount = result.split(before).length - 1;
    const newCount = result.split(after).length - 1;
    if (oldCount === 0 && newCount === 1) continue;
    assert.equal(oldCount, 1, `${file} differs from the supported version; no files changed`);
    assert.equal(newCount, 0, `Ambiguous ${file}; no files changed`);
    result = result.replace(before, () => after);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  assert.ok(input && output, 'Usage: node patch.mjs ORIGINAL_DIR CANDIDATE_DIR');
  assert.notEqual(resolve(input), resolve(output), 'Patch must be prepared separately from the live files');
  for (const file of files) {
    await writeFile(join(output, file), patchFile(await readFile(join(input, file), 'utf8'), file));
  }
  console.log(`PASS: prepared lifetime rename for ${files.join(', ')}`);
}
