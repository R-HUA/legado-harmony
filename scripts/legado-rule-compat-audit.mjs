import { bindings as b } from './search-source-compat-check.mjs';
import assert from 'node:assert/strict';

// Independent synthetic conformance probes, not copies of the tutorial's sources.
// Missing native QuickJS is intentional: distinguish parser semantics from engine availability.
const rows = [];
function probe(name, expected, evaluate) {
  let actual;
  try { actual = evaluate(); } catch (e) { actual = 'ERROR: ' + e.message; }
  const status = JSON.stringify(actual) === JSON.stringify(expected) ? 'supported' : 'gap';
  rows.push({ name, status, expected, actual });
}
const markup = '<section><p class="entry">A<span>X</span>B</p><p class="entry">C</p><p class="entry">D</p></section>';
const extract = rule => new b.AnalyzeRule(markup).getString(rule);
probe('legacy negative index', 'D', () => extract('tag.p.-1@text'));
probe('legacy exclusion', 'C', () => extract('p!0:-1@text'));
probe('legacy bracket index union', 'AXB\nD', () => extract('tag.p[0,2]@text'));
probe('legacy bracket exclusion', 'C', () => extract('tag.p[!0,-1]@text'));
probe('legacy stepped slice', 'AXB\nD', () => extract('tag.p[0:3:2]@text'));
probe('CSS text', 'C', () => extract('@css:p:eq(1)@text'));
probe('CSS ownText', 'A\nC', () => new b.AnalyzeRule('<p>A<span>X</span></p><p>C</p>').getString('@css:p@ownText'));
probe('CSS textNodes', 'A\nB\nC\nD', () => extract('@css:p@textNodes'));
probe('CSS adjacent sibling', 'C\nD', () => extract('@css:p + p@text'));
probe('CSS nth-child expression', 'AXB\nD', () => extract('@css:p:nth-child(odd)@text'));
probe('CSS group document order', 'AXB\nD', () => extract('@css:p:eq(2),p:eq(0)@text'));
probe('CSS html removes script and style', '<div><p>A</p></div>', () =>
  new b.AnalyzeRule('<div><script>bad()</script><style>.bad{}</style><p>A</p></div>').getString('@css:div@html'));
probe('CSS all retains markup', '<div><p>A</p></div>', () =>
  new b.AnalyzeRule('<div><p>A</p></div>').getString('@css:div@all'));
probe('XPath basic attribute', 'x', () => new b.AnalyzeRule('<a href="x">A</a>').getString('//a/@href'));
probe('XPath equality on text', 'C', () => extract('//p[text()="C"]/text()'));
probe('XPath position predicate', 'C\nD', () => extract('//p[position()>1]/text()'));
probe('XPath sibling axis', 'C', () => extract('//p[1]/following-sibling::p[1]/text()'));
probe('XPath direct versus descendant child', 'C', () =>
  new b.AnalyzeRule('<section><div><p>A</p></div><p>C</p></section>').getString('//section/p/text()'));
const data = JSON.stringify({ items: [{ name: 'A', price: 1 }, { name: 'B', price: 5 }] });
probe('JSONPath wildcard', 'A\nB', () => new b.AnalyzeRule(data).getString('$.items[*].name'));
probe('JSONPath recursive property', 'A\nB', () => new b.AnalyzeRule(data).getString('$..name'));
probe('JSONPath numeric filter', 'B', () => new b.AnalyzeRule(data).getString('$.items[?(@.price>2)].name'));
probe('JSONPath aggregate function', '2', () => new b.AnalyzeRule(data).getString('$.items.length()'));
probe('template JSONPath', '/item/A', () => new b.AnalyzeRule(data).getString('/item/{{$.items[0].name}}'));
probe('template CSS', 'C', () => extract('{{@css:p:eq(1)@text}}'));
const script = code => new b.ScriptEngine(new b.JsRuntime()).evalBlock(code, new b.ScriptEngineContext()).value;
probe('legacy JS for loop', '3', () => script('var n=0; for(var i=0;i<3;i++){n++;} n;'));
probe('legacy JS while loop', '3', () => script('var n=0; while(n<3){n++;} n;'));
probe('while requests full JS routing', 'arkweb', () => b.BookSourceRuntimeRouter.decide('toc', 'var n=0; while(n<3){n++;} n;').runtime);
probe('network requests full JS routing', 'arkweb', () => b.BookSourceRuntimeRouter.decide('toc', 'JSON.parse(java.ajax(baseUrl));').runtime);
probe('URL option js retained', true, () => {
  const config = new b.AnalyzeUrl(null, {}).parse('https://example.test,{"js":"java.url=java.url+1"}');
  return !!config.js;
});
probe('java.getElements bridge advertised', [], () => Array.from(b.BookSourceRuntimeRouter.analyze('java.getElements("p")').missingMethods));
probe('java.connect bridge advertised', [], () => Array.from(b.BookSourceRuntimeRouter.analyze('java.connect(baseUrl)').missingMethods));
console.log(JSON.stringify(rows, null, 2));
const gaps = rows.filter(row => row.status === 'gap');
console.log(`Conformance audit: ${rows.length - gaps.length}/${rows.length} probes supported; ${gaps.length} gaps. This is not a global compatibility percentage.`);
assert.ok(rows.find(row => row.name === 'CSS all retains markup').status === 'supported');
