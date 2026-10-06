import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';

// 执行实际匹配和导入协调代码，只替换平台网络与媒体类型适配。
const bindings = { console: { warn() {} } };
function load(file, names) {
  const source = fs.readFileSync(new URL('../entry/src/main/ets/' + file, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  Object.assign(bindings, vm.runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }) +
    '\n;({' + names.join(',') + '})', bindings));
}
load('model/data/Book.ts', ['Book', 'BookSource']);
load('core/rule/JavaRegexCompat.ts', ['JavaRegexCompat']);
load('core/book/BookUrlSourceMatcher.ts', ['BookUrlSourceMatcher']);
const { BookSource, BookUrlSourceMatcher: matcher } = bindings;
const source = (site, pattern = '', enabled = true) => Object.assign(new BookSource(), {
  bookSourceUrl: site, bookSourceName: site, bookUrlPattern: pattern, enabled
});
const site = source('https://books.example');
const regex = source('https://api.example', '(?i)https://books\\.example/book/\\d+');
const disabled = source('https://books.example', '', false);
const broken = source('https://broken.example', '(');
const link = 'https://books.example/book/42';
assert.equal(matcher.normalize('  HTTPS://books.example/book/42  '), link);
for (const invalid of ['file:///a', 'javascript:alert(1)', 'https://', 'https://user:pass@books.example/a',
  'https://books.example:99999/a', 'https://books.example/a\nhttps://books.example/b',
  'https://books.example/a,{"method":"POST"}', 'https://books.example\\@evil.example/a']) {
  assert.throws(() => matcher.normalize(invalid), /HTTP/);
}
assert.deepEqual(Array.from(matcher.match(link, [regex, disabled, site, broken]).sources), [site, regex]);
assert.equal(matcher.match(link, [broken]).invalidPatternCount, 1);
assert.equal(matcher.match('https://books.example.evil.test/book/42', [site]).sources.length, 0);
assert.equal(matcher.match('https://evil.test/?next=https://books.example', [site]).sources.length, 0);
assert.equal(matcher.match('https://books.example:8443/book/42', [site]).sources.length, 0);
assert.equal(matcher.match('https://books.example:443/book/42', [site]).sources.length, 1);
assert.equal(matcher.match('http://books.example/book/42', [site]).sources.length, 1);
assert.equal(matcher.match('https://books.example/book/42/extra', [regex]).sources.length, 0);
assert.equal(matcher.match(link, [source('https://api.example', 'book/42')]).sources.length, 0);
assert.equal(matcher.match(link, [source('https://api.example', 'https://books\\.example|https://books\\.example/book/42')]).sources.length, 1);

let requests = [];
let fetchInfo = async (_source, book) => book;
let cancellations = 0;
bindings.WebBookService = class {
  async getBookInfo(source, book) {
    requests.push(source.bookSourceUrl);
    return await fetchInfo(source, book);
  }
  cancelPendingRequests() { cancellations++; }
};
bindings.BookTypeSupport = { applyBookType() {} };
load('core/book/BookUrlImportService.ts', ['BookUrlImportService']);
const { BookUrlImportService } = bindings;
await assert.rejects(new BookUrlImportService().resolve(link, [], () => {}), /未找到匹配/);
assert.equal(requests.length, 0);
await assert.rejects(new BookUrlImportService().resolve(link, [site], () => {}), /未能解析/);
fetchInfo = async (selected, book) => {
  if (selected === site) throw new Error('network failed');
  book.name = '测试书籍'; book.tocUrl = link + '/toc'; return book;
};
requests = [];
const book = await new BookUrlImportService().resolve(link, [site, regex], () => {});
assert.equal(book.origin, regex.bookSourceUrl);
assert.equal(book.name, '测试书籍');
assert.equal(requests.length, 2);
let finish;
fetchInfo = (_source, book) => new Promise(resolve => { finish = () => {
  book.name = '迟到的结果'; book.tocUrl = link; resolve(book);
}; });
const canceled = new BookUrlImportService();
const task = canceled.resolve(link, [site, regex], () => {});
canceled.cancel();
finish();
await assert.rejects(task, /已取消/);
assert.equal(cancellations, 1);
console.log('Book URL import checks passed: URL validation, source precedence, regex matching, failure fallback and cancellation.');
