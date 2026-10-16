import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

// 繁简转换门禁：词典数据完整性、转换算法正确性（词组优先/首候选/排除表/直通字符）、
// 设置存储与阅读管线、规则引擎 java.t2s/java.s2t 的接线，全部对齐 HapeLee/legado-with-MD3。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let assertions = 0;

function assert(condition, message) {
  assertions++;
  if (!condition) {
    throw new Error(message);
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readLines(relativePath) {
  return read(relativePath).split('\n').filter((line) => line.trim() && !line.startsWith('#'));
}

// ---- 1. 词典数据（OpenCC ver.1.1.9，原样打包于 rawfile/chinese/）----
const dictDir = 'entry/src/main/resources/rawfile/chinese';
const t2sCharLines = readLines(`${dictDir}/t2s_characters.txt`);
const t2sPhraseLines = readLines(`${dictDir}/t2s_phrases.txt`);
const s2tCharLines = readLines(`${dictDir}/s2t_characters.txt`);
const s2tPhraseLines = readLines(`${dictDir}/s2t_phrases.txt`);
assert(t2sCharLines.length > 4000, `t2s 单字表行数异常: ${t2sCharLines.length}`);
assert(t2sPhraseLines.length > 200, `t2s 词组表行数异常: ${t2sPhraseLines.length}`);
assert(s2tCharLines.length > 3000, `s2t 单字表行数异常: ${s2tCharLines.length}`);
assert(s2tPhraseLines.length > 40000, `s2t 词组表行数异常: ${s2tPhraseLines.length}`);

// ---- 2. 加载 ChineseConverter（剥离 @kit 导入，注入运行时绑定）----
const bindings = {
  console,
  setTimeout: (fn) => fn()
};
const converterSource = read('entry/src/main/ets/utils/ChineseConverter.ts');
const exportedNames = [...converterSource.matchAll(/export (?:class|function|const) (\w+)/g)]
  .map((match) => match[1]);
const stripped = converterSource.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const moduleExports = vm.runInNewContext(stripTypeScriptTypes(stripped, { mode: 'transform' }) +
  '\n;({' + exportedNames.join(',') + '})', bindings);
const converter = moduleExports;
assert(typeof converter.convertWithChineseDictionary === 'function',
  'convertWithChineseDictionary 必须可导入执行');

function buildDictionary(charLines, phraseLines, excludedPhrases) {
  const dict = converter.createEmptyChineseDictionary();
  let cursor = converter.applyChineseDictionaryLines(dict, charLines, 0, charLines.length, false);
  assert(cursor === charLines.length, '单字表应一次解析完成');
  cursor = converter.applyChineseDictionaryLines(dict, phraseLines, 0, phraseLines.length, true,
    excludedPhrases);
  assert(cursor === phraseLines.length, '词组表应一次解析完成');
  return dict;
}

// ChineseConverter 类内部的排除表与解析逻辑走同一套纯函数，这里直接复刻 t2s 方向。
const excludeMatch = converterSource.match(/const T2S_EXCLUDED_PHRASES: string\[\] = \[([\s\S]*?)\];/);
assert(excludeMatch !== null, 'MD3 排除词表必须存在');
const excludedPhrases = JSON.parse(`[${excludeMatch[1].replace(/'/g, '"')}]`);
assert(excludedPhrases.includes('明瞭') && excludedPhrases.includes('雪梨'),
  '排除词表应保留 MD3 fixT2sDict 的条目');

const t2sDict = buildDictionary(t2sCharLines, t2sPhraseLines, excludedPhrases);
const s2tDict = buildDictionary(s2tCharLines, s2tPhraseLines, null);
const t2s = (text) => converter.convertWithChineseDictionary(text, t2sDict);
const s2t = (text) => converter.convertWithChineseDictionary(text, s2tDict);

// ---- 3. 转换正确性 ----
// 单字映射
assert(t2s('頭髮') === '头发', `t2s 单字映射失败: ${t2s('頭髮')}`);
assert(t2s('乾燥') === '干燥', `t2s 首候选失败: ${t2s('乾燥')}`);
assert(t2s('龍的傳人') === '龙的传人', `t2s 组合失败: ${t2s('龍的傳人')}`);
assert(t2s('皇后後面') === '皇后后面', `t2s 後→后 失败: ${t2s('皇后後面')}`);
// 词组最长匹配优先
assert(t2s('一目瞭然') === '一目了然', `t2s 词组匹配失败: ${t2s('一目瞭然')}`);
// 排除表：词组级转换被跳过（瞭 无单字映射，保留原形）
assert(t2s('明瞭') === '明瞭', `t2s 排除表失败: ${t2s('明瞭')}`);
// 非中文与增补平面字符直通
assert(t2s('Hello 123 !?') === 'Hello 123 !?', 't2s ASCII 直通失败');
assert(t2s('𠀀𠀁') === '𠀀𠀁', 't2s 增补平面直通失败');
// s2t：词组消歧（后/乾/发 多字位）
assert(s2t('头发') === '頭髮', `s2t 词组消歧失败: ${s2t('头发')}`);
assert(s2t('皇后后来') === '皇后後來', `s2t 皇后消歧失败: ${s2t('皇后后来')}`);
assert(s2t('干燥干活') === '乾燥幹活', `s2t 干消歧失败: ${s2t('干燥干活')}`);
assert(s2t('书') === '書', `s2t 单字失败: ${s2t('书')}`);
assert(t2s(s2t('書法')) === '书法', `s2t→t2s 往返失败: ${t2s(s2t('書法'))}`);
// 类型归一化
assert(converter.ChineseConverter.normalizeType(1) === 1, 'normalizeType(1) 失败');
assert(converter.ChineseConverter.normalizeType(2) === 2, 'normalizeType(2) 失败');
assert(converter.ChineseConverter.normalizeType(0) === 0, 'normalizeType(0) 失败');
assert(converter.ChineseConverter.normalizeType(7) === 0, 'normalizeType(7) 应归为不转换');
assert(converter.ChineseConverter.normalizeType(Number.NaN) === 0, 'normalizeType(NaN) 应归为不转换');
// 未加载时同步转换必须原样返回（不得抛错、不得空字符串）
assert(converter.ChineseConverter.convertText('頭髮', 1) === '頭髮',
  '词典未加载时 convertText 必须原样返回');

// ---- 4. 性能上界：整章文本（约 4 万字符）单趟转换必须保持有界 ----
const chapterSample = ('　　他望著窗外的雨，手中的書早已翻過一半。髮絲沾著水汽，乾燥的空氣裡混著墨香。\n' +
  '「一目瞭然，」他說，「這件事的來龍去脈，皇后與後來的變故，都要幹脆地講清楚。」\n').repeat(240);
const convertStart = Date.now();
const convertedChapter = t2s(chapterSample);
const convertElapsed = Date.now() - convertStart;
assert(convertedChapter.length === chapterSample.length, 't2s 不得改变文本长度');
assert(convertedChapter.includes('书早已翻过一半'), '整章 t2s 转换结果异常');
assert(convertElapsed < 200, `整章 t2s 转换耗时过长: ${convertElapsed}ms`);

// ---- 5. 接线：设置存储 / 阅读管线 / 规则引擎 / 启动预热 ----
const settings = read('entry/src/main/ets/utils/ReaderSettingsStore.ets');
assert(settings.includes('chineseConverterType: number = 0'), 'ReaderSettings 缺少 chineseConverterType 字段');
assert(settings.includes("KEY_CHINESE_CONVERTER_TYPE: string = 'readerChineseConverterType'"),
  'ReaderSettingsStore 缺少设置键');
assert(settings.includes('saveChineseConverterType(context: Context, converterType: number)'),
  'ReaderSettingsStore 缺少保存方法');
assert(settings.includes('saveChineseConverterType(context, settings.chineseConverterType)'),
  'saveAll 必须持久化 chineseConverterType');
assert(settings.includes('normalizeChineseConverterType'), '缺少类型归一化');

const reader = read('entry/src/main/ets/pages/ReadBook.ets');
assert(reader.includes("@StorageLink('readerChineseConverterType')"), 'ReadBook 缺少 StorageLink');
assert(reader.includes('ChineseConverter.ensureLoaded(getContext(this), this.chineseConverterType)'),
  '正文预处理前必须确保词典就绪');
assert(reader.includes('ChineseConverter.convertText(content, this.chineseConverterType)'),
  '正文预处理必须先做简繁转换');
assert(/converted[^]*?ReaderContentPreprocessor\.apply\(converted/.test(reader),
  '替换净化必须作用于转换后的文本');
assert(reader.includes('ChineseConverter.convertText(title, this.chineseConverterType)'),
  '章节标题必须随设置转换');
assert(reader.includes('`${this.readerReplaceRulesUpdateTime}_${this.chineseConverterType}`'),
  '正文预处理缓存键必须包含转换方向');

const settingsPage = read('entry/src/main/ets/pages/Settings.ets');
assert(settingsPage.includes("this.selectItem('简繁转换'"), '应用设置页缺少简繁转换项');

const ability = read('entry/src/main/ets/entryability/EntryAbility.ets');
assert(ability.includes('ChineseConverter.ensureLoaded(this.context, settings.chineseConverterType)'),
  '启动阶段必须按当前方向预热词典');

const jsRuntime = read('entry/src/main/ets/core/rule/JsRuntime.ts');
assert(jsRuntime.includes("replaceFunctionCalls(expr, 'java.t2s'") &&
  jsRuntime.includes('ChineseConverter.TYPE_T2S'), 'java.t2s 必须接入真实转换');
assert(jsRuntime.includes("replaceFunctionCalls(expr, 'java.s2t'") &&
  jsRuntime.includes('ChineseConverter.TYPE_S2T'), 'java.s2t 必须接入真实转换');
assert(jsRuntime.includes('convertText(this.evalStr(v), ChineseConverter.TYPE_T2S)'),
  'java.t2s 参数求值后必须转换');

const analyzeRule = read('entry/src/main/ets/core/rule/AnalyzeRule.ts');
assert(analyzeRule.includes('jsCode.includes(\'java.t2s\')') &&
  analyzeRule.includes('ChineseConverter.convertText(value, ChineseConverter.TYPE_T2S)'),
  'AnalyzeRule 的 java.t2s 快速路径必须转换');

const scriptEngine = read('entry/src/main/ets/core/rule/ScriptEngine.ts');
assert(scriptEngine.includes("'java.t2s', 'java.s2t'"), 'ScriptEngine 运行时调用表缺少 java.s2t');

console.log(`Chinese converter check passed (${assertions} assertions): OpenCC dictionaries, ` +
  'phrase-first conversion, MD3 exclude list, settings/pipeline/rule-engine wiring, bounded per-chapter cost.');
