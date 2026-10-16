// 哔哩轻小说书源离线回归。
//
// 运行：node scripts/linovelib-source-check.mjs
// 可选：LINOVELIB_CAPTURE_DIR=<目录> 时改用真实抓取样本（文件名与生成书源的说明见
// docs/book-sources/local/README.md，该目录不入库）：
//   desktop-search-re.html  /S6/ 搜索页（20 条/页）
//   desktop-info.html       桌面详情页
//   desktop-catalog.html    桌面目录页（119 个 li.col-4）
//   desktop-home.html       桌面首页（.mind-book 卡片）
//   mobile-explore.html     /wenku/postdate_..._1_0.html（30 条/页）
//   mobile-info.html        移动详情页
//   mobile-catalog.html     移动目录页（50 条 jsChapter）
//
// 覆盖：URL 辅助函数（同章分页白名单）、能力路由、书源 JSON 结构、各阶段生产解析链，
// 以及用真实浏览器布局执行的正文净化脚本。所有 HTTP、DNS 和站点脚本都不在此脚本中执行；
// 抓取样本只作为文本读入。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { bindings as b } from './search-source-compat-check.mjs';
import { lintSource } from './lib/legado-rule-grammar.mjs';
import {
  buildSource, linovelibJsLib, chapterUrlSuffix,
  cleanLinovelibDocument, desktopUserAgent
} from './lib/linovelib-source.mjs';

const captureDir = process.env.LINOVELIB_CAPTURE_DIR || '';
function capture(name) {
  return captureDir ? fs.readFileSync(path.join(captureDir, name), 'utf8') : '';
}
function captureOr(name, fallback) {
  const value = capture(name);
  return value || fallback;
}

// ---------------------------------------------------------------- 分阶段运行时替身
// 真机上 `@js:` 后处理由 BookSourceStageWebRuntime 执行：ArkWeb 把 `jsLib + 字段脚本` 拼成
// 一个脚本在同一作用域求值（见 BookSourceStageWebRuntime.buildStageScript）。这里用 Node 的
// vm 复刻同一个契约，只替换宿主桥，从而真实校验“jsLib 常量对字段脚本可见”。
// 图片物化只影响漫画缓存路径，与本次验证的正文文本无关；返回空值让它保留原始地址。
// 图片物化只影响漫画缓存路径，与本次验证的正文文本无关；返回空值让它保留原始地址，
// 且不声明任何请求上下文（图片请求头的真实行为由 scripts/reader-image-context-check.mjs 覆盖）。
b.ComicImagePipeline = {
  contextFromSource() { return { referer: '', headers: {}, isEmpty: () => true }; },
  async materialize() { return ''; }
};

b.StageWebRuntimeRequest = class {
  constructor() { this.source = null; this.code = ''; }
  applyStageBudget() {}
};
b.BookSourceStageWebRuntime = {
  get: () => ({
    isAvailable: () => true,
    async waitUntilAvailable() { return true; },
    attach() {}, detach() {}, clearOwner() {}, clearResetHandler() {}, setReady() {}, setResetHandler() {},
    async execute(request) {
      const context = vm.createContext({
        java: { __setContextContent() {} },
        console, JSON, Math, Date, RegExp, Object, Array, String, Number, Boolean, Error,
        encodeURIComponent, decodeURIComponent, encodeURI, escape, unescape, parseInt, parseFloat
      });
      // 与 buildStageScript 一致：阶段输入暴露为 result/src，baseUrl 与 chapter 同时可见。
      context.result = request.content === undefined ? '' : request.content;
      context.src = context.result;
      context.baseUrl = request.baseUrl || '';
      context.chapter = request.chapter || {};
      const code = `${request.source.jsLib || ''}\n${request.code || ''}`;
      const value = vm.runInContext(code, context, { timeout: 10000 });
      return { value: value === undefined || value === null ? '' : String(value) };
    }
  })
};

// ---------------------------------------------------------------- URL 辅助函数
// 按引擎实际拿到的 jsLib 文本求值，避免测到与书源不一致的副本。
const helpers = vm.runInNewContext(
  linovelibJsLib() + '\n;({chapterUrl: linovelibChapterUrl, nextPage: linovelibNextPage})', {});
