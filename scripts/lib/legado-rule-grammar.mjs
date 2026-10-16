// 上游阅读（Legado）书源规则的静态语法检查。
//
// 为什么需要它：本项目的解析器为了容错，接受的写法比上游宽松；书源在这里跑通，不代表能导入阅读。
// 最典型的一条——`@css:` 前缀在本项目里可以出现在 `||` 的每一段，而上游只在**整条规则的最前面**
// 识别一次（AnalyzeByJSoup.SourceRule），重复出现的 `@css:` 会被当成 jsoup 选择器的一部分，
// 直接抛：
//   Could not parse query '@css:.read-btn': unexpected token at '@css:.read-btn'
// 手机上表现为打开书籍时的“详情页出错”。
//
// 这里只复刻上游与「规则字符串形状」有关的判定，不执行规则，也不联网：
//   * AnalyzeRule.splitSourceRule / SourceRule.init / makeUpRule —— `@js:` 分段、`@put:`、`##`
//   * AnalyzeByJSoup.SourceRule                                  —— `@CSS:` 前缀只剥一次
//   * AnalyzeByJSoup.getStringList / getElements                 —— `||`/`&&`/`%%` 分段与取值
//   * AnalyzeByJSoup.ElementsSingle.findIndexSet                 —— `.N` / `!N` / `[N]` 索引
//
// 上游源码：gedoor/legado 主仓已清空，这里引用代码相同的镜像 fork
//   https://github.com/HapeLee/legado-with-MD3/blob/main/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt
//   https://github.com/HapeLee/legado-with-MD3/blob/main/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSoup.kt
//   https://github.com/HapeLee/legado-with-MD3/blob/main/app/src/main/java/io/legado/app/model/analyzeRule/RuleAnalyzer.kt
// 规则文档：https://mgz0227.github.io/The-tutorial-of-Legado/Rule/source.html

/** 与 AppPattern.JS_PATTERN 相同。`@js:` 会吞掉它之后的全部内容。 */
const JS_PATTERN = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;

/** 与 AnalyzeRule.putPattern 相同。 */
const PUT_PATTERN = /@put:(\{[^}]+?\})/gi;

/** 组合分隔符，顺序即上游 splitRule("&&", "||", "%%") 的参数顺序。 */
const COMBINERS = ['&&', '||', '%%'];

/** AnalyzeByJSoup.getResultLast 里被当成“取值方式”而不是属性名的 token。 */
const KNOWN_GETTERS = new Set(['text', 'textNodes', 'ownText', 'html', 'all']);

/** 需要产出“元素列表”的字段：上游走 AnalyzeByJSoup.getElements，整段都当选择器。 */
const ELEMENT_LIST_FIELDS = new Set(['bookList', 'chapterList']);

/**
 * 复刻 AnalyzeRule.splitSourceRule：把 `@js:` / `<js></js>` 段切出来。
 * 返回 [{kind:'rule'|'js', text}]，顺序与上游 ruleList 一致。
 */
export function splitJsSegments(rule) {
  const parts = [];
  let start = 0;
  let match;
  JS_PATTERN.lastIndex = 0;
  while ((match = JS_PATTERN.exec(rule)) !== null) {
    if (match.index > start) {
      const text = rule.slice(start, match.index).trim();
      if (text) parts.push({ kind: 'rule', text });
    }
    parts.push({ kind: 'js', text: match[2] !== undefined ? match[2] : match[1] });
    start = match.index + match[0].length;
    if (match[2] !== undefined) break; // `@js:` 之后的字符都属于 JS
  }
  if (rule.length > start) {
    const text = rule.slice(start).trim();
    if (text) parts.push({ kind: 'rule', text });
  }
  return parts;
}

/** 复刻 AnalyzeRule.splitPutRule：`@put:{...}` 会被摘掉后再解析。 */
function stripPutRule(rule) {
  return rule.replace(PUT_PATTERN, '');
}

