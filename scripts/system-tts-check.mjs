import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { readEtsModule } from './lib/ets-module-staging.mjs';

// 执行生产代码，以可控的系统、存储和播放回调验证离线契约与播放完成边界。
const storage = new Map();
const timers = new Map();
let timerSerial = 0;
let now = 100000;
let checks = 0;
const calls = { queries: [], engines: [], downloads: [], speaks: [], toasts: [], stops: 0,
  moduleQueries: 0 };
let voices = [];
let queryError;
let downloadImpl;
let engine;
function createMockEngine(name) {
  return {
    name, isShutdown: false,
    setListener(listener) { this.listener = listener; },
    speak(text, params) { calls.speaks.push({ text, params }); },
    stop() { calls.stops++; }, shutdown() { this.isShutdown = true; }, isBusy() { return false; }
  };
}
class PcmPlayer {
  segments = [];
  stopped = false;
  async writeSegment(pcm, rate, cue) { this.segments.push({ pcm, rate, cue }); }
  async pause() {} async resume() {} async drain() {} release() {}
  stop() { this.stopped = true; }
  debugState() { return 'mock'; }
}
class HttpReader {
  async pause() {} async resume() {} stop() {} release() {} debugState() { return 'mock'; }
}
const preferenceData = new Map();
const preferences = {
  async getPreferences() { return {
    async get(key, fallback) { return preferenceData.has(key) ? preferenceData.get(key) : fallback; },
    async put(key, value) { preferenceData.set(key, value); }, async flush() {}
  }; }
};
const bindings = {
  console: { info() {}, warn() {}, error() {} },
  Date: class extends Date { static now() { return now; } },
  ArrayBuffer, Uint8Array, Int16Array, Float32Array,
  setTimeout(fn, delay = 0) { const id = ++timerSerial; timers.set(id, { fn, dueAt: now + delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
  AppStorage: { get(key) { return storage.get(key); }, setOrCreate(key, value) { storage.set(key, value); } },
  preferences,
  deviceInfo: { sdkApiVersion: 26 },
  textToSpeech: {
    async listVoices(params) { calls.moduleQueries++; calls.queries.push(params); if (queryError) throw queryError; return voices; },
    async createEngine(params) { calls.engines.push(params); engine = createMockEngine(params.extraParams.name); return engine; },
    downloadVoice(params, callback) { calls.downloads.push(params); downloadImpl(params, callback); }
  },
  TtsPcmAudioPlayer: PcmPlayer, HttpTtsReader: HttpReader, CloudTtsClient: class { stop() {} }, HttpTTS: class {},
  TtsAudioSession: { async acquire() {}, release() {} },
  getContext() { return {}; },
  HdsFeedback: { showToast(text) { calls.toasts.push(text); } }
};
const context = vm.createContext(bindings);
function load(file) {
  const raw = readEtsModule(file);
  const names = [...raw.matchAll(/export (?:class|enum) (\w+)/g)].map(match => match[1]);
  const source = raw.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  Object.assign(bindings, vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) +
    '\n;({' + names.join(',') + '})', context));
}
load('utils/TtsSettingsStore.ets');
load('utils/SystemTtsReader.ets');
load('utils/TtsVoiceCatalog.ets');
const { SystemTtsReader: Reader, TtsVoiceOption: Voice, TtsSettingsStore: Store } = bindings;

// ArkUI DSL 不在 Node 中执行；抽取原页面全部非 Builder 方法，仍调用原方法体。
const pageSource = fs.readFileSync(new URL('../entry/src/main/ets/pages/TtsSettings.ets', import.meta.url), 'utf8');
const pageLines = pageSource.split(/\r?\n/);
const methods = [];
for (let i = 0; i < pageLines.length; i++) {
  const match = /^  (?:(?:private|public|static|async) )*(\w+)\(/.exec(pageLines[i]);
  if (!match || match[1] === 'build' || pageLines[i - 1]?.trim() === '@Builder') continue;
  let end = i + 1;
  while (end < pageLines.length && pageLines[end] !== '  }') end++;
  assert.ok(end < pageLines.length, `Unclosed page method: ${match[1]}`);
  methods.push(pageLines.slice(i, end + 1).join('\n'));
  i = end;
}
const Page = vm.runInContext(stripTypeScriptTypes('class TestTtsSettingsPage {\n' + methods.join('\n') +
  '\n}\nTestTtsSettingsPage', { mode: 'transform' }), context);
bindings.TtsSettingsPage = Page;
function page() {
  return Object.assign(new Page(), {
    voices: [], cloudVoices: [], customVoices: [], ttsPerson: 13, ttsOnline: 1,
    ttsStyle: '', ttsLanguage: 'zh-CN', ttsSpeed: 1, ttsCustomVoiceId: '', ttsCustomVoices: '',
    ttsCloudVoiceId: '', ttsInstalledVoiceKeys: '', selectedVoiceKey: '', isLoadingVoices: false,
    downloadingVoiceKey: '', downloadProgressText: '', isPreviewing: false,
    previewReader: new Reader(), context: {},
    pageActive: true, pageSessionSerial: 1, voiceLoadSerial: 0, downloadSessionSerial: 0,
    previewSessionSerial: 0, voiceSelectionSerial: 0, isLoadingSettings: false,
    voiceDownloadTask: null, voiceLoadError: '', speedSaveTimerId: -1
  });
}
async function check(name, action) {
  await action(); checks++; console.log(`OK ${name}`);
}
const rawVoice = (person, status, language = 'zh-CN') =>
  ({ person, status, language, style: 'interaction-broadcast', gender: person === 21 ? 'Male' : 'Female', description: '' });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function advance(ms) {
  const target = now + ms;
  for (;;) {
    const due = [...timers].filter(([, timer]) => timer.dueAt <= target)
      .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0])[0];
    if (!due) break;
    const [id, timer] = due;
    now = Math.max(now, timer.dueAt);
    timers.delete(id);
    timer.fn();
    await tick();
  }
  now = target;
  await tick();
}
const settlePcm = () => advance(Reader.SYSTEM_PCM_SETTLE_DELAY_MS);
const emptyPcmGrace = () => advance(Reader.SYSTEM_PCM_EMPTY_GRACE_MS);

