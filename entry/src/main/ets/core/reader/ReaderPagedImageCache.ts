import image from '@ohos.multimedia.image';
import fileUri from '@ohos.file.fileuri';
import { util } from '@kit.ArkTS';
import { HttpClient } from '../http/HttpClient';

class PagedImageEntry {
  pixelMap: image.PixelMap | null = null;
  pending: Promise<image.PixelMap | null> | null = null;
  references: number = 0;
  bytes: number = 0;
  failedAt: number = 0;
}

export class ReaderPagedImageLease {
  value: image.PixelMap | null = null;
  ready: Promise<image.PixelMap | null> = Promise.resolve(null);
  private released: boolean = false;
  private releaseEntry: () => void = () => {};

  constructor(value: image.PixelMap | null, ready: Promise<image.PixelMap | null>, releaseEntry: () => void) {
    this.value = value;
    this.ready = ready;
    this.releaseEntry = releaseEntry;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseEntry();
  }
}

/** Share decoded artwork across preview/current remounts, not just compressed HTTP data. */
export class ReaderPagedImageCache {
  private static readonly MAX_BYTES: number = 24 * 1024 * 1024;
  private static readonly MAX_ENTRIES: number = 6;
  private static entries: Map<string, PagedImageEntry> = new Map();
  private static decodeCount: number = 0;
  private static decodeWaiters: (() => void)[] = [];

  static acquire(uri: string, widthPx: number, heightPx: number): ReaderPagedImageLease {
    // Bucket viewport dimensions so minor measurement changes do not download/decode the same image again.
    const width = Math.max(64, Math.min(2048, Math.ceil(widthPx / 64) * 64));
    const height = Math.max(64, Math.min(2560, Math.ceil(heightPx / 64) * 64));
    const key = `${uri}\n${width}x${height}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = new PagedImageEntry();
      this.entries.set(key, entry);
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    const owned = entry;
    owned.references++;
    if (!owned.pixelMap && !owned.pending && (!owned.failedAt || Date.now() - owned.failedAt > 3000)) {
      owned.pending = this.decode(uri, width, height).then((pixelMap: image.PixelMap | null) => {
        owned.pixelMap = pixelMap;
        owned.bytes = pixelMap ? pixelMap.getPixelBytesNumber() : 0;
        owned.failedAt = pixelMap ? 0 : Date.now();
        owned.pending = null;
        this.trim();
        return pixelMap;
      });
    }
    return new ReaderPagedImageLease(owned.pixelMap, owned.pending || Promise.resolve(owned.pixelMap), () => {
      owned.references = Math.max(0, owned.references - 1);
      this.trim();
    });
  }

  static prefetch(uri: string, widthPx: number, heightPx: number): void {
    const lease = this.acquire(uri, widthPx, heightPx);
    lease.ready.then(() => lease.release());
  }

  private static trim(): void {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.bytes;
    for (const [key, entry] of this.entries) {
      if (bytes <= this.MAX_BYTES && this.entries.size <= this.MAX_ENTRIES) break;
      // A live Image still owns this PixelMap. Evict only after every preview/current lease has gone.
      if (entry.references > 0 || entry.pending) continue;
      this.entries.delete(key);
      bytes -= entry.bytes;
      const pixelMap = entry.pixelMap;
      entry.pixelMap = null;
      // RenderService can still be drawing a recently removed Image for the submitted frame.
      if (pixelMap) setTimeout(() => pixelMap.release().catch(() => {}), 80);
    }
  }

  private static async decode(uri: string, width: number, height: number): Promise<image.PixelMap | null> {
    if (this.decodeCount >= 2) await new Promise<void>((resolve) => this.decodeWaiters.push(resolve));
    else this.decodeCount++;
    let source: image.ImageSource | null = null;
    try {
      if (/^https?:/i.test(uri)) {
        const response = await new HttpClient().executeBinary({ url: uri, method: 'GET', headers: {},
          connectTimeout: 8000, readTimeout: 10000, noTimeoutRetry: true }, 20 * 1024 * 1024);
        if (!response.success || response.data.length === 0) return null;
        source = image.createImageSource(response.data.buffer.slice(response.data.byteOffset,
          response.data.byteOffset + response.data.byteLength));
      } else if (/^data:image\/[^;]+;base64,/i.test(uri)) {
        const bytes = new util.Base64Helper().decodeSync(uri.substring(uri.indexOf(',') + 1));
        source = image.createImageSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      } else {
        source = image.createImageSource(uri.startsWith('file:') ? new fileUri.FileUri(uri).path : uri);
      }
      if (!source) return null;
      // Keep animated GIF/WebP on the existing Image URI path; never silently flatten an animation.
      if (await source.getFrameCount() > 1) return null;
      const info = await source.getImageInfo();
      const scale = Math.min(1, width / Math.max(1, info.size.width), height / Math.max(1, info.size.height));
      return await source.createPixelMap({ desiredSize: {
        width: Math.max(1, Math.round(info.size.width * scale)),
        height: Math.max(1, Math.round(info.size.height * scale))
      }, desiredPixelFormat: image.PixelMapFormat.RGBA_8888 });
    } catch (_) {
      // Unsupported formats and transport failures retain the normal ArkUI Image fallback.
      return null;
    } finally {
      if (source) await source.release().catch(() => {});
      const waiter = this.decodeWaiters.shift();
      if (waiter) waiter();
      else this.decodeCount--;
    }
  }
}
