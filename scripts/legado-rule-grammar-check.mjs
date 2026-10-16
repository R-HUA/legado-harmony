// 用上游阅读（Legado）的规则语法检查一份书源 JSON。
//
//   node scripts/legado-rule-grammar-check.mjs                     # 检查 scripts/lib 生成的哔哩轻小说源
//   node scripts/legado-rule-grammar-check.mjs <book-source.json>  # 检查任意书源文件（数组或单对象）
//
// 退出码 0 表示没有发现上游必然失败的写法；1 表示有发现（会逐条打印字段、规则与原因）。
// 判定依据与已知限制见 scripts/lib/legado-rule-grammar.mjs 顶部注释。
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { lintRule, lintSource } from './lib/legado-rule-grammar.mjs';
import { buildSource } from './lib/linovelib-source.mjs';

// 自检：检查器本身必须能认出这次真实故障的写法，否则“没有发现问题”没有意义。
// 前三条都来自修复前的 docs/book-sources/local/bilinovel.json。
const selfTest = [
  ['@css:a[href$="/catalog"].0@href||@css:.read-btn@href##^javascript:[\\s\\S]*',
    ['css-index-token', 'css-selector-contains-at']],
  ['@css:.book-dec p.1@text||@css:.book-dec p.0@text',
    ['css-index-token', 'css-selector-contains-at']],
  ['@css:.au-name a.0@text', ['css-index-token']],
  // 前缀不在最前面时上游完全认不出 CSS 模式，同样要报。
  ['a@href||@css:.read-btn@href', ['css-prefix-position']],
  // 元素列表字段在 CSS 模式下整段都是选择器，不能带 `@取值`。
  ['@css:.book-list@text', []],
  ['class.au-name@tag.a.0@text', []],
  ['@css:a[href$="/catalog"]@href||.read-btn@href##^javascript:[\\s\\S]*', []]
];
for (const [rule, expected] of selfTest) {
  const actual = lintRule(rule).map(problem => problem.code);
  for (const code of expected) {
    assert.ok(actual.includes(code),
      `自检失败：${rule} 应报 ${code}，实际 ${JSON.stringify(actual)}`);
  }
  if (expected.length === 0) {
    assert.deepEqual(actual, [], `自检失败：${rule} 不应报任何问题，实际 ${JSON.stringify(actual)}`);
  }
}

function loadSources() {
  const file = process.argv[2];
  if (!file) return { label: 'scripts/lib/linovelib-source.mjs', sources: buildSource() };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { label: file, sources: Array.isArray(parsed) ? parsed : [parsed] };
}

const { label, sources } = loadSources();
let findings = 0;
for (const source of sources) {
  const name = source.bookSourceName || source.bookSourceUrl || '(未命名书源)';
  const problems = lintSource(source);
  if (problems.length === 0) {
    console.log(`OK   ${name}：规则写法符合上游阅读语法`);
    continue;
  }
  findings += problems.length;
  console.log(`FAIL ${name}：${problems.length} 处写法会在上游阅读里解析失败或静默取空`);
  for (const problem of problems) {
    console.log(`  - [${problem.code}] ${problem.where}`);
    console.log(`      规则：${problem.rule}`);
    console.log(`      原因：${problem.message}`);
  }
}

if (findings > 0) {
  console.log(`\n共 ${findings} 处问题（检查对象：${label}）`);
  process.exit(1);
}
console.log(`\n上游语法检查通过（检查对象：${label}，共 ${sources.length} 个书源）`);