await check('旧设置、偏好与显式参数统一离线，旧女声别名可读', async () => {
  storage.set('ttsOnline', 0); storage.set('ttsPerson', 0);
  storage.set('ttsCustomVoiceId', 'custom-test'); storage.set('ttsInstalledVoiceKeys', '21_1_zh-CN_');
  const fromStorage = Store.fromStorage();
  assert.equal(fromStorage.online, 1); assert.equal(fromStorage.person, 13);
  assert.equal(fromStorage.customVoiceId, 'custom-test');
  preferenceData.set('ttsOnline', 0); preferenceData.set('ttsPerson', 0);
  Store.cachedSettings = null;
  const loaded = await Store.load({});
  assert.equal(loaded.online, 1); assert.equal(loaded.person, 13);
  loaded.online = 0; await Store.save({}, loaded);
  assert.equal(preferenceData.get('ttsOnline'), 1); assert.equal(storage.get('ttsOnline'), 1);
  const reader = new Reader();
  assert.equal(reader.getTtsOnline(), 1);
  storage.set('ttsCustomVoiceId', '');
});

await check('模块离线查询尊重系统音色状态，不创建播放引擎或触发下载', async () => {
  const moduleQueries = calls.moduleQueries;
  const engineCount = calls.engines.length; const downloadCount = calls.downloads.length;
  voices = [rawVoice(0, 'INSTALLED'), rawVoice(13, 'INSTALLED'), rawVoice(21, 'GA'), rawVoice(8, 'EOM', 'en-US')];
  let list = await Reader.listAvailableVoices();
  assert.equal(list.filter(v => v.id === 0 || v.id === 13).length, 1);
  assert.equal(list.find(v => v.id === 21).downloadable, true);
  assert.equal(list.find(v => v.id === 21).available, false);
  assert.equal(list.find(v => v.id === 8).available, false);
  voices = [rawVoice(21, 'UNKNOWN')];
  list = await Reader.listAvailableVoices();
  assert.equal(list.find(v => v.id === 21).available, false);
  assert.equal(list.find(v => v.id === 21).downloadable, false);
  voices = [rawVoice(13, undefined), rawVoice(21, undefined)];
  list = await Reader.listAvailableVoices();
  assert.equal(list.find(v => v.id === 21).available, false);
  assert.equal(list.find(v => v.id === 21).downloadable, false);
  assert.equal(list.find(v => v.id === 13).available, true, '无状态试用只适用于默认女声');
  assert.equal(list.find(v => v.id === 13).downloadable, false);
  queryError = Error('query failed');
  await assert.rejects(Reader.listAvailableVoices(), /query failed/); queryError = undefined;
  assert.equal(calls.moduleQueries, moduleQueries + 4);
  assert.equal(calls.engines.length, engineCount);
  assert.equal(calls.downloads.length, downloadCount);
  assert.ok(calls.queries.every(q => q.online === 1));
});

await check('下载原参数、终态解绑与已下载状态', async () => {
  const voice = Object.assign(new Voice(), { id: 21, online: 1, language: 'zh-CN',
    downloadLanguage: 'zh-CN', style: 'interaction-broadcast', systemStatus: 'GA', status: 'GA', downloadable: true });
  const listeners = new Map(); const removed = [];
  downloadImpl = (params, cb) => {
    cb(null, { on(type, fn) { listeners.set(type, fn); }, off(type) { removed.push(type); } });
    Promise.resolve().then(() => listeners.get('complete')(rawVoice(21, 'INSTALLED')));
  };
  await Reader.downloadVoice(voice);
  assert.equal(calls.downloads.at(-1).language, 'zh-CN');
  assert.equal(calls.downloads.at(-1).style, 'interaction-broadcast');
  assert.equal(removed.length, 5);
  downloadImpl = (_params, cb) => cb({ code: 1002300010 }, null);
  await Reader.downloadVoice(voice);
  for (const type of ['cancel', 'error']) {
    const before = calls.downloads.length;
    downloadImpl = (_params, cb) => {
      cb(null, { on(event, fn) { listeners.set(event, fn); }, off() {} });
      Promise.resolve().then(() => listeners.get(type)(type === 'error' ? { code: 1002300008 } : 'cancelled'));
    };
    await assert.rejects(Reader.downloadVoice(voice));
    assert.equal(calls.downloads.length, before + 1);
  }
});

await check('长章节分块、表情、正文标记及纯标点尾部', async () => {
  const reader = new Reader();
  for (const text of ['中文句子。'.repeat(3000), '长'.repeat(12001), '😀故事。'.repeat(2200),
    '内容\n*****\n正文结束。……']) {
    const normalized = reader.normalizeText(text);
    const chunks = reader.coalescePunctuationOnlyChunks(reader.splitSystemText(normalized, []), normalized);
    assert.ok(chunks.length);
    let end = 0;
    for (const chunk of chunks) {
      assert.ok(chunk.start >= end && chunk.end > chunk.start); end = chunk.end;
      const speech = reader.normalizeChunkForSpeech(chunk.text, chunk.end < normalized.length);
      assert.ok(speech.length <= 10000);
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk.text));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.text));
    }
  }
});

await check('PCM 序号零按实际序号合并，格式及帧校验', async () => {
  const reader = new Reader();
  const merged = reader.mergeSystemPcmBuffers([new Uint8Array([3, 4]).buffer, new Uint8Array([1, 2]).buffer], [1, 0], 4);
  assert.deepEqual([...new Uint8Array(merged)], [1, 2, 3, 4]);
  assert.throws(() => reader.normalizeSystemPcm(new ArrayBuffer(3), 16, 1, 'pcm'));
  assert.throws(() => reader.normalizeSystemPcm(new ArrayBuffer(4), 16, 1, 'mp3'));
});

