import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';

// Run production URL, parser, batch-field and search coordinator code. Only platform
// I/O and optional native engine availability are substituted. Optional arguments:
// book-source JSON, captured HTML response, keyword. No network is performed here.
const bindings = { console, AppStorage: { get() { return ''; }, setOrCreate() {} } };
function load(file, names, aliases = {}) {
  let s = fs.readFileSync(new URL('../entry/src/main/ets/' + file, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  for (const [original, replacement] of Object.entries(aliases)) s = s.replace(new RegExp('\\b' + original + '\\b', 'g'), replacement);
  Object.assign(bindings, vm.runInNewContext(stripTypeScriptTypes(s, { mode: 'transform' }) + '\n;({' + names.join(',') + '})', bindings));
}
load('model/data/Book.ts', ['BookSource', 'SearchBook', 'Book', 'BookChapter']);
load('core/rule/RuleValue.ts', ['RuleValue', 'RuleValueKind', 'RuleExecutionTarget']);
load('core/rule/RuleContext.ts', ['RuleContext']);
load('core/rule/JsonPathEvaluator.ts', ['JsonPathEvaluator']);
load('core/rule/JavaRegexCompat.ts', ['JavaRegexCompat']);
load('core/book/BookUrlResolver.ts', ['BookUrlResolver']);
load('core/book/BookSourceRuntimeRouter.ts', ['BookSourceRuntimeRouter', 'SourceRuntimeStage']);
load('core/book/EncodedSourceUrl.ts', ['EncodedSourceUrl']);
load('core/book/BookTypeSupport.ts', ['BookTypeSupport']);
load('utils/BookFieldSanitizer.ts', ['BookFieldSanitizer']);
load('utils/BookDisplayHelper.ets', ['BookDisplayHelper']);
load('core/book/BookSourceDebugModels.ts', ['BookSourceDebugContext', 'BookSourceDebugNetworkTrace',
  'BookSourceDebugRuleTrace', 'BookSourceDebugRedactor']);
load('utils/CoverUrlNormalizer.ts', ['CoverUrlNormalizer']);
load('core/book/BookSourceDataUrlSupport.ts', ['BookSourceDataUrlSupport']);
load('core/book/BookSourceMetadataSupport.ts', ['BookSourceMetadataSupport']);
Object.assign(bindings, {
  QuickJsShadowComparator: { compare() {} },
  QuickJsObservationContext: class {},
  QuickJsScriptRuntime: { isPureExpressionCandidate() { return false; } },
  CookieStore: { getCookie() { return ''; } },
  BookSourceScriptRunner: { loginEntryUrl() { return ''; } },
  ScriptEngine: class {},
  BookSourceStageWebRuntime: { get: () => ({ isAvailable: () => false, clearOwner() {} }) },
  BookSourceStageRuleSupport: { async getElements() { return null; } },
  CooperativeCancellationToken: class { throwIfCancelled() {} isCancelled() { return false; } },
  CooperativeScheduler: { createTimeSlice: () => ({ async checkpoint() { return false; } }),
    async yieldToNextUiFrame() {}, reportSynchronousOperation() {} }
});
load('core/http/VerificationSupport.ts', ['VerificationSupport']);
load('core/http/RequestSessionSupport.ts', ['RequestSessionSupport']);
load('core/http/BookSourceRateLimiter.ts', ['BookSourceRateLimiter']);
Object.assign(bindings, {
  JSRuntimeOptions: class {},
  JSContext: class { constructor() { throw new Error('native runtime unavailable'); } },
  QuickJsRuntimeStatus: { isHealthy: () => false }, QuickJsValidationStore: { isValidationTarget: () => false }
});
load('core/script/QuickJsScriptRuntime.ts', ['QuickJsScriptRuntime']);
const unavailable = bindings.QuickJsScriptRuntime.evaluateResidualExpression('String("value")', {}, 80);
assert.equal(unavailable.success, false);
assert.match(unavailable.error, /native runtime unavailable/);
load('core/rule/JsRuntime.ts', ['JsRuntime']);
load('core/rule/ScriptCompatibility.ts', ['ScriptCompatibility']);
load('core/rule/ScriptEngine.ts', ['ScriptEngine', 'ScriptEngineContext', 'ScriptEvalResult']);
load('core/rule/AnalyzeRule.ts', ['AnalyzeRule']);
const statsHtml = '<div class="column"><i class="icon-star-s"></i>9.4</div>' +
  '<div class="column"><i class="icon-eye"></i>12</div>' +
  '<div class="column"><i class="icon-heart"></i>3</div>';
const statsRule = '{{@css:.column:has(.icon-star-s)@text}},关注：{{@css:.column:has(.icon-eye)@text}},' +
  '喜欢：{{@css:.column:has(.icon-heart)@text}}';
assert.equal(new bindings.AnalyzeRule(statsHtml).getString(statsRule), '9.4,关注：12,喜欢：3');
assert.equal(new bindings.AnalyzeRule(statsHtml).getString('{{@css:.absent@text}}'), '');
assert.equal(bindings.BookFieldSanitizer.clean('@css:.column:has(.icon-eye)@text'), '');
const chapterHtml = '<div class="modal-content"><form>檢舉類型 劇透 辱罵攻擊 取消 送出</form></div>' +
  '<div class="forum-content mt-3"><p>真正的第一段正文。</p><p>第二段正文。</p></div>' +
  '<div class="footer">頁尾控件</div>';
const chapterRule = '@css:div.forum-content.mt-3,div[class =d_post_content j_d_post_content]@all';
const extractedChapter = new bindings.AnalyzeRule(chapterHtml).getString(chapterRule);
assert.ok(extractedChapter.includes('真正的第一段正文。'));
assert.ok(extractedChapter.includes('<p>第二段正文。</p>'));
assert.ok(!extractedChapter.includes('檢舉類型') && !extractedChapter.includes('頁尾控件'));
const alternateHtml = '<div class="modal-content">檢舉類型</div>' +
  '<div class="d_post_content j_d_post_content"><p>另一分支的正文。</p></div>';
assert.equal(new bindings.AnalyzeRule(alternateHtml).getString(chapterRule),
  '<div class="d_post_content j_d_post_content"><p>另一分支的正文。</p></div>');
assert.equal(new bindings.AnalyzeRule(chapterHtml).getString('@css:div[???]@all'), '');
assert.deepEqual(Array.from(bindings.BookDisplayHelper.splitTags('9.4,关注：12,喜欢：3')), ['9.4', '关注：12', '喜欢：3']);
const verifySource = Object.assign(new bindings.BookSource(), {
  bookSourceUrl: 'https://example.test', loginUrl: 'https://example.test/login'
});
assert.equal(bindings.VerificationSupport.shouldRequestBrowserVerification(verifySource, '', 0), false);
assert.equal(bindings.VerificationSupport.shouldRequestBrowserVerification(verifySource, 'Cloudflare error code: 522', 522), false);
assert.equal(bindings.VerificationSupport.shouldRequestBrowserVerification(verifySource, '<title>Just a moment...</title>', 403), true);
assert.equal(bindings.VerificationSupport.pickVerificationUrl(verifySource,
  'https://example.test/search?q=books', '', '<title>Just a moment...</title>', 403),
  'https://example.test/search?q=books');
assert.equal(bindings.VerificationSupport.pickVerificationUrl(verifySource,
  'https://example.test/search', '', '<input type="password">', 200), 'https://example.test/login');
// Exercise production cookie/header preparation and diagnostics, replacing only transport.
load('core/http/HttpClient.ts', ['DiagnosticHttpClient'], { HttpClient: 'DiagnosticHttpClient' });
const cookieRequests = [];
const cookieClient = new bindings.DiagnosticHttpClient();
cookieClient.executeInternal = async request => {
  cookieRequests.push(request);
  return { success: true, statusCode: 200, body: 'ok', headers: {}, url: request.url };
};
bindings.CookieStore.getCookie = url => url.startsWith('https://example.test/') ? 'session=private-value' : '';
const cookieDebug = new bindings.BookSourceDebugContext();
cookieDebug.beginStep('search', 'cookies');
await cookieClient.execute({ url: 'https://example.test/search', method: 'GET', debugContext: cookieDebug });
assert.equal(cookieRequests[0].headers.Cookie, 'session=private-value');
assert.deepEqual(Array.from(cookieDebug.session.steps[0].requests[0].cookieNames), ['session']);
assert.ok(!JSON.stringify(cookieDebug.session).includes('private-value'));
await cookieClient.execute({ url: 'https://example.test/search', method: 'GET', headers: { cookie: 'explicit=source-value' } });
assert.equal(cookieRequests[1].headers.cookie, 'explicit=source-value');
assert.ok(!('Cookie' in cookieRequests[1].headers), 'case-insensitive explicit Cookie must not be duplicated');
await cookieClient.execute({ url: 'https://example.test/search', method: 'GET', useCookieJar: false });
assert.ok(!('Cookie' in cookieRequests[2].headers));
await cookieClient.execute({ url: 'https://other.test/search', method: 'GET' });
assert.ok(!('Cookie' in cookieRequests[3].headers));
bindings.CookieStore.getCookie = () => '';
load('core/rule/RuleExecutionModels.ts', ['RuleBatchExecutionRequest', 'RuleBatchExecutionResult', 'RuleFieldRequest']);
load('core/rule/RuleExecutionService.ts', ['RuleExecutionService']);
const raw = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : {
  bookSourceUrl: 'https://example.test', searchUrl: '/search?query={{key}}&page={{page}}',
  ruleSearch: { bookList: 'class.search-book-row', name: 'class.search-book-body.0@tag.h2.0@text',
    author: 'class.search-book-meta.0@tag.span.0@text##作者：', bookUrl: 'class.search-book-link.0@href' }
};
const imported = Array.isArray(raw) ? raw[0] : raw;
const source = Object.assign(new bindings.BookSource(), imported, {
  searchRule: imported.ruleSearch, exploreRule: imported.ruleExplore,
  tocRule: imported.ruleToc, contentRule: imported.ruleContent, bookInfoRule: imported.ruleBookInfo
});
const keyword = process.argv[4] || '乙女游戏';
const html = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') :
  '<main>' + [1, 2].map(i => `<article class="search-book-row"><a class="search-book-link" href="/book/${i}">` +
    `<div class="search-book-body"><h2>乙女游戏 ${i}</h2><div class="search-book-meta"><span>作者：测试作者</span></div></div>` +
    '</a></article>').join('') + '</main>';
const js = new bindings.JsRuntime();
js.setVar('key', encodeURIComponent(keyword));
js.setVar('page', '1');
assert.equal(js.evalTemplate('{{key}}'), encodeURIComponent(keyword));
assert.equal(js.evalTemplate('{{page}}'), '1');
assert.equal(js.evaluate('key + " suffix"'), encodeURIComponent(keyword) + ' suffix');
Object.assign(bindings, { HttpClient: class {
  async execute(request) {
    console.log('Request:', request.url);
    assert.equal(new URL(request.url).searchParams.get('query'), keyword, 'keyword must not gain quotation marks');
    if (request.debugContext) {
      const trace = new bindings.BookSourceDebugNetworkTrace();
      trace.url = request.url; trace.statusCode = 200; trace.bodyPreview = html;
      request.debugContext.addNetwork(trace);
    }
    return { success: true, statusCode: 200, body: html, url: request.url, headers: {} };
  }
} });
load('core/rule/AnalyzeUrl.ts', ['AnalyzeUrl']);
load('core/book/SearchCoordinator.ts', ['SearchCoordinator']);
const coordinator = new bindings.SearchCoordinator();
const debug = new bindings.BookSourceDebugContext(source.bookSourceUrl, source.bookSourceName, 'search');
const result = await coordinator.searchOne(source, keyword, { debugContext: debug });
console.log('Search result:', result.books.length, result.reason);
assert.ok(result.books.length > 0, result.reason);
const expectedRows = new bindings.AnalyzeRule(html, source.bookSourceUrl).getElements(source.searchRule.bookList).length;
assert.equal(result.books.length, Math.min(expectedRows, 30));
assert.ok(result.books.every(book => book.name && book.bookUrl));
assert.equal(debug.session.steps[0].status, 'passed');
assert.equal(debug.session.steps[0].requests[0].statusCode, 200);
assert.ok(debug.session.steps[0].rules.some(rule => rule.field === 'name' && rule.outputPreview));
load('core/rule/AjaxRuleCompat.ts', ['AjaxRuleCompat']);
load('core/book/ReaderImageMarker.ts', ['ReaderImageMarker']);
load('core/book/ReaderActionMarker.ts', ['ReaderActionMarker']);
load('core/book/WebBookService.ts', ['WebBookService']);
const contentSource = Object.assign(new bindings.BookSource(), { contentRule: { content: chapterRule } });
const contentDebug = new bindings.BookSourceDebugContext();
contentDebug.beginStep('content', 'chapter fixture');
const contentService = new bindings.WebBookService();
const parsedPage = await contentService.parseContentPage(contentSource, new bindings.Book(), new bindings.BookChapter(),
  chapterHtml, 'https://example.test/chapter', new bindings.RuleContext(), null, contentDebug);
assert.equal(parsedPage.content, '真正的第一段正文。\n\n第二段正文。');
const missingPage = await contentService.parseContentPage(contentSource, new bindings.Book(), new bindings.BookChapter(),
  '<div class="modal-content">檢舉類型 劇透 辱罵攻擊 垃圾廣告 其他 備註 取消 送出</div>',
  'https://example.test/chapter', new bindings.RuleContext(), null, contentDebug);
assert.equal(missingPage.content, '', 'an explicit unmatched rule must not fall back to page controls');
assert.ok(contentDebug.session.logs.some(log => log.message.includes('正文规则未匹配')));
console.log('Search compatibility passed with native QuickJS creation failing. HTTP response is a fixture.');
export { bindings, load };
