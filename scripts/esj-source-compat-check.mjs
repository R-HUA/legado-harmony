import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BookSourceStageWebRuntime, StageWebRuntimeRequest, request } from './stage-source-compat-check.mjs';
import { bindings as b } from './search-source-compat-check.mjs';
// Resolve Playwright from the developer's installed packages or NODE_PATH. No runtime app dependency.
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const runtime = new BookSourceStageWebRuntime();
  runtime.runJavaScript = code => page.evaluate(code => (0, eval)(code), code);
  const code = String.raw`r=org.jsoup.Jsoup.parse(result).select("#chapterList>*");r.select("p:has(br)").remove();
m=r.select("p.non").eachText();
l=String(r).split(/<p class="non">[\S\s]+?<\/p>/);
for(i=1,j=0;i<l.length;i+=2,j++)l[i]=l[i].replace(/>(\d+(?:-[^<>]+| *))(?=<)/g,">"+m[j]+" $1");l.join("")`;
  const r = request(code);
  r.content = '<div id="chapterList"><div><p><br>remove me</p><p class="non">第一卷</p>' +
    '<p><a href="/chapter/1">1-開始</a><a href="/chapter/2">2-相遇</a></p>' +
    '<p class="non">第二卷</p><p><a href="/chapter/3">3-旅途</a></p></div></div>';
  assert.equal(b.BookSourceRuntimeRouter.decide('toc', code).runtime, 'arkweb');
  const rendered = await runtime.executeTask(r);
  assert.ok(!rendered.value.includes('remove me'));
  const service = new b.WebBookService();
  const book = Object.assign(new b.Book(), { bookUrl: 'https://example.test/book/1' });
  const source = Object.assign(new b.BookSource(), {
    bookSourceUrl: 'https://example.test',
    tocRule: { chapterList: '<js>' + code + '</js>a', chapterName: 'text', chapterUrl: 'a@href' }
  });
  b.StageWebRuntimeRequest = StageWebRuntimeRequest;
  b.BookSourceStageWebRuntime = { get: () => ({
    clearOwner() {},
    async waitUntilAvailable() { return true; },
    execute: req => runtime.executeTask(req)
  }) };
  const stageList = await service.runStageRule(source, book, source.tocRule.chapterList,
    r.content, 'https://example.test', 'toc');
  const chapters = await service.parseStageChapterList(source, book, stageList, 'https://example.test');
  // The imported script deliberately increments i by 2: the next split segment is unchanged.
  assert.deepEqual(Array.from(chapters, c => c.title), ['第一卷 1-開始', '第一卷 2-相遇', '3-旅途']);
  assert.deepEqual(Array.from(chapters, c => c.url), [1, 2, 3].map(i => `https://example.test/chapter/${i}`));
  const loop = await runtime.executeTask(request('var n=0;while(n<3){n++;}String(n)'));
  assert.equal(loop.value, '3');
  const simple = await service.runStageRule(source, book, '<js>"simple"</js>', '', 'https://example.test', 'bookInfo');
  assert.equal(simple, 'simple', 'a complete simple stage script must not fall between two engines');
  console.log('ESJ production bridge + real DOM + production HTML TOC fields: 3 chapters passed; while passed. Website response is synthetic.');
} finally { await browser.close(); }
