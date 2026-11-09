import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { projectRoot } from './lib/ets-module-staging.mjs';

const values = new Map();
const existingPaths = new Set();
const saves = [];
let failSave = false;
const sandbox = vm.createContext({
  AppStorage: { get: key => values.get(key), setOrCreate: (key, value) => values.set(key, value) },
  fs: { accessSync: path => existingPaths.has(path) },
  ReaderSettingsStore: { saveFontSettings: async (...args) => {
    if (failSave) throw new Error('storage unavailable');
    saves.push(args);
  } }
});
for (const file of ['utils/ReaderFontHelper.ets', 'account/CloudFontImport.ets']) {
  const source = fs.readFileSync(`${projectRoot}/entry/src/main/ets/${file}`, 'utf8');
  vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, ''), { mode: 'strip' }), sandbox);
}
const { importer, helper } = vm.runInContext('({ importer: CloudFontImport, helper: ReaderFontHelper })', sandbox);
const cloud = { id: 'd105489a-3d17-4f18-af36-7a15e5e1b3ae', kind: 'FONT', name: '霞鹜文楷.TTF' };
const path = importer.localPath('/files', cloud);
const other = { familyName: 'existing-family', filePath: '/files/local.ttf', sourceName: '本机字体.ttf' };
existingPaths.add(path);
values.set('readerCustomFontsRaw', JSON.stringify({ fonts: [other] }));
values.set('readerFontFilePath', other.filePath);
values.set('readerFontFamily', other.familyName);
values.set('readerFontSourceName', other.sourceName);
values.set('readerFontMode', 'custom');

// Fresh import stores the original Unicode filename, without changing the current selection.
await importer.saveNames({}, '/files', [cloud]);
let fonts = JSON.parse(values.get('readerCustomFontsRaw')).fonts;
assert.equal(fonts.length, 2);
assert.deepEqual(fonts[0], other);
assert.equal(fonts[1].sourceName, cloud.name);
assert.equal(fonts[1].familyName, helper.stableFontFamily(path));
assert.equal(values.get('readerFontSourceName'), other.sourceName);
assert.equal(saves[0][1], other.familyName);
assert.equal(saves[0][2], other.filePath);
assert.equal(saves[0][4], 'custom');
assert.equal(saves[0][6], values.get('readerCustomFontsRaw'));
await importer.saveNames({}, '/files', [cloud]);
assert.equal(saves.length, 1, 'repeat import must be idempotent');

// Upgrade repairs a legacy array record and the selected label, preserving font family/path.
fonts[1].sourceName = path.split('/').pop();
values.set('readerCustomFontsRaw', JSON.stringify(fonts));
values.set('readerFontFilePath', path);
values.set('readerFontFamily', fonts[1].familyName);
values.set('readerFontSourceName', fonts[1].sourceName);
await importer.saveNames({}, '/files', [cloud]);
assert.equal(JSON.parse(values.get('readerCustomFontsRaw')).fonts.length, 2);
assert.equal(values.get('readerFontSourceName'), cloud.name);
assert.equal(saves[1][2], path);

// Deleted/local-missing files must not be resurrected by cloud-list refresh.
existingPaths.delete(path);
await importer.saveNames({}, '/files', [cloud]);
assert.equal(saves.length, 2);
existingPaths.add(path);

// Corrupt metadata and failed persistence must not overwrite the visible font library.
for (const raw of ['{broken', '{"fonts":null}']) {
  values.set('readerCustomFontsRaw', raw);
  await assert.rejects(importer.saveNames({}, '/files', [cloud]));
  assert.equal(values.get('readerCustomFontsRaw'), raw);
}
values.set('readerCustomFontsRaw', JSON.stringify({ fonts: [other] }));
const before = values.get('readerCustomFontsRaw');
failSave = true;
await assert.rejects(importer.saveNames({}, '/files', [cloud]));
assert.equal(values.get('readerCustomFontsRaw'), before);

// Real name resolution hides storage identifiers; ordinary names remain intact.
helper.embeddedFontName = () => '字体内置名称';
assert.equal(helper.resolveDisplayName(path.split('/').pop(), path), '字体内置名称');
assert.equal(helper.resolveDisplayName(cloud.name, path), cloud.name);
assert.equal(helper.isInternalFontName('cloud_my_font.ttf'), false);
assert.equal(importer.uploadName(cloud.name, path), cloud.name);
assert.equal(importer.uploadName('霞鹜文楷', path), '霞鹜文楷.ttf');
assert.equal(importer.uploadName('中文字体.otf', '/files/a.otf'), '中文字体.otf');
assert.equal(importer.uploadName('字体集合.TTC', '/files/a.ttc'), '字体集合.TTC');
assert.equal(importer.localPath('/files', { ...cloud, id: '../escape' }), '');
assert.equal(importer.localPath('/files', { ...cloud, name: 'file.txt' }), '');
console.log('PASS cloud font names: import, persistence, legacy repair, selection, idempotency, missing files, failure handling and upload suffixes');
