import fs from '@ohos.file.fs';
import fileUri from '@ohos.file.fileuri';
import image from '@ohos.multimedia.image';
import { util } from '@kit.ArkTS';
import { HttpClient } from '@legado/sourceengine';

/**
 * 正文插图的解码缓存。翻页时滑入页、当前页和跨章后的新页面都是新建的 Image 节点，用文件地址时每个节点都要在后台
 * 重新解码，解码完成前插图位置是空的，看起来就是插图闪一下。这里把本地图片按显示尺寸解码成 PixelMap 留在内存里，
 * Image 直接拿 PixelMap 绘制，新节点第一帧就有画面。网络和 data: 插图也共用解码结果，动图保留 Image 地址加载。
 */
export class ReaderImageBitmapCache {
  private static readonly MAX_ENTRIES: number = 48;
  private static readonly MAX_BYTES: number = 64 * 1024 * 1024;
  /** 同一张图解码失败后不再重试，Image 会按文件地址加载并显示失败提示。 */
  private static readonly FAILED_LIMIT: number = 128;
  private static decodeCount: number = 0;
  private static decodeWaiters: (() => void)[] = [];

  private readonly bitmaps: Map<string, image.PixelMap> = new Map<string, image.PixelMap>();
  private readonly bytesByKey: Map<string, number> = new Map<string, number>();
  private readonly pending: Map<string, Promise<image.PixelMap | null>> =
    new Map<string, Promise<image.PixelMap | null>>();
  private readonly failed: Set<string> = new Set<string>();
  private totalBytes: number = 0;

  /** 已解码好的图片；没有时返回 undefined，不触发解码。 */
  get(source: string, widthPx: number, heightPx: number): image.PixelMap | undefined {
    const key = ReaderImageBitmapCache.cacheKey(source, widthPx, heightPx);
    if (!key) return undefined;
    const bitmap = this.bitmaps.get(key);
    if (bitmap) {
      // 访问过的条目挪到末尾，淘汰时先丢最久没用的。
      this.bitmaps.delete(key);
      this.bitmaps.set(key, bitmap);
    }
    return bitmap;
  }

  /**
   * 安排后台解码。已缓存、正在解码或失败过时直接返回 false；
   * 否则解码完成后调用 onReady，失败时让界面切回 Image 地址加载。
   */
  prepare(source: string, widthPx: number, heightPx: number, onReady: () => void): boolean {
    const key = ReaderImageBitmapCache.cacheKey(source, widthPx, heightPx);
    if (!key || this.bitmaps.has(key) || this.pending.has(key) || this.failed.has(key)) return false;
    this.prepareAsync(source, widthPx, heightPx).then(() => onReady());
    return true;
  }

  /** 翻页交接与预加载等待同一个解码任务，避免新建当前页后再次下载、解码。 */
  prepareAsync(source: string, widthPx: number, heightPx: number): Promise<image.PixelMap | null> {
    const key = ReaderImageBitmapCache.cacheKey(source, widthPx, heightPx);
    if (!key) return Promise.resolve(null);
    const cached = this.get(source, widthPx, heightPx);
    if (cached) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.failed.has(key)) return Promise.resolve(null);
    const task = ReaderImageBitmapCache.decode(source, widthPx, heightPx).then((bitmap: image.PixelMap | null) => {
      this.pending.delete(key);
      if (!bitmap) {
        this.rememberFailure(key);
        return null;
      }
      this.store(key, bitmap);
      return bitmap;
    });
    this.pending.set(key, task);
    return task;
  }

  usesUriFallback(source: string, widthPx: number, heightPx: number): boolean {
    return this.failed.has(ReaderImageBitmapCache.cacheKey(source, widthPx, heightPx));
  }

  clear(): void {
    // 不主动 release：被淘汰的 PixelMap 可能仍挂在正在显示的 Image 上，交给 GC 回收。
    this.bitmaps.clear();
    this.bytesByKey.clear();
    this.failed.clear();
    this.totalBytes = 0;
  }

  private store(key: string, bitmap: image.PixelMap): void {
    let bytes = 0;
    try {
      bytes = bitmap.getPixelBytesNumber();
    } catch (_) {
      bytes = 0;
    }
    this.bitmaps.set(key, bitmap);
    this.bytesByKey.set(key, bytes);
    this.totalBytes += bytes;
    while (this.bitmaps.size > 1 && (this.bitmaps.size > ReaderImageBitmapCache.MAX_ENTRIES ||
      this.totalBytes > ReaderImageBitmapCache.MAX_BYTES)) {
      const oldest = this.bitmaps.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.bitmaps.delete(oldest);
      this.totalBytes -= this.bytesByKey.get(oldest) || 0;
      this.bytesByKey.delete(oldest);
    }
  }

  private rememberFailure(key: string): void {
    this.failed.add(key);
    while (this.failed.size > ReaderImageBitmapCache.FAILED_LIMIT) {
      const oldest = this.failed.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.failed.delete(oldest);
    }
  }

  private static cacheKey(source: string, widthPx: number, heightPx: number): string {
    const width = Math.round(widthPx);
    const height = Math.round(heightPx);
    if (!source || width <= 0 || height <= 0) return '';
    return `${width}x${height}|${source}`;
  }

  private static localPath(source: string): string {
    const value = (source || '').trim();
    if (!value || /^(?:https?:|data:)/i.test(value)) return '';
    if (/^file:/i.test(value)) {
      try {
        return new fileUri.FileUri(value).path;
      } catch (_) {
        return '';
      }
    }
    return value;
  }

  /** 按 Contain 的显示尺寸解码，不放大原图。 */
  private static async decode(uri: string, widthPx: number, heightPx: number): Promise<image.PixelMap | null> {
    if (ReaderImageBitmapCache.decodeCount >= 2) {
      await new Promise<void>((resolve) => ReaderImageBitmapCache.decodeWaiters.push(resolve));
    } else {
      ReaderImageBitmapCache.decodeCount++;
    }
    let file: fs.File | null = null;
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
        const path = ReaderImageBitmapCache.localPath(uri);
        if (!path) return null;
        file = fs.openSync(path, fs.OpenMode.READ_ONLY);
        source = image.createImageSource(file.fd);
      }
      // 动图继续交给 ArkUI Image，避免把 GIF/WebP 静默转换成首帧。
      if (await source.getFrameCount() > 1) return null;
      const info = await source.getImageInfo();
      const sourceWidth = info.size.width;
      const sourceHeight = info.size.height;
      if (sourceWidth <= 0 || sourceHeight <= 0) return null;
      const scale = Math.min(1, widthPx / sourceWidth, heightPx / sourceHeight);
      const options: image.DecodingOptions = {
        desiredSize: {
          width: Math.max(1, Math.round(sourceWidth * scale)),
          height: Math.max(1, Math.round(sourceHeight * scale))
        }
      };
      return await source.createPixelMap(options);
    } catch (error) {
      console.warn('[ReaderImageBitmap] 解码插图失败:', error);
      return null;
    } finally {
      if (source) {
        try {
          await source.release();
        } catch (_) {
        }
      }
      if (file) {
        try {
          fs.closeSync(file);
        } catch (_) {
        }
      }
      const waiter = ReaderImageBitmapCache.decodeWaiters.shift();
      if (waiter) waiter();
      else ReaderImageBitmapCache.decodeCount--;
    }
  }
}
