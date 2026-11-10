// Confirms the candidates only differ from the originals by the renamed literals, then loads the real product catalog.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { changes, files } from './patch.mjs';

const [original, candidate] = process.argv.slice(2);
assert.ok(original && candidate, 'Usage: node check.mjs ORIGINAL_DIR CANDIDATE_DIR');
for (const file of files) {
  const before = await readFile(join(original, file), 'utf8');
  const after = await readFile(join(candidate, file), 'utf8');
  let restored = after;
  for (const change of changes.filter(item => item.file === file)) {
    assert.equal(after.split(change.after).length - 1, 1, `${file} missing ${change.after}`);
    restored = restored.replace(change.after, () => change.before);
  }
  // Rerunning on an already patched file leaves nothing to restore; otherwise the rest of the file must be untouched.
  if (before !== after) assert.equal(restored, before, `${file} has unexpected changes`);
  assert.doesNotMatch(after, /永久(超级)?会员/, `${file} still contains the old tier name`);
}
// membershipPolicy.js has no imports, so it loads as a data URL regardless of the backup folder's package type.
const policy = await readFile(join(candidate, 'membershipPolicy.js'), 'utf8');
const { MEMBERSHIP_PRODUCTS } = await import(`data:text/javascript;base64,${Buffer.from(policy).toString('base64')}`);
assert.deepEqual(MEMBERSHIP_PRODUCTS.map(product => [product.sku, product.name, product.points]), [
  ['MONTHLY', '月度会员', 60], ['ANNUAL', '年度会员', 480],
  ['LIFETIME', '终身会员', 1290], ['SUPER_LIFETIME', '终身超级会员', 2490]
]);
console.log('PASS: only tier-name literals changed; catalog names are 终身会员 / 终身超级会员, prices unchanged');
