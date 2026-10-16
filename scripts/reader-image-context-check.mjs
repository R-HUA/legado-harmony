// 阅读器正文图片与隐藏抓取宿主的离线回归。
//
// 运行：node scripts/reader-image-context-check.mjs
//
// 覆盖两处真机故障：
//   1. 正文图片全部“图片加载失败”：来源声明了浏览器请求头（UA/Referer）时，图片必须带上同一套
//      请求头经应用 HTTP 栈下载（站点对静态文件返回 Cloudflare 403 挑战页），而不是交给渲染器裸链。
//   2. 搜索提示“WebView 抓取环境未挂载”：多个页面各自挂载隐藏宿主时，运行时必须记住全部宿主，
//      前台页面退出后回落到仍然挂载的宿主，而不是把自己置为未挂载。
//
// 平台模块（文件系统/网络/ArkWeb）在此脚本中以替身出现；不解析真实图片、不访问网络、不执行站点脚本。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

function loadSource(relativePath) {
  return fs.readFileSync(new URL('../entry/src/main/ets/' + relativePath, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
}

function evaluate(relativePath, names, bindings) {
  return vm.runInNewContext(stripTypeScriptTypes(loadSource(relativePath), { mode: 'transform' }) +
    '\n;({' + names.join(',') + '})', bindings);
}

/**
 * 同一个 realm 里加载多个模块：BookCoverCache 用 `instanceof ArrayBuffer` 判断响应是否为图片数据，
 * 跨 realm 的 ArrayBuffer 会判为 false，因此测试替身必须在该 realm 内创建二进制数据。
 */
function createRealm(bindings) {
  const context = vm.createContext(bindings);
  return {
    bindings,
    evaluate(relativePath, names) {
      return vm.runInContext(stripTypeScriptTypes(loadSource(relativePath), { mode: 'transform' }) +
        '\n;({' + names.join(',') + '})', context);
    },
    helper(code) {
      return vm.runInContext(code, context);
    }
  };
}

const warnings = [];
const logs = { warn: (...args) => warnings.push(args.join(' ')), info: (...args) => warnings.push(args.join(' ')),
  log() {}, error() {} };

// ---------------------------------------------------------------- 正文图片请求上下文
const written = new Map();
const cacheRoot = '/data/app/cache';
const fsStub = {
  OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4, READ_ONLY: 0 },
  openSync(path) { written.set(path, null); return { fd: path }; },
  writeSync(fd, buffer) { written.set(fd, new Uint8Array(buffer)); },
  closeSync() {},
  accessSync(path) {
    if (!written.has(path) || written.get(path) === null) throw new Error('ENOENT');
    return true;
  },
  mkdirSync() {}
};
const { ComicImagePipeline } = evaluate('core/book/ComicImagePipeline.ts', ['ComicImagePipeline'], {
  console: logs,
  AppStorage: { get: () => cacheRoot, setOrCreate() {} },
  fs: fsStub,
  util: { TextEncoder: class { encodeInto(value) { return new Uint8Array(Array.from(value, c => c.charCodeAt(0))); } } },
  cryptoFramework: {}
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0]);
const CHALLENGE_HTML = new Uint8Array(Buffer.from('<!DOCTYPE html><title>Attention Required! | Cloudflare</title>' +
  '<p>浏览器的安全检查未通过，请稍后重试。</p>', 'utf8'));

function httpStub(reply) {
  const calls = [];
  return {
    calls,
    async executeBinary(request, maxBytes) {
      calls.push({ request, maxBytes });
      return reply(request, calls.length);
    }
  };
}
function headerOf(request, name) {
  for (const key of Object.keys(request.headers || {})) {
    if (key.toLowerCase() === name.toLowerCase()) return request.headers[key];
  }
  return '';
}

const desktopHeader = JSON.stringify({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) linovelib-desktop',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': 'https://www.linovelib.com/',
  'Cookie': 'jieqiUserInfo=secret',
  'Authorization': 'Bearer secret'
});
const linovelib = {
  bookSourceUrl: 'https://www.linovelib.com/',
  header: desktopHeader,
  contentRule: { imageDecode: '' }
};
const chapterUrl = 'https://www.linovelib.com/novel/3765/196481.html';
const illustration = 'https://img3.readpai.com/3/3765/196481/218745.jpg';

