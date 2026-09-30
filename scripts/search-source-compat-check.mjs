import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';

// Run production URL, parser, batch-field and search coordinator code. Only platform
// I/O and optional native engine availability are substituted. Optional arguments:
// book-source JSON, captured HTML response, keyword. No network is performed here.
const bindings = { console, AppStorage: { get() { return ''; }, setOrCreate() {} } };
function load(file, names) {
  const s = fs.readFileSync(new URL('../entry/src/main/ets/' + file, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  Object.assign(bindings, vm.runInNewContext(stripTypeScriptTypes(s, { mode: 'transform' }) + '\n;({' + names.join(',') + '})', bindings));
}
load('model/data/Book.ts', ['BookSource', 'SearchBook']);
load('core/rule/RuleValue.ts', ['RuleValue', 'RuleValueKind', 'RuleExecutionTarget']);
load('core/rule/RuleContext.ts', ['RuleContext']);
load('core/rule/JsonPathEvaluator.ts', ['JsonPathEvaluator']);
load('core/rule/JavaRegexCompat.ts', ['JavaRegexCompat']);
load('core/book/BookUrlResolver.ts', ['BookUrlResolver']);
load('core/book/BookSourceRuntimeRouter.ts', ['BookSourceRuntimeRouter', 'SourceRuntimeStage']);
load('core/book/EncodedSourceUrl.ts', ['EncodedSourceUrl']);
load('core/book/BookTypeSupport.ts', ['BookTypeSupport']);
load('utils/BookFieldSanitizer.ts', ['BookFieldSanitizer']);
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
  BookSourceStageWebRuntime: { get: () => ({ isAvailable: () => false }) },
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
load('core/rule/AnalyzeRule.ts', ['AnalyzeRule']);
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
    return { success: true, statusCode: 200, body: html, url: request.url, headers: {} };
  }
} });
load('core/rule/AnalyzeUrl.ts', ['AnalyzeUrl']);
load('core/book/SearchCoordinator.ts', ['SearchCoordinator']);
const coordinator = new bindings.SearchCoordinator();
const result = await coordinator.searchOne(source, keyword, {});
console.log('Search result:', result.books.length, result.reason);
assert.ok(result.books.length > 0, result.reason);
const expectedRows = new bindings.AnalyzeRule(html, source.bookSourceUrl).getElements(source.searchRule.bookList).length;
assert.equal(result.books.length, Math.min(expectedRows, 30));
assert.ok(result.books.every(book => book.name && book.bookUrl));
console.log('Search compatibility passed with native QuickJS creation failing. HTTP response is a fixture.');
