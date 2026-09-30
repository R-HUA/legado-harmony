import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

let active = 0, peak = 0, fetches = 0, decodes = 0, releases = 0;
const pending = [];
const timers = [];
const sourceText = fs.readFileSync(new URL('../entry/src/main/ets/core/reader/ReaderPagedImageCache.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
const { ReaderPagedImageCache: cache } = vm.runInNewContext(stripTypeScriptTypes(sourceText, { mode: 'transform' }) +
  '\n;({ReaderPagedImageCache})', {
  setTimeout: fn => { timers.push(fn); return timers.length; },
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
        return { getPixelBytesNumber: () => 8 * 1024 * 1024, async release() { releases++; } };
      },
      async release() {}
    })
  }, fileUri: { FileUri: class { constructor(uri) { this.path = uri.slice(7); } } }, util: {}
});
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function finishPending() {
  for (let i = 0; i < 30; i++) {
    const batch = pending.splice(0); batch.forEach(resolve => resolve());
    await flush();
    if (pending.length === 0) return;
  }
  throw new Error('decode queue did not drain');
}

// Current, preview and a rapid remount coalesce into exactly one request/decoded PixelMap.
const preview = cache.acquire('https://example.test/1.png', 800, 1200);
const current = cache.acquire('https://example.test/1.png', 799, 1199);
assert.equal(fetches, 1);
await finishPending();
assert.equal(await preview.ready, await current.ready);
assert.ok(await current.ready, 'the production cache must actually publish a decoded PixelMap');
assert.equal(decodes, 1);
const remount = cache.acquire('https://example.test/1.png', 800, 1200);
assert.equal(remount.value, await current.ready, 'remount must synchronously receive shared decoded pixels');
preview.release(); preview.release(); current.release();

// Memory pressure must never invalidate pixels still held by a mounted Image.
for (let i = 2; i < 11; i++) cache.prefetch(`https://example.test/${i}.png`, 800, 1200);
await finishPending();
assert.equal(peak, 2, 'at most two network/decode slots');
assert.ok(cache.entries.size <= 6);
assert.ok(Array.from(cache.entries.values()).reduce((sum, entry) => sum + entry.bytes, 0) <= 24 * 1024 * 1024);
assert.ok(Array.from(cache.entries.values()).some(entry => entry.pixelMap === remount.value));
remount.release();
timers.splice(0).forEach(fn => fn());
assert.ok(releases > 0, 'evicted, unreferenced pixels must be released');

// Errors settle, release the slot and retry later; animated images keep the URI renderer.
const failed = cache.acquire('https://example.test/failure.png', 800, 1200);
const animated = cache.acquire('https://example.test/animated.webp', 800, 1200);
await finishPending();
assert.equal(await failed.ready, null);
assert.equal(await animated.ready, null);
failed.release(); animated.release();
const beforeRetry = fetches;
const throttled = cache.acquire('https://example.test/failure.png', 800, 1200);
assert.equal(fetches, beforeRetry, 'failed URLs must not cause repeated request storms');
throttled.release();
assert.equal(cache.decodeCount, 0);
console.log('Paged image cache: shared preview/current pixels, synchronous remount, LRU memory bound, active leases, two decode slots, failure and animation fallback passed. Platform image/HTTP are mocked.');