// 上下文只带表现型请求头：Cookie/Authorization 不外泄到图片站，Referer 用章节页地址。
{
  const context = ComicImagePipeline.contextFromSource(linovelib, chapterUrl);
  assert.equal(context.referer, chapterUrl, 'Referer 必须是当前章节页');
  assert.equal(context.headers['User-Agent'], 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) linovelib-desktop');
  assert.equal(context.headers['Accept-Language'], 'zh-CN,zh;q=0.9');
  for (const key of Object.keys(context.headers)) {
    assert.ok(!/cookie|authorization/i.test(key), `上下文不得携带 ${key}`);
  }
  const empty = { bookSourceUrl: 'https://example.test/', header: '', contentRule: {} };
  assert.equal(ComicImagePipeline.contextFromSource(empty, chapterUrl).isEmpty(), true,
    '未声明请求头的书源必须保持直链快路径');
  assert.equal(ComicImagePipeline.contextFromSource(
    { bookSourceUrl: 'https://example.test/', header: '{"User-Agent":""}', contentRule: {} }, chapterUrl).isEmpty(),
  true, '空 UA 不构成请求上下文');
  assert.equal(ComicImagePipeline.contextFromSource(
    { bookSourceUrl: 'https://example.test/', header: '@js:java.getHeader()', contentRule: {} }, chapterUrl).isEmpty(),
  true, '动态请求头无法静态判定，不得据此改成裸链下载');
  assert.equal(ComicImagePipeline.contextFromSource(
    { bookSourceUrl: 'https://example.test/', header: "{'User-Agent': 'literal-ua'}", contentRule: {} }, chapterUrl)
    .headers['User-Agent'], 'literal-ua', '字面量请求头也要解析');
  assert.equal(ComicImagePipeline.contextFromSource(linovelib, '').referer, 'https://www.linovelib.com/',
    '没有页面地址时退回书源声明的 Referer');
  assert.equal(ComicImagePipeline.contextFromSource(
    { bookSourceUrl: 'https://example.test/', header: '{"X-Trace":"1"}', contentRule: {} }, chapterUrl).isEmpty(),
  true, '只有无关请求头时不触发下载');
}

// 声明请求头的书源：图片经应用 HTTP 栈下载并落盘，返回本地文件而不是原始地址。
{
  const http = httpStub(() => ({ success: true, statusCode: 200, data: PNG_BYTES, headers: {} }));
  const context = ComicImagePipeline.contextFromSource(linovelib, chapterUrl);
  const path = await ComicImagePipeline.materialize(http, linovelib, illustration, context);
  assert.ok(path.startsWith(cacheRoot + '/comic_images/'), `应返回缓存文件路径：${path}`);
  assert.equal(http.calls.length, 1, '首次必须真正下载');
  const request = http.calls[0].request;
  assert.equal(request.url, illustration);
  assert.equal(headerOf(request, 'User-Agent'), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) linovelib-desktop',
    '图片请求必须沿用书源 UA，否则站点会话/挑战校验不匹配');
  assert.equal(headerOf(request, 'Referer'), chapterUrl, '图片请求必须带章节页 Referer');
  assert.ok(/^image\//.test(headerOf(request, 'Accept')), '图片请求应声明图片 Accept');
  assert.equal(headerOf(request, 'Cookie'), '', '书源 Cookie 不得随图片请求发给第三方图片站');
  assert.ok(written.get(path) && written.get(path).length === PNG_BYTES.length, '缓存文件必须写入完整字节');
  const again = await ComicImagePipeline.materialize(http, linovelib, illustration, context);
  assert.equal(again, path);
  assert.equal(http.calls.length, 1, '命中缓存后不得再次下载');
}

