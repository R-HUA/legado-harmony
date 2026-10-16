import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { readEtsModule } from './lib/ets-module-staging.mjs';

let active = 0, peak = 0, fetches = 0, decodes = 0, releases = 0, sourceReleases = 0;
const pending = [];
const sourceText = readEtsModule('core/reader/ReaderImageBitmapCache.ets')
  .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const { ReaderImageBitmapCache } = vm.runInNewContext(stripTypeScriptTypes(sourceText, { mode: 'transform' }) +
  '\n;({ReaderImageBitmapCache})', {
  console: { warn() {} },
  ArrayBuffer,
  HttpClient: class {
    async executeBinary(req) {
      fetches++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => pending.push(resolve));
      active--;
      if (req.url.includes('failure')) throw new Error('offline');
      return { success: true, data: new Uint8Array([req.url.includes('animated') ? 2 : 1]) };
    }
  },
  image: {
    PixelMapFormat: { RGBA_8888: 1 },
    createImageSource: input => ({
      async getFrameCount() { return input instanceof ArrayBuffer ? new Uint8Array(input)[0] : 1; },
      async getImageInfo() { return { size: { width: 2400, height: 3600 } }; },
      async createPixelMap(options) {
        decodes++;
        assert.ok(Math.abs(options.desiredSize.width - options.desiredSize.height * 2 / 3) <= 1,
          'aspect ratio must survive downsampling within one rounded pixel');
        return { released: false, getPixelBytesNumber: () => 8 * 1024 * 1024,
          async release() { this.released = true; releases++; } };
      },
      async release() { sourceReleases++; }
    })
  }, fileUri: { FileUri: class { constructor(uri) { this.path = uri.slice(7); } } }, util: {}
});
const cache = new ReaderImageBitmapCache();
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function finishPending() {
  for (let i = 0; i < 30; i++) {
    const batch = pending.splice(0); batch.forEach(resolve => resolve());
    await flush();
    if (pending.length === 0) return;
  }
  throw new Error('decode queue did not drain');
}

// V2 翻页交接与预加载等待同一尺寸的生产解码任务，新节点同步获取同一 PixelMap。
const preview = cache.prepareAsync('https://example.test/1.png', 800, 1200);
const current = cache.prepareAsync('https://example.test/1.png', 800, 1200);
assert.equal(fetches, 1);
await finishPending();
assert.equal(await preview, await current);
assert.ok(await current, 'the production cache must actually publish a decoded PixelMap');
assert.equal(decodes, 1);
const remount = cache.get('https://example.test/1.png', 800, 1200);
assert.equal(remount, await current, 'remount must synchronously receive shared decoded pixels');
assert.equal(cache.prepare('https://example.test/1.png', 800, 1200,
  () => assert.fail('cached artwork must not schedule another decode')), false);

// 上游由 Image/GC 持有像素；LRU 淘汰和 clear 都不能主动释放仍在显示的 PixelMap。
for (let i = 2; i < 11; i++) cache.prepareAsync(`https://example.test/${i}.png`, 800, 1200);
await finishPending();
assert.equal(peak, 2, 'at most two network/decode slots');
assert.ok(cache.bitmaps.size <= 48);
assert.ok(Array.from(cache.bytesByKey.values()).reduce((sum, bytes) => sum + bytes, 0) <= 64 * 1024 * 1024);
assert.equal(cache.get('https://example.test/1.png', 800, 1200), undefined, 'LRU must evict the oldest cache reference');
assert.equal(remount.released, false, 'eviction must preserve pixels held by a mounted Image');
assert.equal(releases, 0, 'cached PixelMaps must remain owned by their Image nodes and GC');
assert.equal(sourceReleases, decodes, 'each decoded ImageSource must be released');
cache.clear();
assert.equal(cache.bitmaps.size, 0);
assert.equal(cache.totalBytes, 0);
assert.equal(remount.released, false, 'clearing the cache must preserve pixels held by a mounted Image');

// 失败和动图都归还并发槽，保留 URI 渲染，并在当前缓存生命周期内抑制重复请求。
let failureReadyCalls = 0;
assert.equal(cache.prepare('https://example.test/failure.png', 800, 1200, () => failureReadyCalls++), true);
const failed = cache.prepareAsync('https://example.test/failure.png', 800, 1200);
const animated = cache.prepareAsync('https://example.test/animated.webp', 800, 1200);
await finishPending();
assert.equal(await failed, null);
assert.equal(await animated, null);
assert.equal(failureReadyCalls, 1, 'failed decoding must notify the view to render the URI fallback');
assert.equal(cache.usesUriFallback('https://example.test/failure.png', 800, 1200), true);
assert.equal(cache.usesUriFallback('https://example.test/animated.webp', 800, 1200), true);
assert.equal(cache.get('https://example.test/animated.webp', 800, 1200), undefined);
assert.equal(cache.pending.size, 0);
assert.equal(sourceReleases, decodes + 1, 'animated ImageSources must also be released');
const beforeRetry = fetches;
assert.equal(await cache.prepareAsync('https://example.test/failure.png', 800, 1200), null);
assert.equal(fetches, beforeRetry, 'failed URLs must not cause repeated request storms');
assert.equal(ReaderImageBitmapCache.decodeCount, 0);
cache.clear();
assert.equal(cache.usesUriFallback('https://example.test/failure.png', 800, 1200), false);
const retried = cache.prepareAsync('https://example.test/failure.png', 800, 1200);
await finishPending();
assert.equal(await retried, null);
assert.equal(fetches, beforeRetry + 1, 'a new cache lifecycle must allow another attempt');
console.log('Reader image bitmap cache: shared handoff pixels, synchronous remount, LRU memory bound, mounted pixel ownership, two decode slots, failure and animation fallback passed. Platform image/HTTP are mocked.');