const suffix = chapterUrlSuffix();
assert.ok(suffix.includes('"webView":true'), '章节请求必须走隐藏 ArkWeb');
assert.ok(suffix.includes('"webJs"'), '章节请求必须带净化脚本');
{
  assert.equal(helpers.chapterUrl('/novel/3765/196483.html'),
    'https://www.linovelib.com/novel/3765/196483.html' + suffix);
  assert.equal(helpers.chapterUrl('https://www.linovelib.com/novel/3765/196483_2.html'),
    'https://www.linovelib.com/novel/3765/196483_2.html' + suffix);
  // 卷封面、目录页、脚本链接、移动域名、他站域名都不是章节正文地址。
  for (const rejected of ['/novel/3765/vol_196480.html', '/novel/3765/catalog',
    'javascript:cid(1)', 'http://www.linovelib.com/novel/3765/196483.html',
    'https://w.linovelib.com/novel/3765/196483.html', 'https://evil.test/novel/3765/196483.html',
    'https://www.linovelib.com/novel/3765/196483.html#anchor', '', null, undefined]) {
    assert.equal(helpers.chapterUrl(rejected), '', `应拒绝：${rejected}`);
  }
  const first = 'https://www.linovelib.com/novel/3765/196483.html';
  assert.equal(helpers.nextPage('/novel/3765/196483_2.html', first, first),
    'https://www.linovelib.com/novel/3765/196483_2.html' + suffix);
  assert.equal(helpers.nextPage('https://www.linovelib.com/novel/3765/196483_3.html',
    'https://www.linovelib.com/novel/3765/196483_2.html', first),
    'https://www.linovelib.com/novel/3765/196483_3.html' + suffix);
  // 同书不同章（真实样本里的 67909 → 67910）不是同一章的续页。
  const other = 'https://www.linovelib.com/novel/1861/67909.html';
  assert.equal(helpers.nextPage('/novel/1861/67910.html', other, other), '');
  // 跨书、回头页、跳页、非章节链接、空链接都要拒绝。
  assert.equal(helpers.nextPage('/novel/3765/196484.html', first, first), '');
  assert.equal(helpers.nextPage('/novel/3765/196483.html', 'https://www.linovelib.com/novel/3765/196483_2.html', first), '');
  assert.equal(helpers.nextPage('/novel/3765/196483_4.html', 'https://www.linovelib.com/novel/3765/196483_2.html', first), '');
  assert.equal(helpers.nextPage('https://w.linovelib.com/novel/3765/196483_2.html', first, first), '');
  assert.equal(helpers.nextPage('#', first, first), '');
  assert.equal(helpers.nextPage('/novel/3765/196483_2.html', '', first), '');
  // 已带请求选项的当前地址仍能解析出页码（baseUrl 可能来自上一页响应）。
  assert.equal(helpers.nextPage('/novel/3765/196483_3.html',
    'https://www.linovelib.com/novel/3765/196483_2.html' + suffix, first),
    'https://www.linovelib.com/novel/3765/196483_3.html' + suffix);
}

// ---------------------------------------------------------------- 能力路由
// 出现 DOM 标识或完整 JS 语义会把整个阶段交给 ArkWeb；jsLib 只带字符串常量，应留在轻量引擎。
// 这里用路由器自己的判定来验证，而不是对 jsLib 文本做关键字匹配（净化脚本以字面量存在）。
for (const stage of ['toc', 'content']) {
  const rule = stage === 'toc' ? '@css:a@href@js:linovelibChapterUrl(result)'
    : 'text.下一页@href@js:linovelibNextPage(result,baseUrl,chapter.url)';
  assert.equal(b.BookSourceRuntimeRouter.decide(stage, linovelibJsLib() + '\n' + rule).runtime, 'legacy',
    `${stage} 阶段的 URL 规则应可由轻量引擎执行`);
}
assert.equal(b.BookSourceRuntimeRouter.decide('toc', linovelibJsLib()).capabilities.needsDom, false,
  'jsLib 不应让能力分析判定为需要 DOM');

// ---------------------------------------------------------------- 书源 JSON 结构
const built = buildSource();
assert.equal(built.length, 1, '必须只交付一个书源文件');
const source = built[0];
assert.ok(source.bookSourceName && source.bookSourceUrl, '必填字段');
assert.ok(source.searchUrl && source.exploreUrl, '缺少阶段配置');
assert.ok(source.ruleSearch.bookList && source.ruleSearch.name && source.ruleSearch.bookUrl, '搜索必需字段');
assert.ok(source.ruleExplore.bookList && source.ruleExplore.name && source.ruleExplore.bookUrl, '发现必需字段');
assert.ok(source.ruleBookInfo.name && source.ruleBookInfo.tocUrl, '详情必需字段');
assert.ok(source.ruleToc.chapterList && source.ruleToc.chapterUrl, '目录必需字段');
assert.ok(source.ruleContent.content, '正文必需字段');
assert.equal(source.ruleSearch.bookList.includes('class.search-result-list clearfix'), false,
  '多 class 选择器必须写成 .a.b 形式');
assert.ok(source.jsLib, '书源规则使用 @js: 后处理，必须带 jsLib');
assert.equal(source.ruleToc.nextTocUrl, '', '本应用不支持 nextTocUrl，不要写成假的支持');
assert.ok(source.header.includes('Windows NT 10.0'), '统一使用桌面 UA');
assert.ok(!/Android|iPhone/.test(source.header), '书源不应在请求头里混入移动 UA');
assert.ok(source.searchUrl.includes('"webView":true'), '搜索必须交给隐藏 ArkWeb');
assert.ok(source.searchUrl.includes('searchkey={{key}}'), '搜索表单字段');

