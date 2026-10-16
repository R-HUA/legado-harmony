import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

// 执行实际 PCM 排队和写回调，检查采样内容及播放失败的传播边界。
const raw = fs.readFileSync(new URL('../entry/src/main/ets/utils/TtsPcmAudioPlayer.ets', import.meta.url), 'utf8');
const source = raw.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const context = vm.createContext({
  console: { info() {}, warn() {} }, ArrayBuffer, Uint8Array,
  audio: {
    AudioSamplingRate: { SAMPLE_RATE_16000: 16000 },
    AudioDataCallbackResult: { INVALID: -1, VALID: 0 }
  }
});
const Player = vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) +
  '\nTtsPcmAudioPlayer', context);

const player = new Player();
player.ensureRendererStarted = async rate => assert.equal(rate, 16000);
const samples = Int16Array.from({ length: 1600 }, (_, index) =>
  Math.round(12000 * Math.sin(2 * Math.PI * 440 * index / 16000)));
const writes = [player.write(samples.buffer.slice(0, 1400), 16000),
  player.write(samples.buffer.slice(1400), 16000)];
const captured = new Uint8Array(4096);
assert.equal(player.handleRendererWriteData(captured.buffer), 0);
await Promise.all(writes);
assert.deepEqual(captured.subarray(0, samples.byteLength), new Uint8Array(samples.buffer));
assert.ok(captured.subarray(samples.byteLength).every(byte => byte === 0));
assert.equal(player.pendingWriteBytes, 0);
assert.equal(player.handleRendererWriteData(new ArrayBuffer(4096)), -1);
console.log('OK 16 kHz 音频跨段写入保持原采样，尾部补零且不重复播放');

const unhandled = [];
const listener = error => unhandled.push(error);
process.on('unhandledRejection', listener);
try {
  const failed = new Player();
  const failure = new Error('renderer unavailable');
  failed.ensureRendererStarted = async () => { throw failure; };
  await assert.rejects(failed.write(new ArrayBuffer(320), 16000), error => error === failure);
  // 调用方已处理写入错误，尚未调用 drain 时，内部聚合也不能触发未处理拒绝。
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unhandled.length, 0, '播放器内部写入聚合产生了未处理的 Promise 拒绝');
  await assert.rejects(failed.drain(), error => error === failure);
  assert.equal(failed.pendingWriteBytes, 0);
  assert.equal(failed.pendingWrites.length, 0);
  console.log('OK 写入失败不会产生内部未处理拒绝，write 和 drain 仍传播原错误');
} finally {
  process.off('unhandledRejection', listener);
}