/** 复刻 SourceRule.makeUpRule 的 `##` 拆分。 */
function splitRegexParts(rule) {
  const parts = rule.split('##');
  return {
    body: parts[0].trim(),
    tooMany: parts.length > 4
  };
}

/**
 * 复刻 RuleAnalyzer.splitRule("&&", "||", "%%")：按**第一个**出现的分隔符切分，
 * 且不切分选择器里的 `[...]` / `(...)` 与引号内容。
 */
export function splitCombined(branch) {
  let type = '';
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < branch.length; i += 1) {
    const c = branch[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[' || c === '(') { depth += 1; continue; }
    if (c === ']' || c === ')') { depth -= 1; continue; }
    if (depth > 0) continue;
    const token = COMBINERS.find(value => branch.startsWith(value, i));
    if (!token) continue;
    if (!type) type = token;
    if (token !== type) continue;
    parts.push(branch.slice(start, i));
    i += token.length - 1;
    start = i + 1;
  }
  parts.push(branch.slice(start));
  return { type, parts: parts.map(part => part.trim()).filter(part => part.length > 0) };
}

/** 去掉引号内容，避免把属性值里的 `.0` 当成索引。 */
function withoutQuoted(text) {
  return text.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

/**
 * 阅读 Default 规则的索引 token：`.N`（选择）与 `!N`（排除）。
 * 只认「点号/叹号紧跟整数」，因此 `.col-4`、`.mt-3`、`.book-title` 不会命中。
 * 已知限制：不带引号的属性值里出现 `.0` 会被误判。
 */
function indexTokens(selector) {
  const found = [];
  const cleaned = withoutQuoted(selector);
  const pattern = /(?:\.|!)(-?\d+)(?![\w-])/g;
  let match;
  while ((match = pattern.exec(cleaned)) !== null) {
    found.push(match[0]);
  }
  return found;
}

/** Default 规则里索引写在选择器段结尾，由 findIndexSet 摘掉。 */
function stripTrailingIndex(segment) {
  return segment.replace(/\[[^\]]*\]$/, '').replace(/[.!]-?\d+$/, '');
}

/**
 * 判断规则（已去掉 `##`）的模式。与 AnalyzeRule.SourceRule.init 的分支顺序一致。
 * 返回 'css' | 'default' | 'other'，'other' 表示本检查不覆盖的模式（XPath/JsonPath/正则/模板）。
 */
function ruleMode(body) {
  if (/^@css:/i.test(body)) return 'css';
  if (/^@@/.test(body)) return 'default';
  if (/^@xpath:/i.test(body)) return 'other';
  if (/^@json:/i.test(body)) return 'other';
  if (body.startsWith('//') || body.startsWith('/')) return 'other';
  if (body.startsWith('$.') || body.startsWith('$[')) return 'other';
  if (body.startsWith(':')) return 'other'; // AllInOne 正则
  if (body.includes('{{')) return 'other'; // 内嵌规则模板，本次不做形状检查
  return 'default';
}

/** 复刻 RuleAnalyzer.trim() + splitRule("@")：去掉前导 `@`/空白后按 `@` 切开。 */
function splitAtSegments(branch) {
  return branch.replace(/^[@\s]+/, '').split('@').map(part => part.trim()).filter(part => part.length > 0);
}

/**
 * 检查一条规则字符串是否符合上游语法。
 * @param {string} rule 书源里该字段的原始值
 * @param {{field?: string}} [options] field 用于识别元素列表字段
 * @returns {Array<{code: string, message: string}>} 空数组表示通过
 */
export function lintRule(rule, options = {}) {
  const problems = [];
  const field = options.field || '';
  if (!rule || typeof rule !== 'string') return problems;
  const add = (code, message) => problems.push({ code, message });
  const elementList = ELEMENT_LIST_FIELDS.has(field);

  for (const segment of splitJsSegments(stripPutRule(rule))) {
    if (segment.kind !== 'rule') continue;
    const { body, tooMany } = splitRegexParts(segment.text);
    if (tooMany) {
      add('regex-parts', '`##` 最多三段（##正则##替换###），当前超过三段');
      continue;
    }
    if (!body) continue;

    const cssAt = body.search(/@css:/i);
    if (cssAt > 0) {
      // 上游 AnalyzeByJSoup.SourceRule 只认整条规则最前面的 `@CSS:`，其余位置会被送进 jsoup。
      add('css-prefix-position',
        `\`@css:\` 只能出现在规则最前面（当前位置 ${cssAt}）；上游只在开头识别一次，` +
        '其余位置会被当成选择器交给 jsoup，报 Could not parse query');
    }

    const mode = ruleMode(body);
    if (mode === 'other') continue;

    // 只在 CSS 模式下剥掉一次前缀，与上游 AnalyzeByJSoup.SourceRule 一致。
    const effective = mode === 'css' ? body.slice(5).trim() : body;
    const { parts } = splitCombined(effective);

    for (const branch of parts) {
      if (mode === 'css') {
        if (elementList) {
          if (branch.includes('@')) {
            add('list-rule-getter',
              `元素列表字段（${field}）在 CSS 模式下整段都是选择器，不能带 \`@\` 取值：${branch}`);
          }
          continue;
        }
        const atIndex = branch.lastIndexOf('@');
        if (atIndex < 0) {
          add('css-branch-without-getter',
            'CSS 模式下每个分支都要带 `@取值`：上游用 lastIndexOf(\'@\') 切分，缺 `@` 会抛 ' +
            `StringIndexOutOfBoundsException：${branch}`);
          continue;
        }
        const selector = branch.slice(0, atIndex).trim();
        const getter = branch.slice(atIndex + 1).trim();
        if (!selector) {
          add('css-empty-selector',
            `CSS 模式的分支没有选择器（上游执行 select("")，抛 String must not be empty）：${branch}`);
        }
        if (selector.includes('@')) {
          add('css-selector-contains-at',
            `CSS 选择器里不能再出现 \`@\`（多为重复写了 \`@css:\`）：${selector}`);
        }
        const tokens = indexTokens(selector);
        if (tokens.length > 0) {
          add('css-index-token',
            `CSS 选择器里出现了阅读 Default 索引 ${tokens.join('、')}；上游 CSS 模式不做索引解析，` +
            `会把它当成 class/属性字面量而静默取空：${selector}`);
        }
        if (!getter) {
          add('css-empty-getter', `CSS 模式的分支缺少取值方式：${branch}`);
        } else if (!KNOWN_GETTERS.has(getter) && !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(getter)) {
          add('css-getter-invalid', `CSS 取值方式不像属性名或 text/html/all：${getter}`);
        }
        continue;
      }

      // Default 模式：除最后一段外都是选择器，索引只能写在选择器段的结尾。
      const atParts = splitAtSegments(branch);
      const selectors = elementList ? atParts : atParts.slice(0, -1);
      for (const selector of selectors) {
        const tokens = indexTokens(stripTrailingIndex(selector));
        if (tokens.length > 0) {
          add('default-index-not-last',
            `Default 规则的索引只能写在选择器段结尾，中间的 ${tokens.join('、')} 会被当成 class ` +
            `字面量而静默取空：${selector}`);
        }
      }
    }
  }
  return problems;
}

const RULE_OBJECTS = [
  ['ruleSearch', '搜索'],
  ['ruleExplore', '发现'],
  ['ruleBookInfo', '详情'],
  ['ruleToc', '目录'],
  ['ruleContent', '正文']
];

/**
 * 检查整个书源对象里所有 HTML 规则字段。
 * @returns {Array<{where: string, rule: string, code: string, message: string}>}
 */
export function lintSource(source) {
  const findings = [];
  for (const [key, label] of RULE_OBJECTS) {
    const rules = source && source[key];
    if (!rules || typeof rules !== 'object') continue;
    for (const [field, rule] of Object.entries(rules)) {
      if (typeof rule !== 'string') continue;
      for (const problem of lintRule(rule, { field })) {
        findings.push({ where: `${label}.${field}`, rule, ...problem });
      }
    }
  }
  return findings;
}
