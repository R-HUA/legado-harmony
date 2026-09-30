import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { BookSourceRuntimeRouter, SourceRuntimeStage } from '../entry/src/main/ets/core/book/BookSourceRuntimeRouter.ts';
import { BookSourceExecutionJournal, BookSourceHostActionKind } from '../entry/src/main/ets/core/book/BookSourceExecutionJournal.ts';

// Execute the production bridge and coordinator with only platform I/O substituted.
// Optional argument: an external book-source JSON. No real network or credentials are used.
function load(file, names, bindings = {}) {
  const source = fs.readFileSync(new URL('../entry/src/main/ets/core/' + file, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const js = stripTypeScriptTypes(source, { mode: 'transform' });
  return vm.runInNewContext(js + '\n;({' + names.join(',') + '})', {
    console: { info() {}, warn() {}, error() {} }, ...bindings
  });
}
class BookSource { variable = ''; loginInfo = ''; loginHeader = ''; }
class BookChapter { variable = ''; }
class HttpClient {}
class RuleContext {
  loadFromJson() {} put() {} toPersistentRecord() { return {}; } toPersistentJson() { return '{}'; }
}
class RuleFieldRequest { constructor(name, rule) { this.name = name; this.rule = rule; } }
const db = { async getBookSource() { return null; }, async updateBookSourceLoginRuntime() {} };
let cookieValue = 'other=1; session_key=test%3Akey; dotted.name=a=b';
const bindings = {
  SourceRuntimeStage, BookSourceRuntimeRouter, BookSource, BookChapter, HttpClient,
  BookSourceExecutionJournal, BookSourceHostActionKind,
  AppDatabase: { getInstance: () => db },
  CookieStore: { getCookie: () => cookieValue },
  util: {
    TextEncoder: class { encodeInto(s) { return Buffer.from(s); } },
    Base64Helper: class { encodeToStringSync(s) { return Buffer.from(s).toString('base64'); } }
  }
};
const { BookSourceStageWebRuntime, StageWebRuntimeRequest } = load('book/BookSourceStageWebRuntime.ts',
  ['BookSourceStageWebRuntime', 'StageWebRuntimeRequest'], bindings);
const { BookUrlResolver } = load('book/BookUrlResolver.ts', ['BookUrlResolver']);
const { WebBookService } = load('book/WebBookService.ts', ['WebBookService'], {
  ...bindings, BookUrlResolver, RuleContext, RuleFieldRequest,
  EncodedSourceUrl: { decode: () => null },
  BookSourceStageWebRuntime: { get: () => ({ async waitUntilAvailable() { return true; } }) },
  AnalyzeUrl: class { async fetch() { return { success: true, body: '{}', url: 'https://example.test/api' }; } },
  RuleBatchExecutionRequest: class {},
  RuleValue: { jsonValue: (r) => r },
  CooperativeScheduler: { createTimeSlice: () => ({ async checkpoint() {} }) },
  RuleExecutionService: { get: () => ({
    async executeBatch(r) {
      return { values: r.typedContents.map(value => Object.fromEntries(r.fields.map(f =>
        [f.name, String(value[f.rule.replace(/^\$\./, '')] ?? '')]))), contextValues: [], errors: [] };
    }, clearOwner() {}
  }) }
});
function runtime() {
  const instance = new BookSourceStageWebRuntime();
  instance.runJavaScript = async code => vm.runInNewContext(code, { atob, btoa, TextEncoder, TextDecoder }, { timeout: 2000 });
  return instance;
}
function request(code, stage = 'toc', source = {}) {
  const r = new StageWebRuntimeRequest();
  r.applyStageBudget(stage);
  r.source = Object.assign(new BookSource(), { bookSourceUrl: 'https://example.test', bookSourceName: 'fixture' }, source);
  r.baseUrl = r.source.bookSourceUrl + '/book/123';
  r.code = code.replace(/^@?js:\s*/, '');
  return r;
}
const cookieResult = await runtime().executeTask(request('JSON.stringify([java.getCookie(baseUrl,"session_key"),java.getCookie(baseUrl,"dotted.name")])'));
assert.deepEqual(JSON.parse(cookieResult.value), ['test%3Akey', 'a=b']);

const paged = runtime(); let calls = 0;
paged.fetch = async (_r, spec) => {
  calls++;
  const options = JSON.parse(spec.slice(spec.indexOf(',') + 1));
  assert.equal(options.method, 'POST');
  return { success: true, statusCode: 200, body: JSON.stringify({ page: JSON.parse(options.body).page }), headers: {}, url: 'https://example.test/api' };
};
const loop = 'var out=[];for(var p=0;p<30;p++){out.push(JSON.parse(java.ajax("https://example.test/api,"+JSON.stringify({method:"POST",body:JSON.stringify({page:p})}))).page);}JSON.stringify(out)';
assert.deepEqual(JSON.parse((await paged.executeTask(request(loop))).value), Array.from({ length: 30 }, (_, i) => i));
assert.equal(calls, 30, 'replays must not duplicate completed POSTs');
await assert.rejects(paged.executeTask(request(loop, 'content')), /次数过多|步骤过多/);

const service = new WebBookService();
service.seedBookVariables = () => {}; service.seedSourceVariables = () => {};
service.cleanChapterTitle = s => s; service.ruleExpectsHexDataUrlInput = () => false;
const source = { tocRule: { chapterName: '$.title', chapterUrl: '$.url', isVolume: '$.isVol', isVip: '$.locked' }, contentRule: {} };
const rows = [JSON.stringify({ title: 'volume', url: '/volume', isVol: 1 }), JSON.stringify({ title: 'chapter', url: '/1', locked: 1 }), { title: 'plain', url: '/2' }, 'bad json', null];
const chapters = await service.parseStageChapterList(source, { bookUrl: 'https://example.test/book/1' }, JSON.stringify(rows), 'https://example.test');
assert.equal(chapters.length, 2); assert.equal(chapters[0].isVip, true); assert.equal(chapters[1].isVip, false);
service.extractVirtualChapterPayload = () => '';
service.stageDataUrlContentInput = () => '';
service.runStageRule = async (_source, _book, _rule, _body, baseUrl) => baseUrl;
const requestSpec = 'https://example.test/api,' + JSON.stringify({ method: 'POST', body: '{"chapter_id":"1"}' });
assert.equal(await service.tryGetStageContent({ contentRule: { content: '@js:try { result } catch(e) {}' } },
  { bookUrl: 'https://example.test/book/1' }, { url: requestSpec }), requestSpec);

if (process.argv[2]) {
  const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const source = Array.isArray(raw) ? raw[0] : raw;
  assert.equal(BookSourceRuntimeRouter.decide('toc', source.ruleToc.chapterList).runtime, 'arkweb');
  assert.equal(BookSourceRuntimeRouter.decide('content', source.ruleContent.content).runtime, 'arkweb');
  cookieValue = 'other=1; lk_security_key=test%3Akey';
  const engine = runtime(); let requests = 0;
  engine.fetch = async (_r, spec) => {
    requests++;
    const options = JSON.parse(spec.slice(spec.indexOf(',') + 1));
    const body = JSON.parse(options.body);
    assert.equal(options.method, 'POST'); assert.equal(body.security_key, 'test:key');
    let list;
    if (spec.includes('get-book-volumes')) {
      list = body.page === 1 ? Array.from({ length: 20 }, (_, i) => ({ volume_id: i + 1, title: 'volume ' + i })) : [];
    } else {
      list = [{ chapter_id: body.volume_id, title: 'chapter ' + body.volume_id, locked: 1 }];
    }
    return { success: true, statusCode: 200, body: JSON.stringify({ code: 0, data: { list } }), headers: {}, url: source.bookSourceUrl };
  };
  const result = await engine.executeTask(request(source.ruleToc.chapterList, 'toc', source));
  const mapped = { ...source, tocRule: source.ruleToc, contentRule: source.ruleContent };
  const chapters = await service.parseStageChapterList(mapped, { bookUrl: source.bookSourceUrl + '/book/123' }, result.value, source.bookSourceUrl);
  assert.equal(chapters.length, 20); assert.equal(requests, 22);
  const content = runtime(); let retries = 0;
  content.fetch = async (_r, spec) => {
    retries++;
    const body = JSON.parse(JSON.parse(spec.slice(spec.indexOf(',') + 1)).body);
    assert.equal(body.security_key, 'test:key'); assert.equal(body.book_id, '123');
    return { success: true, statusCode: 200, body: JSON.stringify({ code: 0, data: { render_preview: { body_html: '<p><ruby>基底<rt>注音</rt></ruby></p><img src="https://example.test/a.png">' } } }), headers: {}, url: source.bookSourceUrl };
  };
  const r = request(source.ruleContent.content, 'content', source);
  r.baseUrl = chapters[0].url;
  r.content = JSON.stringify({ code: 0, data: { locked: true } });
  const rendered = await content.executeTask(r);
  assert.match(rendered.value, /基底（注音）/); assert.match(rendered.value, /<img src=/); assert.equal(retries, 1);
  cookieValue = 'other=1';
  const guest = await runtime().executeTask(r);
  assert.match(guest.value, /需要登录/);
  r.content = JSON.stringify({ code: 0, data: { render_preview: { body_text: '文字[res]image1[/res]' },
    legacy_resources: { res_info: { image1: { url: 'https://example.test/b.png', type: 'image' } } } } });
  assert.match((await runtime().executeTask(r)).value, /文字[\s\S]*<img src="https:\/\/example.test\/b.png">/);
  console.log('External source: 20 volumes, 22 POSTs, string-array TOC, named Cookie, login retry, ruby and images passed.');
}
console.log('Stage source compatibility checks passed. Platform HTTP/WebView/database are mocked.');
export { BookSourceStageWebRuntime, StageWebRuntimeRequest, request };