// 站点返回挑战页时保留原始地址（渲染器还有一次机会），并留下可诊断日志。
{
  const http = httpStub(() => ({ success: false, statusCode: 403, data: CHALLENGE_HTML, headers: {},
    error: 'Forbidden' }));
  const context = ComicImagePipeline.contextFromSource(linovelib, chapterUrl);
  const challenged = 'https://img3.readpai.com/3/3765/196481/218746.jpg';
  const before = written.size;
  warnings.length = 0;
  assert.equal(await ComicImagePipeline.materialize(http, linovelib, challenged, context), challenged,
    '下载失败必须回退到原始地址');
  assert.equal(written.size, before, '挑战页字节不得写入图片缓存');
  assert.ok(warnings.some(line => line.includes('图片下载失败') && line.includes('403')),
    '图片下载失败必须留下状态码日志');
}

// 非图片响应（HTTP 200 + 挑战页正文）同样不落盘。
{
  const http = httpStub(() => ({ success: true, statusCode: 200, data: CHALLENGE_HTML, headers: {} }));
  const context = ComicImagePipeline.contextFromSource(linovelib, chapterUrl);
  const other = 'https://img3.readpai.com/3/3765/196481/218799.jpg';
  warnings.length = 0;
  assert.equal(await ComicImagePipeline.materialize(http, linovelib, other, context), other);
  assert.ok(warnings.some(line => line.includes('不是图片')), 'HTTP 200 的挑战页必须被识别为非图片');
}

// 未声明请求头、也没有图片规则/解密规则的书源：不下载，保持原有直链行为。
{
  const http = httpStub(() => ({ success: true, statusCode: 200, data: PNG_BYTES, headers: {} }));
  const plain = { bookSourceUrl: 'https://example.test/', header: '', contentRule: {} };
  assert.equal(await ComicImagePipeline.materialize(http, plain, illustration,
    ComicImagePipeline.contextFromSource(plain, chapterUrl)), illustration);
  assert.equal(http.calls.length, 0, '普通书源的图片不得被强制下载');
}

// ---------------------------------------------------------------- 隐藏抓取宿主登记
// 每个宿主的控制器单独记录调用顺序，用于判断请求究竟落在哪个宿主上。
function fakeController(name) {
  return {
    name,
    customUserAgent: '',
    loaded: [],
    getWebId() { return 1; },
    getUserAgent() { return `default-ua-${name}`; },
    setCustomUserAgent(value) { this.customUserAgent = value; },
    loadUrl(url) { this.loaded.push(url); },
    postUrl(url) { this.loaded.push(`POST ${url}`); },
    stop() {},
    // 稳定的 DOM 快照：inspect 连续两次读到同一签名后才认为页面加载完成。
    runJavaScript() {
      return Promise.resolve(JSON.stringify({ url: 'https://example.test/page.html', title: '示例',
        ready: 'complete', html: '<html><body>正文</body></html>' }));
    }
  };
}
const { WebBookFetchRuntime } = evaluate('core/book/WebBookFetchRuntime.ts', ['WebBookFetchRuntime'], {
  console: logs,
  setTimeout, clearTimeout,
  webview: { WebviewController: class {} },
  util: { TextEncoder: class { encodeInto(value) { return new Uint8Array(Array.from(value || '', c => c.charCodeAt(0))); } } },
  CookieStore: { getCookie: () => '', setCookies() {}, saveAsync() {} }
});
const runtime = WebBookFetchRuntime.get();
const front = fakeController('front');
const back = fakeController('back');
function landed(controller, url) {
  return controller.loaded.some(item => item === url || item === `POST ${url}`);
}
/** 完成当前任务：模拟页面加载结束，等待 inspect 采集到两次相同快照。 */
async function settle() {
  runtime.onPageEnd(front);
  runtime.onPageEnd(back);
  await new Promise(resolve => setTimeout(resolve, 1600));
}
function track(promise) {
  const record = { value: null };
  promise.then(value => { record.value = value; });
  return record;
}

runtime.attach(front);
assert.equal(runtime.isAttached(), true);
assert.equal(runtime.isAvailable(), true);

// 1) 请求落在已挂载宿主上，并能正常完成。
const first = track(runtime.fetch({ url: 'https://example.test/chapter.html', method: 'GET', headers: {} }));
assert.ok(landed(front, 'https://example.test/chapter.html'), '请求必须发往已挂载的宿主');
await settle();
assert.equal(first.value && first.value.success, true, '隐藏宿主返回的页面必须成为请求结果');

