// 漫画 AI 着色：本构建不包含（上游着色模型与引擎未以 GPL-3.0 公开）。
// 检查 aiengine 的着色接口全部报告“不支持”、阅读会话保持惰性、Worker 立即关闭，
// 以及长按菜单不再出现“本页着色”且原有索引（保存/分享/重新加载/查看文字）不变。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readEtsModule } from './lib/ets-module-staging.mjs';

const strip = (source) => stripTypeScriptTypes(source.replace(/^import [^;]*;\r?\n/gm, '').replace(/^export /gm, ''),
  { mode: 'strip' });
const engine = vm.createContext({ Map, Set, Error, Promise });
for (const file of ['runtime/AiRuntime.ets', 'core/reader/ComicColorizer.ets', 'core/reader/ReaderComicColorSession.ets']) {
  vm.runInContext(strip(readEtsModule(file)), engine);
}
const { Colorizer, Models, Session } = vm.runInContext(
  '({ Colorizer: ComicColorizer, Models: ComicColorModels, Session: ReaderComicColorSession })', engine);
assert.equal(Colorizer.supported(), false);
assert.equal(Colorizer.memberAllowed(), false);
await assert.rejects(Colorizer.colorize({}, 'image', () => true), /本构建不包含漫画 AI 着色/);
await assert.rejects(Colorizer.colorize({}, 'image', () => false), /已取消/);
await assert.rejects(Colorizer.prepare({}, () => true), /本构建不包含/);
assert.equal(Models.missingBytes({}), 0, '没有模型要下载，界面不会弹下载提示');
const session = new Session();
session.configure({}, 'book', true);
session.setEnabled(true);
session.update([]);
assert.equal(session.active(), false, '着色会话保持惰性');
assert.equal(session.uri('a.png'), '');
assert.equal(session.moving(), false);
assert.equal(typeof session.subscribe(() => {}), 'function');

// Worker 入口：收到端口就关闭，不加载任何模型。
const worker = fs.readFileSync(new URL('../aiengine/Worker.ets', import.meta.url), 'utf8');
assert.match(worker, /startComicColorWorker/);
assert.match(worker, /port\.close\(\)/);
const shipped = fs.readdirSync(new URL('../aiengine/src/main/', import.meta.url), { recursive: true }).join('\n');
assert.doesNotMatch(shipped, /alac|\.ms$|ComicColorWorker/im, '不携带着色模型与着色 Worker');

// 长按菜单：没有着色项；0-3 的动作与原来一致。
let buttons = null, selected = 3, routed = null;
const menu = vm.createContext({ Map, Set, Error,
  router: { async pushUrl(options) { routed = options; } }, HdsFeedback: { showToast() {} },
  ReaderImageMarker: { pendingRaw: () => '', failureReason: () => '' }, ReaderImageResults: { current: () => '' },
  ReaderComicImageExport: { async saveToAlbum() { return true; }, async share() {} },
  ComicColorizer: Colorizer
});
for (const file of ['ComicTextRequests.ts', 'ReaderComicImageActions.ets']) {
  vm.runInContext(strip(fs.readFileSync(new URL('../entry/src/main/ets/core/reader/' + file, import.meta.url), 'utf8')), menu);
}
const Actions = vm.runInContext('ReaderComicImageActions', menu);
const actions = new Actions({
  uiContext: () => ({ getPromptAction: () => ({ async showActionMenu(options) { buttons = options.buttons; return { index: selected }; } }) }),
  abilityContext: () => ({}), accentColor: () => '#007DFF', busy: () => false
});
await actions.showMenu('/comic/original.png', () => {}, '');
assert.deepEqual(Array.from(buttons, b => b.text), ['保存到相册', '分享', '重新加载', '查看本页文字']);
assert.equal(routed.url, 'pages/ComicText');

// 设置页与阅读页面板：着色行只在 supported() 时出现。
for (const file of ['pages/ComicSettings.ets', 'components/reader/ReaderComicSettingsPanels.ets']) {
  const source = fs.readFileSync(new URL('../entry/src/main/ets/' + file, import.meta.url), 'utf8');
  assert.match(source, /if \(ComicColorizer\.supported\(\)\) \{\s*this\.color(?:Default)?Row\(\)/, file);
}
console.log('comic-colorizer-check: colorization stubs report unsupported, session inert, worker closes, UI hides it.');