await check('朗读和试听引擎互相隔离，模块查询不创建引擎，关闭试听不影响朗读', async () => {
  const before = calls.engines.length;
  const reading = new Reader(); const preview = new Reader();
  await reading.start('阅读中的正文。');
  const readingEngine = reading.engine; const readingListener = readingEngine.listener;
  const readingRequest = reading.currentRequestId;
  await preview.start('试听中的正文。');
  const previewEngine = preview.engine;
  const moduleQueries = calls.moduleQueries;
  await Reader.listAvailableVoices();
  const names = calls.engines.slice(before).map(params => params.extraParams.name);
  assert.equal(calls.moduleQueries, moduleQueries + 1);
  assert.equal(names.length, 2); assert.equal(new Set(names).size, 2);
  assert.ok(names.every(name => name.startsWith('LegadoReaderTts')));
  assert.ok(calls.engines.slice(before).every(p => p.online === 1 && p.extraParams.locate === 'CN' && p.extraParams.isBackStage));
  assert.notEqual(readingEngine, previewEngine);
  assert.equal(readingEngine.isShutdown, false); assert.equal(previewEngine.isShutdown, false);
  preview.shutdown();
  assert.equal(previewEngine.isShutdown, true); assert.equal(readingEngine.isShutdown, false);
  assert.equal(readingEngine.listener, readingListener);
  assert.equal(reading.currentRequestId, readingRequest); assert.equal(reading.isSpeaking(), true);
  reading.shutdown();
});