// 唯一的跨主机边界：发现列表在移动站，其余阶段都在桌面站，且列表链接必须改写到桌面主机。
const stageRules = JSON.stringify([source.ruleSearch, source.ruleBookInfo, source.ruleToc, source.ruleContent]);
assert.ok(!/bilinovel\.com/.test(stageRules), '搜索/详情/目录/正文不得指向移动站');
assert.ok(source.ruleExplore.bookUrl.includes('https://www.linovelib.com$1'),
  '发现列表里的书籍地址必须按同一路径改写到桌面主机，否则详情会落到只给预览的移动主题');
for (const entry of JSON.parse(source.exploreUrl)) {
  assert.match(entry.url,
    /^https:\/\/www\.bilinovel\.com\/wenku\/\w+_0_0_0_0_0_0_0_\{\{page\}\}_0\.html$/,
    `发现分类地址：${entry.url}`);
}

// 书源只能声明请求头与流程，不能携带账号、口令或已抓取的站点票据。
const risky = [source.header, source.loginUi, source.searchUrl, source.exploreUrl,
  source.variable || ''].join('\n');
assert.ok(!/["']?cookie["']?\s*:/i.test(risky), '请求头/配置不得内置 Cookie');
assert.ok(!/password|passwd|jieqisearchticket|search_guard|logininfo/i.test(risky),
  '不得内置口令或站点票据/守卫状态');
const raw = JSON.stringify(source);
assert.ok(!/=ey[A-Za-z0-9_-]{10,}/.test(raw), '不得内置疑似 JWT/会话串');
assert.ok(!/linovelib\.com\/files|baidu|googlesyndication|cloudflareinsights|hm\.baidu/.test(raw),
  '书源不得内置第三方跟踪或广告主机');
assert.ok(source.bookSourceComment.includes('搜索会话'), '需说明搜索会话前置条件');
assert.ok(source.bookSourceComment.includes('未经真机验收'), '需标注未验收范围');

// 上游语法门禁：本项目解析器比阅读宽松，本地跑通不代表能导入阅读。
// 真实故障——`||` 的第二段重复写 `@css:`，阅读只剥整条规则开头那一次前缀，
// 于是把 `@css:.read-btn` 当选择器交给 jsoup，手机上报“详情页出错”。
// 判定依据见 scripts/lib/legado-rule-grammar.mjs，可用 `node scripts/legado-rule-grammar-check.mjs` 单独跑。
const grammarProblems = lintSource(source);
assert.deepEqual(grammarProblems.map(item => `${item.where} [${item.code}] ${item.rule}`), [],
  '书源规则必须符合上游阅读规则语法');
assert.equal((source.ruleBookInfo.tocUrl.match(/@css:/gi) || []).length, 1,
  '`@css:` 只能在整条规则最前面出现一次');
// 需要“第 N 个元素”的字段必须用 Default 语法（索引只在 Default 模式生效），
// 不能挂在 `@css:` 后面——上游会把 `.0` 当成 class 字面量而静默取空。
for (const field of ['author', 'intro', 'kind', 'wordCount', 'updateTime']) {
  assert.ok(!/^@css:/i.test(source.ruleBookInfo[field]),
    `详情.${field} 依赖索引，必须用 Default 语法而不能写 @css:`);
}
for (const field of ['author', 'status', 'wordCount']) {
  assert.ok(!/^@css:/i.test(source.ruleSearch[field]),
    `搜索.${field} 依赖索引，必须用 Default 语法而不能写 @css:`);
}

// 第二本真实详情样本（另一个文库，完结状态，阅读按钮是 javascript:;），
// 确认详情规则不是只对某本书成立。
if (captureDir && fs.existsSync(path.join(captureDir, 'desktop-info-2.html'))) {
  const second = capture('desktop-info-2.html');
  const secondValues = (await batch(source, [second], [
    new b.RuleFieldRequest('name', source.ruleBookInfo.name),
    new b.RuleFieldRequest('author', source.ruleBookInfo.author),
    new b.RuleFieldRequest('coverUrl', source.ruleBookInfo.coverUrl),
    new b.RuleFieldRequest('intro', source.ruleBookInfo.intro),
    new b.RuleFieldRequest('kind', source.ruleBookInfo.kind),
    new b.RuleFieldRequest('status', source.ruleBookInfo.status),
    new b.RuleFieldRequest('wordCount', source.ruleBookInfo.wordCount),
    new b.RuleFieldRequest('updateTime', source.ruleBookInfo.updateTime),
    new b.RuleFieldRequest('tocUrl', source.ruleBookInfo.tocUrl)
  ], 'https://www.linovelib.com/novel/5426.html', b.SourceRuntimeStage.BOOK_INFO)).values[0];
  assert.equal(secondValues['name'], '泳装姐妹');
  assert.equal(secondValues['author'], '水无瀬さんご');
  assert.equal(secondValues['kind'], '校园');
  assert.equal(secondValues['status'], '完结');
  assert.equal(secondValues['wordCount'], '6.1 万');
  assert.equal(secondValues['updateTime'], '2026-10-05');
  assert.equal(secondValues['tocUrl'], '/novel/5426/catalog',
    '目录入口必须绕过 javascript:; 的阅读按钮');
  assert.ok(secondValues['intro'].length >= 6 && !secondValues['intro'].includes('★'), '第二本书的简介');
}

// ---------------------------------------------------------------- 应用侧衔接
// 书源依赖三处应用侧行为：隐藏抓取宿主要有真实视口、共享控制器不能泄漏其他书的 UA、
// 验证页要沿用书源声明的 UA。这里做静态断言，避免无声回退。
const hostFile = fs.readFileSync(new URL('../entry/src/main/ets/components/WebBookFetchRuntimeHost.ets',
  import.meta.url), 'utf8');
assert.ok(hostFile.includes(".width('100%')") && hostFile.includes(".height('100%')"),
  '隐藏抓取宿主必须按正常视口渲染，否则正文容器塌缩、净化会拒绝保存未过滤正文');
assert.ok(hostFile.includes('hitTestBehavior(HitTestMode.None)'),
  '隐藏抓取宿主不得截获触摸或滑动');
assert.ok(!/\.width\(1\)[\s\S]{0,40}\.height\(1\)/.test(hostFile),
  '隐藏抓取宿主不应退回 1×1vp');
const fetchRuntimeFile = fs.readFileSync(new URL('../entry/src/main/ets/core/book/WebBookFetchRuntime.ts',
  import.meta.url), 'utf8');
assert.ok(fetchRuntimeFile.includes('applyUserAgent(') &&
  fetchRuntimeFile.includes('readControllerUserAgent('),
  '共享控制器必须在请求未声明 UA 时恢复默认 UA，避免跨书源泄漏');
assert.ok(fetchRuntimeFile.includes('setCustomUserAgent(wanted)'),
  'UA 应用逻辑必须仍然调用 setCustomUserAgent');

assert.equal(b.VerificationSupport.staticSourceUserAgent(source), desktopUserAgent,
  '验证页必须沿用书源声明的桌面 UA');
assert.equal(b.VerificationSupport.staticSourceUserAgent(
  Object.assign(new b.BookSource(), { header: "Accept: text/html" })), '',
  '未声明 UA 的书源不应让验证页套用其他 UA');
assert.equal(b.VerificationSupport.staticSourceUserAgent(
  Object.assign(new b.BookSource(), { header: "User-Agent: {{ua}}" })), '',
  '模板形式的 UA 不能直接交给 Web 组件');

// ---------------------------------------------------------------- 阶段解析
function batch(source, contents, fields, baseUrl, stage) {
  const request = new b.RuleBatchExecutionRequest();
  request.source = source;
  request.book = new b.Book();
  request.stage = stage;
  request.ownerId = `check_${stage}_${Date.now()}`;
  request.typedContents = contents.map(value => b.RuleValue.fromExternal(value));
  request.contents = contents.slice();
  request.baseUrl = baseUrl;
  request.fields = fields;
  request.timeoutMs = 20000;
  return b.RuleExecutionService.get().executeBatch(request);
}

const searchHtml = '<div class="wrap"><div class="search-html-box"><div class="search-main fl">' +
  '<div class="search-result-list clearfix">' +
  '<div class="imgbox fl se-result-book"><a href="/novel/4612.html"><img src="/files/a.jpg"></a></div>' +
  '<div class="fl se-result-infos"><h2 class="tit"><a href="/novel/4612.html">志乃与恋 Future</a></h2>' +
  '<div class="bookinfo"><a href="/authorarticle/x.html">日日缀郎</a><em>|</em>' +
  '<a href="/wenku/fujimibunko/1.html">富士见文库</a><em>|</em><span>连载</span><em>|</em><span>15.3 万</span></div>' +
  '<p>简介文本</p><div class="key-word">青春 恋爱</div></div>' +
  '<div class="btn"><a href="/novel/4612.html" class="bkinfo">书籍详情</a></div></div>' +
  '</div><div class="search-tab"><div class="pagelink" id="pagelink"><em id="pagestats">1/5</em>' +
  '<a href="/S6/Re_2.html" class="next">&gt;</a></div></div></div></div>';
const desktopSearchHtml = captureOr('desktop-search-re.html', searchHtml);
const searchElements = new b.AnalyzeRule(desktopSearchHtml, 'https://www.linovelib.com/')
  .execute(source.ruleSearch.bookList, b.RuleExecutionTarget.ELEMENTS);
assert.ok(searchElements.length >= 1, '搜索列表规则必须命中');
const searchValues = await batch(source, searchElements.map(item => item.asString()), [
  new b.RuleFieldRequest('name', source.ruleSearch.name),
  new b.RuleFieldRequest('bookUrl', source.ruleSearch.bookUrl),
  new b.RuleFieldRequest('author', source.ruleSearch.author),
  new b.RuleFieldRequest('kind', source.ruleSearch.kind),
  new b.RuleFieldRequest('status', source.ruleSearch.status),
  new b.RuleFieldRequest('wordCount', source.ruleSearch.wordCount)
], 'https://www.linovelib.com/', b.SourceRuntimeStage.SEARCH);
// 结构化断言对两种样本都成立：字段齐全、地址是站内详情页、没有被热搜/广告条目污染。
assert.ok(searchValues.values.every(row => row['name'] && row['bookUrl']), '每条结果都要有书名和地址');
assert.ok(searchValues.values.every(row => /^\/novel\/\d+\.html$/.test(row['bookUrl'])),
  '搜索结果的详情地址应为站内书籍页');
assert.ok(searchValues.values.every(row => row['author'] && !/^作者/.test(row['author'])), '作者字段需清理前缀');
assert.ok(searchValues.values.every(row => /万$/.test(row['wordCount'])), '字数应带单位');
assert.ok(searchValues.values.every(row => row['kind'] && !/\s{2,}/.test(row['kind']) &&
  !row['kind'].includes('简介') && row['kind'].length <= 200),
  '标签字段必须是单行标签文本，不能退化成整段正文');
assert.ok(!searchValues.values.some(row => /搜索热|热搜/.test(row['name'])), '热搜弹层不得进入结果');
const firstBook = searchValues.values[0];
assert.equal(firstBook['name'], '志乃与恋 Future');
assert.equal(firstBook['bookUrl'], '/novel/4612.html');
assert.equal(firstBook['author'], '日日缀郎');
if (!captureDir) {
  assert.equal(firstBook['kind'], '青春 恋爱');
  assert.equal(firstBook['status'], '连载');
  assert.equal(firstBook['wordCount'], '15.3 万');
} else {
  assert.equal(searchElements.length, 20, '真实 /S6/ 样本第一页应 20 条');
  assert.equal(firstBook['kind'], '青春 恋爱 百合 女性视角');
  assert.equal(firstBook['wordCount'], '15.3 万');
}

// 桌面详情
const infoHtml = captureOr('desktop-info.html',
  '<div class="book-detail clearfix"><div class="book-img fl"><img src="/files/3/3765/3765s.jpg"></div>' +
  '<div class="book-info"><h1 class="book-name">示例书名</h1>' +
  '<div class="book-label"><a href="javascript:" class="state">连载</a>' +
  '<a href="/wenku/kadokawabunko/1.html" class="label">角川文库</a>' +
  '<span><a href="/wenku/x.html">校园</a> <a href="/wenku/y.html">青春</a></span></div>' +
  '<div class="nums"><span>最后更新：2026-06-22 </span> <span>字数：107.8 万 </span></div>' +
  '<div class="book-dec Jbook-dec"><aside class="notice"><p class="notice-body">★推广语</p></aside>' +
  '<p>真正的简介文本。</p></div>' +
  '<div class="btn-group"><a class="btn read-btn" href="/novel/3765/catalog">小说目录</a></div>' +
  '</div><div class="au-name"><a href="/authorarticle/x.html">示例作者</a>、<a href="/illustratorarticle/y.html">插画</a></div></div>');
const infoValues = (await batch(source, [infoHtml], [
  new b.RuleFieldRequest('name', source.ruleBookInfo.name),
  new b.RuleFieldRequest('author', source.ruleBookInfo.author),
  new b.RuleFieldRequest('intro', source.ruleBookInfo.intro),
  new b.RuleFieldRequest('kind', source.ruleBookInfo.kind),
  new b.RuleFieldRequest('status', source.ruleBookInfo.status),
  new b.RuleFieldRequest('wordCount', source.ruleBookInfo.wordCount),
  new b.RuleFieldRequest('updateTime', source.ruleBookInfo.updateTime),
  new b.RuleFieldRequest('tocUrl', source.ruleBookInfo.tocUrl)
], 'https://www.linovelib.com/novel/3765.html', b.SourceRuntimeStage.BOOK_INFO)).values[0];
assert.ok(infoValues['name'], '详情书名');
assert.ok(infoValues['author'] && !infoValues['author'].includes('插画'), '作者字段不应混入插画师');
assert.match(infoValues['tocUrl'], /^\/novel\/\d+\/catalog$/, '目录地址');
assert.match(infoValues['updateTime'], /^\d{4}-\d{2}-\d{2}$/, '更新时间应保留站点原始日期文本');
assert.match(infoValues['wordCount'], /万$/, '字数应带单位');
assert.ok(infoValues['kind'] && infoValues['kind'].length <= 12, `分类应取单个标签：${infoValues['kind']}`);
assert.ok(infoValues['status'], '连载状态');
assert.ok(!infoValues['intro'].includes('★'), `简介不得包含推广公告：${infoValues['intro']}`);
assert.ok(infoValues['intro'].length >= 6, '简介应有实际内容');
if (captureDir) {
  assert.equal(infoValues['name'], '我和班上第二可爱的女生成为朋友');
  assert.equal(infoValues['author'], 'たかた');
  assert.ok(infoValues['intro'].startsWith('连点头之交都没几个的我'), '简介应取 .book-dec 正文段');
  assert.equal(infoValues['kind'], '校园');
  assert.equal(infoValues['status'], '连载');
} else {
  assert.equal(infoValues['name'], '示例书名');
  assert.equal(infoValues['author'], '示例作者');
  assert.equal(infoValues['kind'], '校园');
  assert.equal(infoValues['status'], '连载');
  assert.ok(infoValues['intro'].includes('真正的简介文本'), `简介应取正文段：${infoValues['intro']}`);
}
assert.equal(infoValues['wordCount'], '107.8 万');
assert.equal(infoValues['updateTime'], '2026-06-22');
assert.equal(infoValues['tocUrl'], '/novel/3765/catalog');

// 桌面目录：走 WebBookService 的真实目录链，含 @js: 后处理
const catalogHtml = captureOr('desktop-catalog.html',
  '<div class="volume-list"><div class="volume clearfix">' +
  '<a href="/novel/3765/vol_196480.html" class="volume-cover"><img src="/images/no.svg"></a>' +
  '<div class="volume-info"><h2 class="v-line"><a href="/novel/3765/vol_196480.html">示例书名 1</a></h2></div>' +
  '<ul class="chapter-list clearfix">' +
  '<li class="col-4"><a href="/novel/3765/196481.html">插图</a></li>' +
  '<li class="col-4"><a href="/novel/3765/catalog">目录</a></li>' +
  '<li class="col-4"><a href="javascript:void(0)">书签</a></li>' +
  '<li class="col-4"><a href="/novel/3765/196483.html">1. 朝凪海这个女生</a></li>' +
  '</ul></div></div>' +
  '<div class="chapter-list clearfix"><ul><li class="col-4"><a href="/novel/3765/196484.html">2. 第二刚刚好？</a></li></ul></div>');
const catalogBook = Object.assign(new b.Book(), { bookUrl: 'https://www.linovelib.com/novel/3765.html' });
const catalogSource = Object.assign(new b.BookSource(), source, {
  tocRule: source.ruleToc, contentRule: source.ruleContent
});
const chapters = await new b.WebBookService()['parseChapterPage'](catalogSource, catalogBook,
  catalogHtml, 'https://www.linovelib.com/novel/3765/catalog', new b.RuleContext(), 0);
assert.ok(chapters.length >= 2, `目录应保留直接章节链接，实际 ${chapters.length}`);
assert.equal(chapters[0].title, '插图');
assert.equal(chapters[0].url, 'https://www.linovelib.com/novel/3765/196481.html' + suffix);
const titles = chapters.map(chapter => chapter.title);
assert.ok(!titles.includes('目录') && !titles.includes('书签'), '非章节链接必须被丢弃');
assert.ok(chapters.every(chapter => /^https:\/\/www\.linovelib\.com\/novel\/3765\/\d+\.html,/.test(chapter.url)),
  '只保留同书章节地址，并带上请求选项');
assert.ok(chapters.every(chapter => !chapter.url.includes('javascript:')), '脚本链接不得成为正文地址');
if (captureDir) {
  // 真实目录里 119 条 li.col-4 中有 5 条是 javascript:cid(0)（站点锁定/需购买章节，没有可用地址），
  // 白名单会丢弃它们；其余 114 条是可直接阅读的章节。
  assert.equal(chapters.length, 114, '真实桌面目录应保留 114 条可直接阅读的章节');
}

// 发现列表（移动站的 /wenku/ 列表，链接必须改写到桌面主机）
const exploreHtml = captureOr('mobile-explore.html',
  '<ol class="book-ol-normal"><li class="book-li"><a class="book-layout" href="/novel/5426.html">' +
  '<div class="book-cover"><img data-src="/files/5/5426/5426s.jpg" src="/images/no.svg"></div>' +
  '<div class="book-title">泳装姐妹</div>' +
  '<div class="book-author">作者水无瀬さんご</div>' +
  '<div class="book-desc">移动端列表简介文本示例。</div>' +
  '<div class="tag-small-group"><span class="tag-small yellow">校园 后宫</span>' +
  '<span class="tag-small blue">6.1万</span></div></a></li></ol>');
const exploreBase = 'https://www.bilinovel.com/wenku/postdate_0_0_0_0_0_0_0_1_0.html';
const exploreElements = new b.AnalyzeRule(exploreHtml, exploreBase)
  .execute(source.ruleExplore.bookList, b.RuleExecutionTarget.ELEMENTS);
assert.ok(exploreElements.length >= 1, '发现列表规则必须命中');
const exploreValues = (await batch(source, exploreElements.map(item => item.asString()), [
  new b.RuleFieldRequest('name', source.ruleExplore.name),
  new b.RuleFieldRequest('bookUrl', source.ruleExplore.bookUrl, true),
  new b.RuleFieldRequest('author', source.ruleExplore.author),
  new b.RuleFieldRequest('coverUrl', source.ruleExplore.coverUrl),
  new b.RuleFieldRequest('intro', source.ruleExplore.intro),
  new b.RuleFieldRequest('kind', source.ruleExplore.kind),
  new b.RuleFieldRequest('wordCount', source.ruleExplore.wordCount)
], exploreBase, b.SourceRuntimeStage.EXPLORE)).values;
const firstExplore = exploreValues[0];
assert.ok(firstExplore['name'], '发现书名');
assert.ok(!/^作者/.test(firstExplore['author']), '发现列表的“作者”前缀必须清理');
assert.match(firstExplore['coverUrl'], /\/5426s\.jpg/, '封面应取 data-src 懒加载地址');
assert.ok(firstExplore['wordCount'], '发现字数');
assert.equal(firstExplore['name'], '泳装姐妹');
assert.equal(firstExplore['bookUrl'], 'https://www.linovelib.com/novel/5426.html',
  '发现链接必须改写到桌面主机，否则详情会落到只给预览的移动主题');
assert.ok(exploreValues.every(row => /^https:\/\/www\.linovelib\.com\/novel\/\d+\.html$/.test(row['bookUrl'])),
  '每一条发现结果都必须指向桌面主机');
if (captureDir) {
  assert.equal(exploreElements.length, 30, '真实发现样本应 30 条/页');
  assert.equal(firstExplore['author'], '水无瀬さんご');
} else {
  assert.equal(firstExplore['author'], '水无瀬さんご');
  assert.equal(firstExplore['kind'], '校园 后宫');
  assert.equal(firstExplore['wordCount'], '6.1万');
}

// 链接改写要覆盖移动站实际可能给出的所有写法（相对、绝对、已经是桌面主机）。
for (const [href, expected] of [
  ['/novel/999.html', 'https://www.linovelib.com/novel/999.html'],
  ['https://www.bilinovel.com/novel/999.html', 'https://www.linovelib.com/novel/999.html'],
  ['https://www.linovelib.com/novel/999.html', 'https://www.linovelib.com/novel/999.html']
]) {
  const html = '<ol class="book-ol-normal"><li class="book-li"><a class="book-layout" href="' + href +
    '">x</a></li></ol>';
  const items = new b.AnalyzeRule(html, exploreBase)
    .execute(source.ruleExplore.bookList, b.RuleExecutionTarget.ELEMENTS);
  const row = (await batch(source, items.map(item => item.asString()),
    [new b.RuleFieldRequest('bookUrl', source.ruleExplore.bookUrl, true)],
    exploreBase, b.SourceRuntimeStage.EXPLORE)).values[0];
  assert.equal(row['bookUrl'], expected, `发现链接改写：${href}`);
}

// ---------------------------------------------------------------- 正文净化（真实浏览器布局）
const browser = findBrowser();
const layoutResult = browser ? runLayoutProbe(browser) : null;

const cleanedHtml = layoutResult ? layoutResult.cases.normal.html
  : '<div id="TextContent"><p>真实第一段。</p><p>真实第二段。</p><p>真实第一段。</p>' +
    '<p style="position:absolute;width:120px;height:20px">绝对定位但可见</p>' +
    '<img src="/files/a.jpg" data-src="/files/a-big.jpg"></div>';
const page = await new b.WebBookService().parseContentPage(
  Object.assign(new b.BookSource(), source,
    { contentRule: source.ruleContent }),
  catalogBook, Object.assign(new b.BookChapter(), { url: 'https://www.linovelib.com/novel/3765/196483.html' }),
  cleanedHtml, 'https://www.linovelib.com/novel/3765/196483.html', new b.RuleContext(), null, null);
assert.ok(page.content.includes('真实第一段。'), '正文必须保留真实段落');
assert.ok(page.content.includes('真实第二段。'), '正文必须保留真实段落');
assert.equal(page.content.split('真实第一段。').length - 1, 2, '原作重复段落不得按句子去重');
assert.ok(!page.content.includes('干扰段'), '干扰段落必须被移除');
assert.ok(!page.content.includes('广告'), '正文广告容器必须被移除');
assert.ok(page.content.includes('绝对定位但可见'), '非零尺寸的绝对定位元素必须保留');

if (layoutResult) {
  console.log(`浏览器布局回归（${browser.name}）：${Object.keys(layoutResult.cases).length} 个用例`);
  for (const [name, value] of Object.entries(layoutResult.cases)) {
    if (value.expectedError) {
      assert.equal(value.ok, false, `${name} 应拒绝保存：${value.html.slice(0, 80)}`);
      assert.ok(value.error.includes(value.expectedError), `${name} 错误信息不符：${value.error}`);
    } else {
      assert.equal(value.ok, true, `${name} 应成功：${value.error}`);
    }
  }
  const normal = layoutResult.cases.normal;
  assert.ok(!normal.text.includes('干扰段A') && !normal.text.includes('干扰段B'), 'absolute+0×0 段落必须被删除');
  assert.ok(normal.text.includes('绝对定位但可见'), '非零尺寸的绝对定位元素必须保留');
  assert.ok(normal.text.includes('真实第一段。'), '正常段落必须保留');
  assert.ok(!normal.text.includes('广告'), '正文广告容器必须被删除');
  assert.ok(normal.text.includes('https://example.test/cover.jpg'), '懒加载图片应改写到 data-src');
  assert.ok(normal.html.startsWith('<!DOCTYPE html>'), '必须返回完整文档，避免空返回回退未过滤 HTML');
  assert.ok(normal.html.includes('真实第二段。'), '整页 HTML 必须保留正文');
} else {
  console.log('提示：未找到 Chrome/Edge，跳过真实浏览器布局回归（净化脚本只做了静态结构检查）');
}

console.log(`PASS 哔哩书源离线回归（单一书源）：URL 白名单、能力路由、书源结构、发现链接改写、` +
  `搜索 ${searchElements.length} 条、详情/目录 ${chapters.length} 条、发现 ${exploreElements.length} 条` +
  `${captureDir ? '（真实抓取样本）' : '（内置结构样本）'}；正文净化${layoutResult ? '经真实浏览器布局验证' : '仅结构验证'}`);

// ---------------------------------------------------------------- 辅助

function findBrowser() {
  const candidates = [
    ['Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['Edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['Chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  ];
  for (const [name, file] of candidates) {
    if (fs.existsSync(file)) return { name, file, ok: true };
  }
  return null;
}

// 用真实浏览器布局执行净化脚本：只有真实 getComputedStyle/getBoundingClientRect 才能证明
// “absolute + 0×0”判定成立。页面完全由本脚本生成，不加载站点资源、不执行站点脚本。
function runLayoutProbe(browser) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linovelib-layout-'));
  const fixture = path.join(dir, 'layout.html');
  fs.writeFileSync(fixture, layoutFixture(), 'utf8');
  let dump = '';
  try {
    dump = execFileSync(browser.file, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--virtual-time-budget=3000', '--dump-dom',
      `file:///${fixture.replace(/\\/g, '/')}`
    ], { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    console.log('提示：浏览器布局回归未能执行：' + (error.message || error));
    return null;
  }
  const match = dump.match(/<pre id="linovelib-layout-result">([\s\S]*?)<\/pre>/);
  if (!match) {
    console.log('提示：浏览器未返回布局结果，跳过真实布局回归');
    return null;
  }
  const decoded = match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return JSON.parse(decoded);
}

function layoutFixture() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>linovelib layout probe</title>
<style>
body{margin:0;font:16px/1.6 serif}
#host{width:900px}
#TextContent{width:900px;min-height:10px}
#TextContent p{position:static;display:block}
#TextContent p.ghost{position:absolute;width:0;height:0;left:-9999px;overflow:hidden}
</style></head><body>
<div id="host"></div>
<script>
var CLEAN = ${cleanLinovelibDocument.toString()};
var BODY = [
  '<div class="dag"><ins class="adsbygoogle">广告</ins></div>',
  '<p id="p1">真实第一段。</p>',
  '<p class="ghost" id="p2">干扰段A</p>',
  '<p id="p3">真实第二段。</p>',
  '<p class="ghost" id="p4">干扰段B</p>',
  '<p id="p5">真实第一段。</p>',
  '<p id="p6" style="position:absolute;width:120px;height:20px">绝对定位但可见</p>',
  '<img id="img1" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="https://example.test/cover.jpg">'
].join('');
function build(inner){ document.getElementById('host').innerHTML = '<div id="TextContent" class="TextContent">' + inner + '</div>'; }
function run(name, setup){
  var out = { ok:false, error:'', html:'', text:'' };
  setup();
  document.getElementById('host').getBoundingClientRect();
  try {
    out.html = CLEAN();
    out.ok = true;
    // 只把净化后的正文容器单独取出：整页 HTML 里仍含本探针脚本自身的模板字符串。
    var doc = new DOMParser().parseFromString(out.html, 'text/html');
    var box = doc.querySelector('#TextContent');
    out.text = box ? box.innerHTML : '';
  }
  catch (error) { out.error = String((error && error.message) || error); }
  return out;
}
window.addEventListener('load', function(){
  var cases = {};
  cases.normal = run('normal', function(){ build(BODY); });
  cases.normal.expectedError = '';
  cases.missingContainer = run('missing', function(){ document.getElementById('host').innerHTML = '<div>无正文容器</div>'; });
  cases.missingContainer.expectedError = '正文容器';
  cases.collapsed = run('collapsed', function(){
    document.getElementById('host').innerHTML = '<div style="position:absolute;width:0;overflow:hidden">' +
      '<div id="TextContent" style="width:100%">' + BODY + '</div></div>';
  });
  cases.collapsed.expectedError = '布局未就绪';
  cases.failureMarker = run('marker', function(){
    build(BODY + '<p>前路曲折……（內容加載失敗！請刷新或更換瀏覽器）</p>');
  });
  cases.failureMarker.expectedError = '内容加载失败';
  cases.blocked = run('blocked', function(){
    build('<center class="center-note">沒有可閱讀的章節<br>內容可能審核未通過或需要足夠的權限</center>');
  });
  cases.blocked.expectedError = '不可阅读';
  cases.empty = run('empty', function(){ build(''); });
  cases.empty.expectedError = '正文为空';
  var pre = document.createElement('pre');
  pre.id = 'linovelib-layout-result';
  pre.textContent = JSON.stringify({cases: cases});
  document.body.appendChild(pre);
});
</script></body></html>`;
}