// 2) 前台页面消失后回落到仍挂载的宿主，而不是报告“未挂载”。
const migrating = track(runtime.fetch({ url: 'https://example.test/migrating.html', method: 'GET', headers: {} }));
runtime.attach(back);
assert.ok(landed(back, 'https://example.test/migrating.html'), '新宿主挂载时进行中的任务必须迁移过去重跑');
runtime.detach(back);
assert.equal(runtime.isAttached(), true, '前台宿主退出后必须回落到仍然挂载的宿主');
assert.equal(await runtime.waitUntilAttached(200), true, '回落后的宿主必须立即满足挂载等待');
assert.ok(landed(front, 'https://example.test/migrating.html'), '迁移任务必须在回落宿主上重跑');
await settle();
assert.equal(migrating.value && migrating.value.success, true, '迁移后的任务必须成功完成');

// 3) 前台宿主再次挂载后，请求继续落在最新宿主上。
const resumed = track(runtime.fetch({ url: 'https://example.test/resumed.html', method: 'GET', headers: {} }));
assert.ok(landed(front, 'https://example.test/resumed.html'));
await settle();
assert.equal(resumed.value && resumed.value.success, true);

// 4) UA 按宿主隔离：书源的桌面 UA 不得泄漏到另一个宿主，切回后恢复该宿主自己的 UA。
const desktop = track(runtime.fetch({ url: 'https://example.test/desktop.html', method: 'GET',
  headers: { 'User-Agent': 'ua-desktop' } }));
assert.equal(front.customUserAgent, 'ua-desktop', '当前宿主必须安装请求声明的 UA');
await settle();
runtime.attach(back);
const plain = track(runtime.fetch({ url: 'https://example.test/plain.html', method: 'GET', headers: {} }));
assert.equal(back.customUserAgent, 'default-ua-back', '未声明 UA 的请求必须使用该宿主自己的默认 UA');
assert.notEqual(back.customUserAgent, 'ua-desktop', '桌面 UA 不得泄漏到另一个宿主');
await settle();
runtime.detach(back);
const plainAgain = track(runtime.fetch({ url: 'https://example.test/plain2.html', method: 'GET', headers: {} }));
assert.equal(front.customUserAgent, 'default-ua-front', '切回宿主后必须恢复该宿主自己的默认 UA');
await settle();

// 5) 所有宿主退出后才是真正的“未挂载”，进行中与排队请求都收到明确错误。
for (const record of [desktop, plain, plainAgain]) {
  assert.equal(record.value && record.value.success, true, '宿主仍在时请求必须正常完成');
}
const orphan = track(runtime.fetch({ url: 'https://example.test/orphan.html', method: 'GET', headers: {} }));
runtime.detach(front);
assert.equal(runtime.isAttached(), false, '所有宿主退出后必须报告未挂载');
warnings.length = 0;
assert.equal(await runtime.waitUntilAttached(150), false);
assert.ok(warnings.some(line => line.includes('等待隐藏宿主超时') && line.includes('已注册 0 个')),
  '未挂载必须留下可诊断日志');
assert.equal(orphan.value && orphan.value.success, false, '宿主全部退出后请求必须失败而不是挂起');
assert.equal(orphan.value.error, '网页抓取环境已关闭');

