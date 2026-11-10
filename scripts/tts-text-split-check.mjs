import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

// 在有执行时限的 VM 中调用生产分块方法，死循环必须失败而不能挂住测试进程。
const raw = fs.readFileSync(new URL('../entry/src/main/ets/utils/SystemTtsReader.ets', import.meta.url), 'utf8');
const source = raw.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const context = vm.createContext({
  console: { info() {}, warn() {}, error() {} },
  TtsPcmAudioPlayer: class {}, HttpTtsReader: class {}, CloudTtsClient: class {},
  // Upstream TTS collaborators that the splitter never calls.
  MimoReadingSession: class {}, LocalTtsSelection: { current() { return null; } }, LocalTtsEngine: {},
  PlaybackLoudnessGain: {}, TtsCustomVoices: {}, TtsVoiceOption: class {}
});
vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) +
  '\nglobalThis.reader = new SystemTtsReader();', context);

let checks = 0;
let failures = 0;
function check(name, action) {
  try {
    action(); checks++; console.log(`OK ${name}`);
  } catch (error) {
    failures++; console.error(`FAIL ${name}: ${error.message}`);
  }
}
function run(expression, text, extra = {}) {
  Object.assign(context, { text, pageBreakOffsets: [], ...extra });
  return vm.runInContext(expression, context, { timeout: 1000 });
}

const routes = [
  { name: '系统 60', expression: 'reader.splitSystemText(text, pageBreakOffsets)', max: () => 60 },
  { name: '自定义 64', expression: 'reader.splitCustomText(text, 64)', max: () => 64 },
  { name: '自定义 450', expression: 'reader.splitCustomText(text, 450)', max: () => 450 },
  { name: '云端标准', expression: 'reader.optionCloudVoiceTier = "STANDARD"; reader.splitCloudText(text)',
    max: index => index === 0 ? 160 : 450 },
  { name: '云端高级', expression: 'reader.optionCloudVoiceTier = "PREMIUM"; reader.splitCloudText(text)',
    max: index => index === 0 ? 100 : 450 },
  { name: '高亮 32', expression: 'reader.splitText(text, 32)', max: () => 32 }
];

function assertChunks(chunks, text, maximum) {
  assert.ok(chunks.length > 0);
  let previousEnd = 0;
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(chunk.start >= previousEnd && chunk.end > chunk.start && chunk.end <= text.length,
      `不前进或偏移越界: ${JSON.stringify(chunk)}`);
    assert.match(text.slice(previousEnd, chunk.start), /^[ \t\n\r\u3000]*$/, '块间丢失正文');
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
    // A sentence tail of at most 8 closing/ending punctuation marks may follow its sentence.
    const over = chunk.text.length - maximum(index);
    assert.ok(over <= 0 || (over <= 8 && /^[”’"'）)】\]》〉」』。！？!?.…；;]+$/.test(chunk.text.slice(-over))),
      `块长度 ${chunk.text.length} 超过上限 ${maximum(index)}`);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk.text), '块尾拆开代理对');
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.text), '块头拆开代理对');
    previousEnd = chunk.end;
  }
  assert.match(text.slice(previousEnd), /^[ \t\n\r\u3000]*$/, '尾部丢失正文');
  if (!/[ \t\n\r\u3000]/.test(text)) assert.equal(chunks.map(chunk => chunk.text).join(''), text);
}

const cases = [
  ['长英文词', 'a'.repeat(1800)],
  ['连续数字', '1234567890'.repeat(180)],
  ['长 URL', 'https://example.invalid/' + 'pathname'.repeat(240) + '?key=' + '1234567890'.repeat(90)],
  ['混合中文英文与表情', ('正文😀' + 'word'.repeat(40) + '3.5米”）结束。').repeat(24)],
  ['硬切边界表情', '中'.repeat(59) + '😀' + '中'.repeat(2) + '😄' + '文'.repeat(1000)],
  ['连续开引号与表情', '😀“'.repeat(500)],
  ['连续闭引号', '”）'.repeat(520) + '正文结束。']
];
for (const route of routes) {
  for (const [name, text] of cases) {
    check(`${route.name} / ${name}`, () => assertChunks(run(route.expression, text), text, route.max));
  }
}

check('复现章节长度 101244 字符的连续英文与数字均可完成分块', () => {
  for (const route of [routes[0], routes[1], routes[3]]) {
    for (const text of ['a'.repeat(101244), '1'.repeat(101244)]) {
      assertChunks(run(route.expression, text), text, route.max);
    }
  }
});

check('当前块起点较大时长词、数字和引号回退仍严格前进', () => {
  for (const text of ['a'.repeat(1800), '1'.repeat(1800), '“'.repeat(1800), '）'.repeat(1800)]) {
    assert.equal(run('reader.safeHardCutIndex(text, 964, 900)', text), 964);
    assert.equal(run('reader.findSentenceBreak(text, 900, 964, 64)', text), 964);
  }
  const text = 'a'.repeat(963) + '😀' + '正文';
  assert.equal(run('reader.safeHardCutIndex(text, 964, 900)', text), 963);
});

check('短词、小数单位和引号保留既有回退位置', () => {
  for (const [text, index, expected] of [
    ['正文helloWorld结尾', 8, 2], ['正文32.5米结束', 4, 2],
    ['正文80分结束', 4, 2], ['正文文字“引用', 4, 3], ['正文。”后续', 3, 2]
  ]) {
    assert.equal(run(`reader.safeHardCutIndex(text, ${index})`, text), expected);
    assert.equal(run(`reader.safeHardCutIndex(text, ${index}, 1)`, text), expected);
  }
});

check('句末闭引号只能有限延长（最多 8 个标点）', () => {
  const text = '中'.repeat(54) + '。' + '”）'.repeat(10) + '尾声';
  const chunks = run('reader.splitSystemText(text, [])', text);
  assertChunks(chunks, text, () => 60);
  assert.equal(chunks[0].end, 68);
});

check('分页切点位于表情中间时保留完整代理对与正文', () => {
  const text = '中'.repeat(20) + '😀' + '文'.repeat(80);
  const chunks = run('reader.splitSystemText(text, pageBreakOffsets)', text, { pageBreakOffsets: [21, 41, 81] });
  assertChunks(chunks, text, () => 60);
});

check('自定义隐藏空白范围之后的长词按绝对起点前进', () => {
  const text = '前文结束。' + ' '.repeat(8) + 'b'.repeat(1200) + '\t'.repeat(8) + '尾文结束。';
  assertChunks(run('reader.splitCustomText(text, 64)', text), text, () => 64);
});

assert.equal(failures, 0, `${failures} 个分块回归组失败`);
console.log(`TTS text split checks passed: ${checks} groups.`);