await check('type0 先于所有 PCM 回调时保留请求，首包宽限内收到音频后正常播放', async () => {
  const reader = new Reader(); let finished = 0; const errors = [];
  await reader.start('合成完成后才收到音频。', { onFinished() { finished++; }, onError(message) { errors.push(message); } });
  const request = reader.currentRequestId; const listener = reader.engine.listener;
  const speakCount = calls.speaks.length;
  listener.onStart(request, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
  listener.onComplete(request, { type: 0 });
  await advance(Reader.SYSTEM_PCM_EMPTY_GRACE_MS - 1);
  assert.equal(reader.currentRequestId, request); assert.equal(calls.speaks.length, speakCount);
  assert.equal(reader.pcmPlayer.segments.length, 0); assert.equal(finished, 0);
  listener.onData(request, new Int16Array(1600).fill(3000).buffer, { sequence: 0, audioType: 'pcm' });
  await advance(Reader.SYSTEM_PCM_SETTLE_DELAY_MS - 1);
  assert.equal(reader.pcmPlayer.segments.length, 0); assert.equal(finished, 0);
  await advance(1);
  assert.equal(reader.pcmPlayer.segments.length, 1); assert.equal(finished, 1);
  assert.equal(calls.speaks.length, speakCount); assert.equal(errors.length, 0);
  assert.equal(reader.systemPcmSettleTimerId, -1); assert.equal(reader.systemPcmDeadlineTimerId, -1);
  reader.stop();
});

await check('type0 先于末包时每个新包延长静默窗口，旧收尾不能截断 PCM', async () => {
  const reader = new Reader(); let finished = 0;
  await reader.start('最后一个包延迟到达的正文。', { onFinished() { finished++; } });
  const request = reader.currentRequestId; const listener = reader.engine.listener;
  listener.onStart(request, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
  listener.onData(request, new Int16Array(1600).fill(1000).buffer, { sequence: 0, audioType: 'pcm' });
  listener.onComplete(request, { type: 0 });
  const oldSettle = timers.get(reader.systemPcmSettleTimerId).fn;
  await advance(Reader.SYSTEM_PCM_SETTLE_DELAY_MS - 1);
  listener.onData(request, new Int16Array(1600).fill(2000).buffer, { sequence: 1, audioType: 'pcm' });
  oldSettle();
  await advance(1);
  assert.equal(reader.pcmPlayer.segments.length, 0); assert.equal(finished, 0);
  assert.equal(reader.currentRequestId, request);
  await advance(Reader.SYSTEM_PCM_SETTLE_DELAY_MS - 1);
  assert.equal(reader.pcmPlayer.segments.length, 1); assert.equal(finished, 1);
  const pcm = new Int16Array(reader.pcmPlayer.segments[0].pcm);
  assert.equal(pcm.length, 3200); assert.equal(pcm[800], 1000); assert.equal(pcm[2400], 2000);
  reader.stop();
});

await check('乱序缺包先等待，序号补齐后按顺序播放，空首包保留序号', async () => {
  for (const emptyFirst of [false, true]) {
    const reader = new Reader(); const errors = [];
    await reader.start('乱序到达的完整音频。', { onError(message) { errors.push(message); } });
    const request = reader.currentRequestId; const listener = reader.engine.listener;
    listener.onStart(request, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
    if (!emptyFirst) {
      listener.onData(request, new Int16Array(1600).fill(3000).buffer, { sequence: 2, audioType: 'pcm' });
    }
    listener.onData(request, emptyFirst ? new ArrayBuffer(0) : new Int16Array(1600).fill(1000).buffer,
      { sequence: 0, audioType: 'pcm' });
    assert.equal(reader.currentFocusAudioReceived, !emptyFirst);
    listener.onComplete(request, { type: 0 });
    await settlePcm();
    assert.equal(reader.currentRequestId, request); assert.equal(reader.pcmPlayer.segments.length, 0);
    assert.equal(errors.length, 0);
    listener.onData(request, new Int16Array(1600).fill(2000).buffer, { sequence: 1, audioType: 'pcm' });
    await settlePcm();
    assert.equal(reader.pcmPlayer.segments.length, 1); assert.equal(errors.length, 0);
    const pcm = new Int16Array(reader.pcmPlayer.segments[0].pcm);
    assert.equal(pcm.length, emptyFirst ? 1600 : 4800);
    assert.equal(pcm[800], emptyFirst ? 2000 : 1000);
    if (!emptyFirst) { assert.equal(pcm[2400], 2000); assert.equal(pcm[4000], 3000); }
    reader.stop();
  }
});

await check('缺包及持续收包均受总等待上限约束，失败保留当前段落不跳段或完成', async () => {
  for (const continuous of [false, true]) {
    const reader = new Reader(); let finished = 0; const errors = [];
    reader.splitSystemText = text => [
      { text: text.slice(0, 4), start: 0, end: 4 }, { text: text.slice(4), start: 4, end: text.length }
    ];
    await reader.start('当前正文后续正文', { onFinished() { finished++; }, onError(message) { errors.push(message); } });
    const request = reader.currentRequestId; const listener = reader.engine.listener;
    const speakCount = calls.speaks.length;
    listener.onStart(request, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
    listener.onData(request, new Int16Array(160).fill(3000).buffer,
      { sequence: continuous ? 0 : 1, audioType: 'pcm' });
    listener.onComplete(request, { type: 0 });
    const startedAt = now;
    if (continuous) {
      let sequence = 1;
      while (now - startedAt < Reader.SYSTEM_PCM_COLLECTION_TIMEOUT_MS - Reader.SYSTEM_PCM_SETTLE_DELAY_MS) {
        await advance(Reader.SYSTEM_PCM_SETTLE_DELAY_MS - 1);
        listener.onData(request, new Int16Array(160).fill(3000).buffer, { sequence: sequence++, audioType: 'pcm' });
        // 重复完成通知也不能延长总等待上限。
        listener.onComplete(request, { type: 0 });
      }
    } else {
      await settlePcm();
      assert.equal(errors.length, 0); assert.equal(reader.isSpeaking(), true);
    }
    await advance(Reader.SYSTEM_PCM_COLLECTION_TIMEOUT_MS - (now - startedAt));
    assert.equal(reader.isSpeaking(), false); assert.equal(finished, 0);
    assert.equal(reader.chunkIndex, 0); assert.equal(calls.speaks.length, speakCount);
    assert.equal(reader.pcmPlayer.segments.length, 0); assert.equal(reader.pcmPlayer.stopped, true);
    assert.equal(errors.length, 1); assert.ok(errors[0].includes('音频数据不完整'));
    assert.equal(reader.systemCurrentPcmBytes, 0); assert.equal(reader.systemCurrentPcmSequenceSet.size, 0);
    assert.equal(reader.systemPcmSettleTimerId, -1); assert.equal(reader.systemPcmDeadlineTimerId, -1);
    listener.onData(request, new Int16Array(160).fill(3000).buffer, { sequence: 0, audioType: 'pcm' });
    listener.onComplete(request, { type: 0 });
    assert.equal(reader.systemCurrentPcmBytes, 0); assert.equal(errors.length, 1);
    reader.stop();
  }
});

await check('stop 和重新开始清除收尾状态，旧定时器及回调不能结束新请求', async () => {
  const reader = new Reader(); let finished = 0; const errors = [];
  await reader.start('即将停止的旧正文。', { onError(message) { errors.push(message); } });
  const oldRequest = reader.currentRequestId; const oldListener = reader.engine.listener;
  oldListener.onStart(oldRequest, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
  oldListener.onData(oldRequest, new Int16Array(1600).fill(1000).buffer, { sequence: 0, audioType: 'pcm' });
  oldListener.onComplete(oldRequest, { type: 0 });
  const settleId = reader.systemPcmSettleTimerId; const deadlineId = reader.systemPcmDeadlineTimerId;
  const oldSettle = timers.get(settleId).fn; const oldDeadline = timers.get(deadlineId).fn;
  reader.stop();
  assert.equal(timers.has(settleId), false); assert.equal(timers.has(deadlineId), false);
  assert.equal(reader.systemPcmSynthesisComplete, false); assert.equal(reader.systemCurrentPcmBytes, 0);
  await reader.start('重新开始的新正文。', { onFinished() { finished++; }, onError(message) { errors.push(message); } });
  const request = reader.currentRequestId; const listener = reader.engine.listener;
  oldSettle(); oldDeadline();
  oldListener.onData(oldRequest, new Int16Array(1600).fill(1000).buffer, { sequence: 1, audioType: 'pcm' });
  oldListener.onComplete(oldRequest, { type: 0 });
  assert.equal(reader.currentRequestId, request); assert.equal(reader.systemCurrentPcmBytes, 0);
  assert.equal(reader.isSpeaking(), true); assert.equal(finished, 0); assert.equal(errors.length, 0);
  listener.onStart(request, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
  listener.onData(request, new Int16Array(1600).fill(2000).buffer, { sequence: 0, audioType: 'pcm' });
  listener.onComplete(request, { type: 0 }); await settlePcm();
  assert.equal(finished, 1); assert.equal(errors.length, 0); reader.stop();
});

await check('单包和累计 PCM 超出字节预算时立即停止，不截断为成功', async () => {
  for (const aggregate of [false, true]) {
    const reader = new Reader(); let finished = 0; const errors = [];
    await reader.start('异常音频响应的当前正文。', { onFinished() { finished++; }, onError(message) { errors.push(message); } });
    const request = reader.currentRequestId; const listener = reader.engine.listener;
    const speakCount = calls.speaks.length; const stopCount = calls.stops;
    listener.onStart(request, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
    if (aggregate) {
      listener.onData(request, new ArrayBuffer(Reader.SYSTEM_PCM_MAX_BYTES), { sequence: 0, audioType: 'pcm' });
      assert.equal(reader.isSpeaking(), true); assert.equal(reader.systemCurrentPcmBytes, Reader.SYSTEM_PCM_MAX_BYTES);
      listener.onComplete(request, { type: 0 });
    }
    listener.onData(request, new ArrayBuffer(aggregate ? 2 : Reader.SYSTEM_PCM_MAX_BYTES + 2),
      { sequence: aggregate ? 1 : 0, audioType: 'pcm' });
    assert.equal(reader.isSpeaking(), false); assert.equal(reader.chunkIndex, 0);
    assert.equal(reader.systemCurrentPcmBytes, 0); assert.equal(reader.systemCurrentPcmBuffers.length, 0);
    assert.equal(reader.systemPcmSettleTimerId, -1); assert.equal(reader.systemPcmDeadlineTimerId, -1);
    assert.equal(reader.pcmPlayer.stopped, true); assert.equal(reader.pcmPlayer.segments.length, 0);
    assert.equal(calls.speaks.length, speakCount); assert.ok(calls.stops > stopCount);
    assert.equal(finished, 0); assert.equal(errors.length, 1); assert.ok(errors[0].includes('音频数据过大'));
    listener.onComplete(request, { type: 0 }); await emptyPcmGrace();
    assert.equal(finished, 0); assert.equal(errors.length, 1); reader.stop();
  }
});

await check('PCM 合成完成不提前完成章节，排空后完成且旧回调失效', async () => {
  let finished = 0; let highlighted = 0; let drained;
  const reader = new Reader();
  reader.pcmPlayer.drain = () => new Promise(resolve => { drained = resolve; });
  await reader.start('这是一个需要播放到最后的完整句子。', {
    person: 13, online: 0, onFinished() { finished++; }, onChunkStart() { highlighted++; }
  });
  const request = calls.speaks.at(-1).params.requestId;
  const listener = engine.listener;
  listener.onStart(request, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
  const samples = new Int16Array(1600).fill(3000).buffer;
  listener.onData(request, samples, { sequence: 0, audioType: 'pcm' });
  listener.onComplete(request, { type: 0 });
  assert.equal(reader.pcmPlayer.segments.length, 0);
  await settlePcm();
  await tick();
  assert.equal(finished, 0); assert.equal(highlighted, 0);
  assert.equal(reader.pcmPlayer.segments.length, 1);
  reader.pcmPlayer.segments[0].cue(); assert.equal(highlighted, 1);
  assert.equal(typeof drained, 'function'); drained(); await tick();
  assert.equal(finished, 1);
  reader.stop();
  listener.onStart(request, {}); listener.onComplete(request, { type: 1 });
  assert.equal(finished, 1); assert.equal(highlighted, 1);
});

await check('预取无 PCM 兜底先播完前序音频，错误数据停止输出不跳块', async () => {
  const reader = new Reader(); let releaseDrain; const errors = [];
  reader.splitSystemText = text => [
    { text: text.slice(0, 4), start: 0, end: 4 }, { text: text.slice(4), start: 4, end: text.length }
  ];
  reader.pcmPlayer.drain = () => new Promise(resolve => { releaseDrain = resolve; });
  await reader.start('前序正文后续正文', { onError(message) { errors.push(message); } });
  let request = calls.speaks.at(-1).params.requestId;
  engine.listener.onStart(request, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
  engine.listener.onData(request, new Int16Array(1600).fill(3000).buffer, { sequence: 0, audioType: 'pcm' });
  engine.listener.onComplete(request, { type: 0 });
  await settlePcm();
  request = calls.speaks.at(-1).params.requestId;
  engine.listener.onData(request, new ArrayBuffer(0), { sequence: 0, audioType: 'pcm' });
  engine.listener.onComplete(request, { type: 0 }); await tick();
  await emptyPcmGrace();
  assert.equal(reader.pcmPlayer.segments.length, 1);
  assert.equal(calls.speaks.at(-1).params.extraParams.playType, 0);
  reader.pcmPlayer.segments[0].cue(); releaseDrain(); await tick();
  assert.equal(calls.speaks.at(-1).params.extraParams.playType, 1);
  assert.equal(calls.speaks.at(-1).text, '后续正文'); assert.equal(errors.length, 0);
  reader.stop();
  const invalid = new Reader();
  await invalid.start('格式错误的正文。', { onError(message) { errors.push(message); } });
  request = calls.speaks.at(-1).params.requestId;
  const count = calls.speaks.length;
  engine.listener.onStart(request, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
  engine.listener.onData(request, new ArrayBuffer(3), { sequence: 0, audioType: 'pcm' });
  engine.listener.onComplete(request, { type: 0 });
  await settlePcm();
  assert.equal(invalid.isSpeaking(), false); assert.equal(invalid.pcmPlayer.stopped, true);
  assert.equal(calls.speaks.length, count); assert.equal(errors.length, 1);
  invalid.stop();
});

await check('无 PCM 单次直接播报兜底、完成类型与暂停恢复', async () => {
  const reader = new Reader(); let finished = 0;
  await reader.start('直接播报需要完整播放这一句。', { onFinished() { finished++; } });
  let request = calls.speaks.at(-1).params.requestId;
  const oldListener = engine.listener;
  oldListener.onComplete(request, { type: 0 }); await tick();
  await emptyPcmGrace();
  const direct = calls.speaks.at(-1);
  assert.equal(direct.params.extraParams.playType, 1);
  assert.equal(direct.params.extraParams.soundChannel, 3);
  assert.ok(calls.stops > 0);
  request = direct.params.requestId;
  let listener = engine.listener;
  const speakCount = calls.speaks.length;
  listener.onComplete(request, { type: 0 }); await tick();
  assert.equal(calls.speaks.length, speakCount); assert.equal(finished, 0);
  assert.equal(await reader.pause(), true);
  listener.onStop(request, { type: 0 }); assert.equal(reader.isPaused(), true);
  assert.equal(await reader.resume(), true);
  assert.equal(calls.speaks.at(-1).text, direct.text);
  const resumed = calls.speaks.at(-1).params.requestId;
  assert.notEqual(resumed, request);
  listener.onComplete(request, { type: 1 }); await tick(); assert.equal(finished, 0);
  listener = engine.listener;
  listener.onComplete(resumed, { type: 1 }); await tick(); assert.equal(finished, 1);
  reader.stop();
});

await check('PCM 合成使用通道1，设备回传输入通道时按单声道保留完整采样', async () => {
  const reader = new Reader(); let finished = 0; const errors = [];
  await reader.start('验证设备返回的单声道音频。', {
    onFinished() { finished++; }, onError(message) { errors.push(message); }
  });
  const speech = calls.speaks.at(-1); const request = reader.currentRequestId;
  const listener = reader.engine.listener;
  assert.equal(speech.params.extraParams.playType, 0);
  assert.equal(speech.params.extraParams.soundChannel, 1);
  listener.onStart(request, { sampleRate: 16000, sampleBit: 16,
    audioChannel: speech.params.extraParams.soundChannel, audioType: 'pcm' });
  // 真机失败响应的总长度为290240字节，单声道完整，不能按三个声道缩混。
  const pcm = new Int16Array(145120).fill(3000);
  listener.onData(request, pcm.buffer, { sequence: 0, audioType: 'pcm' });
  listener.onComplete(request, { type: 0 }); await settlePcm();
  assert.equal(errors.length, 0); assert.equal(finished, 1);
  assert.equal(reader.pcmPlayer.segments.length, 1);
  const output = reader.pcmPlayer.segments[0].pcm;
  assert.equal(output.byteLength, pcm.byteLength);
  assert.equal(new Int16Array(output)[2000], pcm[2000]);
  reader.stop();
});

await check('显式系统试听直接播报使用正常速度与音调，只由播报完成结束', async () => {
  const reader = new Reader(); let finished = 0; let audioStarted = 0; const errors = [];
  await reader.start('使用系统引擎直接试听。', { directPlayback: true, speed: 1,
    onFinished() { finished++; }, onAudioStart() { audioStarted++; }, onError(message) { errors.push(message); } });
  const speech = calls.speaks.at(-1); const request = reader.currentRequestId; const listener = reader.engine.listener;
  const speakCount = calls.speaks.length;
  assert.equal(speech.params.extraParams.playType, 1); assert.equal(speech.params.extraParams.speed, 1);
  assert.equal(speech.params.extraParams.pitch, 1); assert.equal(speech.params.extraParams.soundChannel, 3);
  listener.onStart(request, {}); assert.equal(audioStarted, 1);
  listener.onComplete(request, { type: 0 });
  await emptyPcmGrace();
  assert.equal(reader.currentRequestId, request); assert.equal(calls.speaks.length, speakCount);
  assert.equal(finished, 0); assert.equal(reader.pcmPlayer.segments.length, 0);
  assert.equal(reader.systemPcmSettleTimerId, -1); assert.equal(reader.systemPcmDeadlineTimerId, -1);
  listener.onData(request, new Int16Array(1600).buffer, { sequence: 0, audioType: 'pcm' });
  assert.equal(reader.systemCurrentPcmBytes, 0);
  listener.onComplete(request, { type: 1 }); await tick();
  assert.equal(finished, 1); assert.equal(errors.length, 0); assert.equal(audioStarted, 1); reader.stop();
});

await check('系统 PCM 写入拒绝立即传播，不产生未观察拒绝或章节完成', async () => {
  const reader = new Reader(); let finished = 0; const errors = []; const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    reader.pcmPlayer.writeSegment = () => Promise.reject(Error('renderer write failed'));
    await reader.start('音频写入失败的正文。', { onFinished() { finished++; }, onError(message) { errors.push(message); } });
    const request = reader.currentRequestId; const listener = reader.engine.listener;
    listener.onStart(request, { sampleRate: 16000, sampleBit: 16, audioChannel: 1, audioType: 'pcm' });
    listener.onData(request, new Int16Array(1600).fill(3000).buffer, { sequence: 0, audioType: 'pcm' });
    listener.onComplete(request, { type: 0 }); await settlePcm();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reader.isSpeaking(), false); assert.equal(finished, 0); assert.equal(reader.chunkIndex, 0);
    assert.equal(errors.length, 1); assert.ok(errors[0].includes('写入失败')); assert.equal(unhandled.length, 0);
  } finally { process.off('unhandledRejection', onUnhandled); reader.stop(); }
});

await check('直接播报完成超时停在当前块，不按估算时间跳块', async () => {
  const reader = new Reader(); let finished = 0; const errors = [];
  await reader.start('这是直接播报发生回调超时的句子。', {
    onFinished() { finished++; }, onError(message) { errors.push(message); }
  });
  const pcmRequest = calls.speaks.at(-1).params.requestId;
  engine.listener.onComplete(pcmRequest, { type: 0 }); await tick();
  await emptyPcmGrace();
  const directRequest = calls.speaks.at(-1).params.requestId;
  engine.listener.onStart(directRequest, {});
  const count = calls.speaks.length;
  await reader.recoverStalledSpeak(reader.readGeneration, reader.currentFocusChunkIndex);
  await tick();
  assert.equal(finished, 0); assert.equal(calls.speaks.length, count);
  assert.equal(reader.isSpeaking(), false); assert.equal(errors.length, 1);
  assert.equal(reader.pcmPlayer.stopped, true);
  reader.stop();
});

await check('最终 speak 长度校验与实例参数不回退在线', async () => {
  const reader = new Reader(); const errors = [];
  reader.splitSystemText = text => [{ text, start: 0, end: text.length }];
  const count = calls.speaks.length;
  await reader.start('长'.repeat(10001), { online: 0, onError(message) { errors.push(message); } });
  assert.equal(calls.speaks.length, count); assert.equal(errors.length, 1);
  assert.equal(reader.isSpeaking(), false);
  reader.stop();
  assert.ok(calls.engines.every(params => params.online === 1));
});

await check('高亮由 renderer 帧推进，暂停期间不漂移，旧时间线失效', async () => {
  bindings.audio = {
    AudioSamplingRate: { SAMPLE_RATE_16000: 16000 },
    AudioState: { STATE_RUNNING: 2, STATE_PAUSED: 3, STATE_RELEASED: 4 }
  };
  load('utils/TtsPcmAudioPlayer.ets');
  const player = new bindings.TtsPcmAudioPlayer();
  bindings.TtsPcmAudioPlayer = PcmPlayer;
  let frame = 0; let cues = 0;
  player.renderer = {
    state: 2, getAudioTimestampInfoSync() { return { framePos: frame }; },
    async pause() { this.state = 3; }, async start() { this.state = 2; }, async setVolume() {}
  };
  player.queuedSampleRate = 16000; player.queuedFrames = 48000;
  player.timelineStartedAt = now - 1000;
  player.playbackMarks = [{ frame: 1600, callback() { cues++; } }, { frame: 3200, callback() { cues++; } }];
  player.updatePlaybackTimeline(0);
  assert.equal(cues, 0); assert.equal(player.lastReachedFrame, 0);
  frame = 1600; now += 100; player.updatePlaybackTimeline(0);
  assert.equal(cues, 1); assert.equal(player.lastReachedFrame, 1600);
  await player.pause(); now += 10000; frame = 20000; player.updatePlaybackTimeline(0);
  assert.equal(cues, 1); assert.equal(player.lastReachedFrame, 1600);
  await player.resume(); frame += 1600; now += 100; player.updatePlaybackTimeline(0);
  assert.equal(cues, 2); assert.equal(player.lastReachedFrame, 3200);
  player.playGeneration++; frame += 16000; player.updatePlaybackTimeline(0);
  assert.equal(player.lastReachedFrame, 3200);
});

await check('设置页尊重 EOM 与未知状态，不信任本地安装记录，查询失败保留自定义选择', async () => {
  const view = page();
  view.ttsInstalledVoiceKeys = '21_1_zh-CN_';
  voices = [rawVoice(13, 'EOM'), rawVoice(21, 'UNKNOWN'), rawVoice(8, 'GA', 'en-US')];
  await view.loadVoices();
  assert.equal(view.voices.find(v => v.id === 13).available, false);
  assert.equal(view.voices.find(v => v.id === 21).available, false);
  assert.ok(view.voiceTitle(view.voices.find(v => v.id === 21)).includes('状态未确认'));
  assert.equal(view.voiceTitle(view.voices.find(v => v.id === 8)).includes('美国英语 Laura'), true);
  view.ttsCustomVoiceId = 'custom-test';
  view.customVoices = [{ id: 'custom-test', name: '自定义音色', enabled: true }];
  const previous = view.voices;
  queryError = Error('offline query failed'); await view.loadVoices(); queryError = undefined;
  assert.equal(view.ttsCustomVoiceId, 'custom-test'); assert.equal(view.voices, previous);
  assert.ok(view.voiceLoadError.includes('刷新'));
});

await check('设置页确认下载后系统 INSTALLED 才切换，失败及取消保留选择', async () => {
  const view = page();
  voices = [rawVoice(13, 'INSTALLED'), rawVoice(21, 'GA')]; await view.loadVoices();
  const target = view.voices.find(v => v.id === 21);
  downloadImpl = (_params, cb) => {
    const listeners = new Map();
    cb(null, { on(type, fn) { listeners.set(type, fn); }, off() {} });
    Promise.resolve().then(() => {
      voices = [rawVoice(13, 'INSTALLED'), rawVoice(21, 'INSTALLED')];
      listeners.get('complete')(rawVoice(21, 'INSTALLED'));
    });
  };
  await view.downloadAndSelectVoice(target); await tick();
  assert.equal(view.ttsPerson, 21); assert.equal(storage.get('ttsPerson'), 21);
  assert.equal(view.ttsInstalledVoiceKeys, '');
  for (const status of ['GA', 'EOM', undefined]) {
    voices = [rawVoice(13, 'INSTALLED'), rawVoice(21, 'GA')];
    view.ttsPerson = 13; await view.loadVoices();
    downloadImpl = (_params, cb) => {
      voices = [rawVoice(13, 'INSTALLED'), rawVoice(21, status)];
      cb({ code: 1002300010 }, null);
    };
    await view.downloadAndSelectVoice(view.voices.find(v => v.id === 21));
    assert.equal(view.ttsPerson, 13);
  }
  voices = [rawVoice(13, 'INSTALLED'), rawVoice(21, 'GA')]; await view.loadVoices();
  downloadImpl = (_params, cb) => cb({ code: 1002300008, message: 'network failed' }, null);
  await view.downloadAndSelectVoice(view.voices.find(v => v.id === 21));
  assert.equal(view.ttsPerson, 13);
  assert.ok(!calls.toasts.at(-1).includes('network failed'));
});

await check('退出页面后下载和查询回调不再修改页面或保存选择，下载防重入', async () => {
  const view = page();
  voices = [rawVoice(13, 'INSTALLED'), rawVoice(21, 'GA')]; await view.loadVoices();
  const target = view.voices.find(v => v.id === 21); const listeners = new Map();
  downloadImpl = (_params, cb) => cb(null, { on(type, fn) { listeners.set(type, fn); }, off() {} });
  const pending = view.downloadAndSelectVoice(target);
  const count = calls.downloads.length;
  await view.downloadAndSelectVoice(target); assert.equal(calls.downloads.length, count);
  view.onPageHide();
  const afterHide = { person: view.ttsPerson, progress: view.downloadProgressText, key: view.downloadingVoiceKey,
    storedPerson: storage.get('ttsPerson'), toastCount: calls.toasts.length };
  listeners.get('progress')('99');
  listeners.get('complete')(rawVoice(21, 'INSTALLED'));
  await pending; await tick();
  assert.equal(view.ttsPerson, afterHide.person); assert.equal(storage.get('ttsPerson'), afterHide.storedPerson);
  assert.equal(view.downloadProgressText, afterHide.progress); assert.equal(view.downloadingVoiceKey, afterHide.key);
  assert.equal(calls.toasts.length, afterHide.toastCount);
  view.activatePage();
  const originalQuery = bindings.textToSpeech.listVoices; let resolveQuery;
  bindings.textToSpeech.listVoices = () => new Promise(resolve => { resolveQuery = resolve; });
  const oldVoices = view.voices; const loading = view.loadVoices();
  view.onPageHide(); resolveQuery([rawVoice(8, 'INSTALLED', 'en-US')]); await loading;
  assert.equal(view.voices, oldVoices);
  bindings.textToSpeech.listVoices = originalQuery;
});

await check('下载中切换自定义音色不被下载完成覆盖，确认查询失败保留原选择', async () => {
  const view = page();
  voices = [rawVoice(13, 'INSTALLED'), rawVoice(21, 'GA')]; await view.loadVoices();
  const listeners = new Map();
  downloadImpl = (_params, cb) => cb(null, { on(type, fn) { listeners.set(type, fn); }, off() {} });
  const task = view.downloadAndSelectVoice(view.voices.find(v => v.id === 21));
  view.customVoices = [{ id: 'custom-test', name: '自定义音色', enabled: true }];
  view.applyCustomVoice(view.customVoices[0]);
  voices = [rawVoice(13, 'INSTALLED'), rawVoice(21, 'INSTALLED')];
  listeners.get('complete')(rawVoice(21, 'INSTALLED')); await task;
  assert.equal(view.ttsCustomVoiceId, 'custom-test'); assert.equal(view.ttsPerson, 13);
  voices = [rawVoice(13, 'INSTALLED'), rawVoice(21, 'GA')]; await view.loadVoices();
  downloadImpl = (_params, cb) => cb({ code: 1002300010 }, null);
  queryError = Error('confirmation failed');
  await view.downloadAndSelectVoice(view.voices.find(v => v.id === 21)); queryError = undefined;
  assert.equal(view.ttsCustomVoiceId, 'custom-test'); assert.ok(view.voiceLoadError.includes('确认'));
  assert.equal(view.downloadingVoiceKey, '');
  storage.set('ttsCustomVoiceId', '');
});

await check('初始化失败不重试在线，错误文案不包含内部异常或参数', async () => {
  const original = bindings.textToSpeech.createEngine; let attempts = 0;
  bindings.textToSpeech.createEngine = async params => {
    attempts++; assert.equal(params.online, 1); throw Error('ENGINE_INTERNAL language=zh-CN');
  };
  const reader = new Reader(); const errors = [];
  await reader.start('测试初始化失败。', { onError(message) { errors.push(message); } });
  bindings.textToSpeech.createEngine = original;
  assert.equal(attempts, 1); assert.equal(reader.isSpeaking(), false);
  assert.equal(errors.length, 1); assert.ok(!errors[0].includes('ENGINE_INTERNAL'));
  assert.ok(!errors[0].includes('language=')); reader.stop();
});

await check('正文交互和图片标记剥离保留来源偏移，标记内起读不念元数据', async () => {
  load('core/book/ReaderActionMarker.ts'); load('core/book/ReaderImageMarker.ts');
  load('core/book/LocalBookService.ets');
  const source = fs.readFileSync(new URL('../entry/src/main/ets/pages/ReadBook.ets', import.meta.url), 'utf8');
  const lines = source.split(/\r?\n/);
  const begin = lines.findIndex(line => line.startsWith('  getTtsReadingText('));
  let end = begin + 1; while (lines[end] !== '  }') end++;
  const ReadPage = vm.runInContext(stripTypeScriptTypes('class TestReadPage {\n' +
    lines.slice(begin, end + 1).join('\n') + '\n}\nTestReadPage', { mode: 'transform' }), context);
  const marker = bindings.ReaderActionMarker.create('段评', 'https://example.invalid/comment');
  const image = bindings.ReaderImageMarker.create('images/1.png');
  const text = `前面的正文。${marker}中间正文。${image}结尾正文。`;
  const view = Object.assign(new ReadPage(), {
    pagedContentText: text, getCurrentPageStartOffset() { return 0; }, shouldUseReaderLayoutV2() { return false; }
  });
  const speech = view.getTtsReadingText(0);
  assert.equal(speech.length, text.length); assert.ok(!speech.includes('LEGADO_'));
  assert.equal(speech.indexOf('结尾正文。'), text.indexOf('结尾正文。'));
  const reader = new Reader();
  assert.ok(!reader.normalizeText(speech).includes('example.invalid'));
  const fromMarker = view.getTtsReadingText(text.indexOf(marker) + 5);
  assert.equal(view.ttsTextStartOffset, text.indexOf(marker) + marker.length);
  assert.ok(fromMarker.startsWith('中间正文。'));
});

await check('同一时刻多实例查询、下载和合成请求 ID 唯一', async () => {
  const ids = [...calls.queries, ...calls.downloads].map(call => call.requestId)
    .concat(calls.speaks.map(call => call.params.requestId));
  assert.equal(new Set(ids).size, ids.length);
  const engineNames = calls.engines.map(params => params.extraParams.name);
  assert.equal(new Set(engineNames).size, engineNames.length);
});

console.log(`System TTS checks passed: ${checks} groups.`);