// ---------------------------------------------------------------- 封面缓存与显示
// BookCoverCache 必须把封面请求伪装成浏览器发出的请求：书源 UA + 书籍页 Referer + 图片站自己的
// Cookie（共享 CookieJar），否则受保护的图片站只会回 Cloudflare 挑战页。
const coverFiles = new Map();
const coverRequests = [];
let realmArrayBuffer = null;
let realmHtmlBuffer = null;
function pngArrayBuffer() {
  const buffer = realmArrayBuffer(PNG_BYTES.length);
  new Uint8Array(buffer).set(PNG_BYTES);
  return buffer;
}
function htmlArrayBuffer() {
  const bytes = new Uint8Array(Buffer.from(CHALLENGE_HTML));
  const buffer = realmArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
const coverFs = {
  OpenMode: { CREATE: 1, WRITE_ONLY: 2, TRUNC: 4, READ_ONLY: 0 },
  async open(path) { coverFiles.set(path, null); return { fd: path }; },
  async write(fd, buffer) { coverFiles.set(fd, new Uint8Array(buffer)); return buffer.byteLength; },
  async close() {},
  async stat(path) { if (!coverFiles.has(path) || coverFiles.get(path) === null) throw new Error('ENOENT'); },
  async mkdir() {},
  async copy() {},
  accessSync(path) {
    if (!coverFiles.has(path) || coverFiles.get(path) === null) throw new Error('ENOENT');
    return true;
  },
  unlinkSync(path) { coverFiles.delete(path); }
};
const coverSource = {
  bookSourceUrl: 'https://www.linovelib.com/',
  header: desktopHeader,
  contentRule: {}
};
const coverUrl = 'https://img3.readpai.com/cover/3765/218745.jpg';
const coverRoot = '/data/app/cache';
const bookPage = 'https://www.linovelib.com/novel/3765.html';
const sourceLookups = [];
const timers = [];
const appStorage = {
  values: new Map(),
  get(key) { return key === 'appCacheDir' ? coverRoot : this.values.get(key); },
  setOrCreate(key, value) { this.values.set(key, value); }
};
const coverBindings = {
  console: logs,
  fs: coverFs,
  fileUri: { getUriFromPath: (path) => `file://${path}` },
  http: {
    RequestMethod: { GET: 'GET' },
    HttpDataType: { ARRAY_BUFFER: 0 },
    createHttp: () => ({
      async request(url, options) {
        coverRequests.push({ url, options });
        return { responseCode: 200, result: pngArrayBuffer() };
      },
      destroy() {}
    })
  },
  CoverUrlNormalizer: { downloadCandidates: (url) => [url] },
  AppDatabase: {
    getInstance: () => ({
      async getBookSource(origin) {
        sourceLookups.push(origin);
        return origin === coverSource.bookSourceUrl ? coverSource : null;
      }
    })
  },
  ComicImagePipeline: { presentationHeaders: (source) => ComicImagePipeline.presentationHeaders(source) },
  CookieStore: { getCookie: (url) => url.includes('img3.readpai.com') ? 'cf_clearance=session' : '' },
  AppStorage: appStorage,
  setTimeout: (fn) => { timers.push(fn); return timers.length; }
};
const coverRealm = createRealm(coverBindings);
realmArrayBuffer = coverRealm.helper('(length) => new ArrayBuffer(length)');
const { BookCoverCache } = coverRealm.evaluate('utils/BookCoverCache.ets', ['BookCoverCache']);
coverBindings.BookCoverCache = BookCoverCache;
const { CoverImageService } = coverRealm.evaluate('core/book/CoverImageService.ets', ['CoverImageService']);
{
  assert.equal(BookCoverCache.resolveCachedCoverInRoot(coverRoot, coverUrl), '', '未缓存时必须报告未命中');
  const resolved = await BookCoverCache.resolveCoverInRoot(coverRoot, coverUrl, coverSource.bookSourceUrl, bookPage);
  assert.ok(resolved.startsWith('file://'), `封面必须落到本地文件：${resolved}`);
  assert.equal(coverRequests.length, 1);
  assert.equal(coverRequests[0].options.header['User-Agent'],
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) linovelib-desktop',
    '封面请求必须沿用书源 UA');
  assert.equal(coverRequests[0].options.header['Referer'], bookPage, '封面请求必须带书籍页 Referer');
  assert.equal(coverRequests[0].options.header['Cookie'], 'cf_clearance=session',
    '封面请求必须带上该图片站自己的 Cookie');
  assert.ok(/^image\//.test(coverRequests[0].options.header['Accept']), '封面请求应声明图片 Accept');
  assert.equal(BookCoverCache.resolveCachedCoverInRoot(coverRoot, coverUrl), resolved, '缓存命中必须同步可见');
  const again = await BookCoverCache.resolveCoverInRoot(coverRoot, coverUrl, coverSource.bookSourceUrl, bookPage);
  assert.equal(again, resolved);
  assert.equal(coverRequests.length, 1, '命中缓存后不得重复下载');
  assert.equal(sourceLookups.length, 1, '书源请求头必须缓存，避免每张封面都查库');
  // 没有书籍页时退回书源站点根，而不是把 Referer 指向图片站自己。
  const other = 'https://img3.readpai.com/cover/3765/218746.jpg';
  await BookCoverCache.resolveCoverInRoot(coverRoot, other, coverSource.bookSourceUrl, '');
  assert.equal(coverRequests[1].options.header['Referer'], 'https://www.linovelib.com/',
    '缺少书籍页时必须退回书源站点根');
}

// HTTP 200 的挑战页不得落盘成“封面”：否则空白封面会被永久缓存。
{
  const challenged = 'https://img3.readpai.com/cover/3765/218800.jpg';
  const before = coverRequests.length;
  coverBindings.http.createHttp = () => ({
    async request(url, options) {
      coverRequests.push({ url, options });
      return { responseCode: 200, result: htmlArrayBuffer() };
    },
    destroy() {}
  });
  warnings.length = 0;
  const result = await BookCoverCache.resolveCoverInRoot(coverRoot, challenged,
    coverSource.bookSourceUrl, bookPage);
  assert.equal(result, challenged, '挑战页必须回退到原始地址');
  assert.equal(BookCoverCache.resolveCachedCoverInRoot(coverRoot, challenged), '', '挑战页不得进入缓存');
  assert.ok(warnings.some(line => line.includes('不是图片')), '挑战页必须留下可诊断日志');
  coverBindings.http.createHttp = () => ({
    async request(url, options) {
      coverRequests.push({ url, options });
      return { responseCode: 200, result: pngArrayBuffer() };
    },
    destroy() {}
  });
  assert.equal(coverRequests.length, before + 1);
}

// CoverImageService：渲染期同步取值 + 解析完成后通知重建（与 BookCoverCache 同 realm）。
{
  const pendingUrl = 'https://img3.readpai.com/cover/3765/218799.jpg';
  assert.equal(CoverImageService.displayUri(pendingUrl, coverSource.bookSourceUrl, bookPage, 0), pendingUrl,
    '未解析时先返回原始地址');
  assert.equal(CoverImageService.displayUri(pendingUrl, coverSource.bookSourceUrl, bookPage, -1), pendingUrl,
    '只读模式同样返回原始地址');
  const before = coverRequests.length;
  const local = await CoverImageService.resolve(pendingUrl, coverSource.bookSourceUrl, bookPage);
  assert.ok(local.startsWith('file://'), `解析后必须得到本地地址：${local}`);
  assert.equal(coverRequests.length, before + 1, '解析必须真正下载一次');
  assert.equal(CoverImageService.displayUri(pendingUrl, coverSource.bookSourceUrl, bookPage, 0), local,
    '解析完成后渲染期必须拿到本地地址');
  assert.equal(coverRequests.length, before + 1, '已解析的地址不得再次排队');
  assert.equal(timers.length, 1, '解析完成必须安排一次封面区块重建（并合并同批次的多次完成）');
  for (const timer of timers.splice(0)) timer();
  assert.equal(appStorage.values.get('coverImageVersion'), 1, '重建计数必须写入 AppStorage');
  // 非网络地址（本地封面、主题资源）原样返回，不排队也不计数。
  assert.equal(CoverImageService.displayUri('file:///data/cover.png', '', '', 0), 'file:///data/cover.png');
  assert.equal(CoverImageService.displayUri('', '', '', 0), '');
  assert.equal(timers.length, 0, '本地封面不得触发重建');
}

console.log('正文图片请求上下文：书源 UA/章节 Referer 透传、Cookie 不外泄、缓存复用、挑战页回退与诊断日志；' +
  '隐藏抓取宿主登记：多页面回落、任务迁移、按宿主隔离 UA、全部退出才报告未挂载；' +
  '封面缓存：书源 UA/书籍页 Referer/CookieJar、缓存复用、书源请求头只查一次、解析后重建一次。' +
  '平台模块以替身出现。');
