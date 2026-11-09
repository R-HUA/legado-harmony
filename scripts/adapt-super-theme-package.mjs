import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const base = path.join(root, 'output/super-theme-live-baseline');
const original = path.join(root, 'output/releases/qingye-super-theme-20261022');
const name = 'qingye-super-theme-20261022-v2';
const out = path.join(root, 'output/releases', name);
const digest = data => createHash('sha256').update(data).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
const manifest = JSON.parse(read(path.join(original, 'manifest.json')));
const liveHash = digest(fs.readFileSync(path.join(base, 'index.js')));
assert.equal(liveHash, '75ad78f3ef11014d2ca62fe4cf4b91261978651bf648f6ed24e8a35733e6373c');

// Prove every entry-point difference is the intended query change or these two comments.
const after = `"SELECT theme_id FROM theme_catalog WHERE member_included = TRUE AND acquisition = 'POINTS'"`;
const before = `'SELECT theme_id FROM theme_catalog WHERE member_included = TRUE'`;
const comment = '    // The plugin throws this value. Return the typed error our handler maps to 429,\n' +
  '    // with numeric seconds; a plain object would fall through to INTERNAL_ERROR/500.\n';
const candidate = read(path.join(original, 'server/index.js'));
assert.equal(candidate.split(after).length, 2);
assert.equal(candidate.split(comment).length, 2);
assert.equal(candidate.replace(after, before).replace(comment, ''), read(path.join(base, 'index.js')));
for (const file of ['membershipRoutes.js', 'themeCatalog.js']) {
  assert(manifest.acceptedBaselines[file].includes(digest(fs.readFileSync(path.join(base, file)))), `${file}: unexpected baseline`);
}
for (const file of ['membershipPolicy.js', 'membershipService.js']) {
  assert.deepEqual(fs.readFileSync(path.join(base, file)), fs.readFileSync(path.join(root, 'server/dist', file)));
}
const livePackage = JSON.parse(read(path.join(base, 'package.json')));
assert.equal(livePackage.type, 'module');
assert.deepEqual(livePackage.dependencies, JSON.parse(read(path.join(root, 'server/package.json'))).dependencies);

assert(!fs.existsSync(out), 'Versioned output already exists; inspect before rebuilding');
fs.cpSync(original, out, { recursive: true });
manifest.name = name;
manifest.acceptedBaselines['index.js'].push(liveHash);
manifest.verifiedProductionBaseline = Object.fromEntries(
  ['index.js', 'membershipRoutes.js', 'themeCatalog.js', 'membershipPolicy.js', 'membershipService.js', 'package.json']
    .map(file => [file, digest(fs.readFileSync(path.join(base, file)))]));
manifest.baselineArchiveSha256 = digest(fs.readFileSync(path.join(root, 'output/releases/qingye-theme-baseline.cnzT8c.tar.gz')));
manifest.validation.baselineComparison = 'Exact index inverse patch with two comment lines removed; other replaced modules match known baselines; membership dependencies byte-identical.';
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'UPDATE.md'), read(path.join(out, 'UPDATE.md'))
  .replaceAll('qingye-super-theme-20261022', name));
fs.writeFileSync(path.join(out, 'BASELINE-REVIEW.md'), `# 线上基线适配记录\n\n` +
  `来源：用户提供的 qingye-theme-baseline.cnzT8c.tar.gz。\n\n` +
  `线上 index.js SHA-256：\`${liveHash}\`。\n\n` +
  `已逐项验证：\n\n` +
  `- 入口文件仅有本次主题库查询修改，以及本地多出的两行限流注释。线上限流修复保留。\n` +
  `- membershipRoutes.js、themeCatalog.js 与原包已支持的旧版本摘要一致。\n` +
  `- membershipPolicy.js、membershipService.js 与已测试构建逐字节一致，不替换这两个模块。\n` +
  `- package.json 的运行依赖与已测试构建一致，不更换配置或安装依赖。\n\n` +
  `v2 的四个运行模块和迁移文件与第一版完全相同，仅增加已核实的线上入口版本摘要、更新说明和本记录。校验没有被关闭，未知版本仍会拒绝。\n`);
function entries(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ?
    entries(path.join(dir, e.name), prefix + e.name + '/') : [prefix + e.name]);
}
fs.writeFileSync(path.join(out, 'SHA256SUMS'), entries(out).filter(file => file !== 'SHA256SUMS').sort()
  .map(file => digest(fs.readFileSync(path.join(out, file))) + '  ' + file).join('\n') + '\n');
for (const file of manifest.runtimeFiles) {
  assert.deepEqual(fs.readFileSync(path.join(original, 'server', file)), fs.readFileSync(path.join(out, 'server', file)));
  execFileSync(process.execPath, ['--check', path.join(out, 'server', file)]);
}
execFileSync(process.execPath, [path.join(out, 'check.mjs'), 'baseline', base, out, base], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(out, 'check.mjs'), 'baseline', path.join(out, 'server'), out, path.join(out, 'server')], { stdio: 'inherit' });
const invalid = path.join(root, 'output/super-theme-package-baseline');
assert.notEqual(digest(fs.readFileSync(path.join(invalid, 'index.js'))), liveHash);
let refused = false;
try { execFileSync(process.execPath, [path.join(out, 'check.mjs'), 'baseline', invalid, out, invalid], { stdio: 'pipe' }); }
catch { refused = true; }
assert(refused, 'Unknown baseline must still be refused');
console.log('PASS: exact live baseline accepted, installed version accepted, unknown version rejected; runtime payload unchanged');
console.log(out);
