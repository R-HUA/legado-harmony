import { Context } from '@kit.AbilityKit';
import fs from '@ohos.file.fs';
import fileUri from '@ohos.file.fileuri';
import http from '@ohos.net.http';
import { CoverUrlNormalizer } from './CoverUrlNormalizer';
import { BookSource } from '../model/data/Book';
import { AppDatabase } from '../model/data/AppDatabase';
import { ComicImagePipeline } from '../core/book/ComicImagePipeline';
import { CookieStore } from '../core/http/CookieStore';

/**
 * 封面本地缓存。
 *
 * 站点/图床对没有书源 UA 与 Referer 的静态图片请求会返回 Cloudflare 403 挑战页，因此下载时必须
 * 复刻书源自己的请求头：书源声明的 User-Agent / Accept-Language、书籍页地址作为 Referer，以及隐藏
 * ArkWeb 会话共享的 CookieJar（`CookieStore`）。正文插图走同一套原则，见 ComicImagePipeline。
 *
 * 未声明请求头的书源、本地封面、以及已经缓存过的地址都不会产生额外请求。
 */
export class BookCoverCache {
  private static readonly DEFAULT_USER_AGENT: string =
    'Mozilla/5.0 (Linux; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  private static resolvedCoverUris: Map<string, string> = new Map();
  private static inFlightResolutions: Map<string, Promise<string>> = new Map();
  private static activeNetworkTasks: number = 0;
  private static readonly MAX_NETWORK_TASKS: number = 4;
  private static networkWaiters: Array<() => void> = [];
  /** 书源请求头按书源地址缓存，避免每张封面都查一次数据库。 */
  private static sourceHeaders: Map<string, Record<string, string>> = new Map();
  /** 查不到的书源只短期记住：封面可能在数据库初始化完成前就被请求。 */
  private static unknownOrigins: Map<string, number> = new Map();
  private static readonly UNKNOWN_RETRY_MS: number = 60000;
  private static readonly MAX_HEADER_ENTRIES: number = 64;

  static resolveCachedCover(context: Context, raw: string): string {
    return BookCoverCache.resolveCachedCoverInRoot(context.cacheDir, raw);
  }

  /** 只读缓存：命中返回 file:// 地址，未命中返回空串（不会发起网络请求）。 */
  static resolveCachedCoverInRoot(root: string, raw: string): string {
    if (!raw || (!raw.startsWith('http://') && !raw.startsWith('https://'))) {
      return '';
    }
    const remembered = BookCoverCache.resolvedCoverUris.get(raw);
    if (remembered) return remembered;
    if (!root) return '';
    const cachedPath = BookCoverCache.cachedCoverPath(root, raw);
    if (!BookCoverCache.exists(cachedPath)) return '';
    const resolved = fileUri.getUriFromPath(cachedPath);
    BookCoverCache.resolvedCoverUris.set(raw, resolved);
    return resolved;
  }

  static async resolveCachedCoverAsync(context: Context, raw: string): Promise<string> {
    return await BookCoverCache.resolveCachedCoverAsyncInRoot(context.cacheDir, raw);
  }

  static async resolveCachedCoverAsyncInRoot(root: string, raw: string): Promise<string> {
    if (!raw || (!raw.startsWith('http://') && !raw.startsWith('https://'))) return '';
    const remembered = BookCoverCache.resolvedCoverUris.get(raw);
    if (remembered) return remembered;
    if (!root) return '';
    const cachedPath = BookCoverCache.cachedCoverPath(root, raw);
    if (!(await BookCoverCache.existsAsync(cachedPath))) return '';
    const resolved = fileUri.getUriFromPath(cachedPath);
    BookCoverCache.resolvedCoverUris.set(raw, resolved);
    return resolved;
  }

  /** 调用方已经拿到书源对象时（详情/目录等）登记它的请求头，省掉一次数据库查询。 */
  static primeSource(source: BookSource): void {
    if (!source) return;
    const origin = (source.bookSourceUrl || '').trim();
    if (!origin) return;
    BookCoverCache.rememberHeader(origin, ComicImagePipeline.presentationHeaders(source));
  }

  static async resolveCover(context: Context, raw: string, origin: string = '',
    pageUrl: string = ''): Promise<string> {
    return await BookCoverCache.resolveCoverInRoot(context.cacheDir, raw, origin, pageUrl);
  }

  /**
   * 下载并缓存封面。`origin` 是发现该封面的书源地址，`pageUrl` 是书籍页地址：两者一起决定请求头与
   * Referer，让受保护的图片站把请求当成浏览器发出的请求。
   */
  static async resolveCoverInRoot(root: string, raw: string, origin: string = '',
    pageUrl: string = ''): Promise<string> {
    const active = BookCoverCache.inFlightResolutions.get(raw);
    if (active) return await active;
    const task = BookCoverCache.resolveCoverInternal(root, raw, origin, pageUrl);
    BookCoverCache.inFlightResolutions.set(raw, task);
    try {
      return await task;
    } finally {
      if (BookCoverCache.inFlightResolutions.get(raw) === task) {
        BookCoverCache.inFlightResolutions.delete(raw);
      }
    }
  }

  private static async resolveCoverInternal(root: string, raw: string, origin: string,
    pageUrl: string): Promise<string> {
    if (!raw) {
      return '';
    }
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      if (!root) return raw;
      const cachedPath = BookCoverCache.cachedCoverPath(root, raw);
      if (await BookCoverCache.existsAsync(cachedPath)) {
        const resolved = fileUri.getUriFromPath(cachedPath);
        BookCoverCache.resolvedCoverUris.set(raw, resolved);
        return resolved;
      }
      const path = await BookCoverCache.downloadCover(root, raw, origin, pageUrl);
      if (!path) return raw;
      const resolved = fileUri.getUriFromPath(path);
      BookCoverCache.resolvedCoverUris.set(raw, resolved);
      return resolved;
    }
    const localPath = BookCoverCache.localPathFromUri(raw);
    if (localPath && await BookCoverCache.existsAsync(localPath)) {
      return raw.startsWith('file://') ? raw : fileUri.getUriFromPath(localPath);
    }
    const copiedPath = await BookCoverCache.copyCoverUriToCache(root, raw);
    if (copiedPath) {
      return fileUri.getUriFromPath(copiedPath);
    }
    return raw;
  }

  static async prepareCoverFile(context: Context, raw: string, origin: string = '',
    pageUrl: string = ''): Promise<string> {
    if (!raw) {
      return '';
    }
    const root = context.cacheDir;
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      if (!root) return '';
      const cachedPath = BookCoverCache.cachedCoverPath(root, raw);
      if (await BookCoverCache.existsAsync(cachedPath)) {
        return cachedPath;
      }
      return await BookCoverCache.downloadCover(root, raw, origin, pageUrl);
    }
    const localPath = BookCoverCache.localPathFromUri(raw);
    if (localPath && await BookCoverCache.existsAsync(localPath)) {
      return localPath;
    }
    return await BookCoverCache.copyCoverUriToCache(root, raw);
  }

  static deleteCachedCover(context: Context, raw: string): void {
    if (!raw) {
      return;
    }
    BookCoverCache.resolvedCoverUris.delete(raw);
    BookCoverCache.inFlightResolutions.delete(raw);
    const root = context.cacheDir;
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      BookCoverCache.deletePath(BookCoverCache.cachedCoverPath(root, raw));
      return;
    }
    BookCoverCache.deletePath(BookCoverCache.cachedCoverPath(root, raw));
    const localPath = BookCoverCache.localPathFromUri(raw);
    if (!localPath || !BookCoverCache.isAppOwnedPath(context.filesDir, root, localPath)) {
      return;
    }
    BookCoverCache.deletePath(localPath);
  }

  private static async downloadCover(root: string, url: string, origin: string,
    pageUrl: string): Promise<string> {
    if (!root) return '';
    const dir = `${root}/book_covers`;
    await BookCoverCache.ensureDirAsync(dir);
    const path = BookCoverCache.cachedCoverPath(root, url);
    if (await BookCoverCache.existsAsync(path)) {
      return path;
    }
    const requestHeaders = await BookCoverCache.requestHeaders(url, origin, pageUrl);
    await BookCoverCache.acquireNetworkSlot();
    try {
      // Another request may have completed while this one waited for a slot.
      if (await BookCoverCache.existsAsync(path)) return path;
      const candidates = CoverUrlNormalizer.downloadCandidates(url);
      for (const requestUrl of candidates) {
        const request = http.createHttp();
        try {
          const response = await request.request(requestUrl, {
            method: http.RequestMethod.GET,
            connectTimeout: 10000,
            readTimeout: 10000,
            expectDataType: http.HttpDataType.ARRAY_BUFFER,
            header: requestHeaders
          });
          if (response.responseCode < 200 || response.responseCode >= 300 || !(response.result instanceof ArrayBuffer)) {
            console.warn(`封面下载失败：status=${response.responseCode} url=${requestUrl}`);
            continue;
          }
          const bytes = new Uint8Array(response.result);
          // 挑战页/错误页也可能是 200：非图片字节一旦落盘就会长期显示为空白封面。
          if (!BookCoverCache.looksLikeImage(bytes)) {
            console.warn(`封面响应不是图片（疑似验证页或防盗链拒绝）：status=${response.responseCode} ` +
              `bytes=${bytes.length} url=${requestUrl}`);
            continue;
          }
          const file = await fs.open(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
          try {
            await fs.write(file.fd, response.result);
          } finally {
            await fs.close(file);
          }
          return path;
        } catch (e) {
          console.warn('下载书籍封面失败:', e);
        } finally {
          request.destroy();
        }
      }
      return '';
    } finally {
      BookCoverCache.releaseNetworkSlot();
    }
  }

  /**
   * 书源声明了浏览器请求头时，封面必须带上同一套头：UA 决定站点给哪个主题，Referer 决定防盗链
   * 是否放行。Cookie 只从共享 CookieJar 取该图片站自己的 Cookie，不搬运书源 Cookie 到第三方。
   */
  private static async requestHeaders(url: string, origin: string,
    pageUrl: string): Promise<Record<string, string>> {
    const declared = await BookCoverCache.sourceHeadersFor(origin);
    const page = (pageUrl || '').trim();
    const source = (origin || '').trim();
    // 优先用书籍页地址：防盗链校验的是“从哪个页面看到的这张图”。
    const siteReferer = /^https?:\/\//i.test(page) ? page :
      (/^https?:\/\//i.test(source) ? `${source.replace(/\/+$/, '')}/` : '');
    const headers: Record<string, string> = {
      'User-Agent': BookCoverCache.headerValue(declared, 'user-agent') ||
        BookCoverCache.DEFAULT_USER_AGENT,
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Referer': siteReferer || BookCoverCache.refererFromUrl(url)
    };
    const language = BookCoverCache.headerValue(declared, 'accept-language');
    if (language) headers['Accept-Language'] = language;
    if (!siteReferer) headers['Origin'] = BookCoverCache.originFromUrl(url);
    const cookie = CookieStore.getCookie(url);
    if (cookie) headers['Cookie'] = cookie;
    return headers;
  }

  private static async sourceHeadersFor(origin: string): Promise<Record<string, string>> {
    const key = (origin || '').trim();
    if (!key) return {};
    const cached = BookCoverCache.sourceHeaders.get(key);
    if (cached) return cached;
    const retryAt = BookCoverCache.unknownOrigins.get(key) || 0;
    if (retryAt > Date.now()) return {};
    try {
      const source = await AppDatabase.getInstance().getBookSource(key);
      if (source) {
        const headers = ComicImagePipeline.presentationHeaders(source);
        BookCoverCache.rememberHeader(key, headers);
        BookCoverCache.unknownOrigins.delete(key);
        return headers;
      }
    } catch (e) {
      console.warn('读取书源请求头失败:', e);
    }
    BookCoverCache.unknownOrigins.set(key, Date.now() + BookCoverCache.UNKNOWN_RETRY_MS);
    return {};
  }

  /** 只接受真正的图片字节：JPEG/PNG/GIF/BMP/WebP/AVIF/SVG。 */
  private static looksLikeImage(bytes: Uint8Array): boolean {
    if (bytes.length < 12) return false;
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return true;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true;
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return true;
    const head = String.fromCharCode(...Array.from(bytes.subarray(0, 64))).trim().toLowerCase();
    if (head.startsWith('<svg') || head.startsWith('<?xml')) return true;
    const ascii = String.fromCharCode(...Array.from(bytes.subarray(0, 16)));
    return (ascii.startsWith('RIFF') && ascii.substring(8, 12) === 'WEBP') ||
      ascii.substring(4, 12).includes('ftypavif') || ascii.substring(4, 12).includes('ftypavis');
  }

  private static headerValue(headers: Record<string, string>, name: string): string {
    const wanted = (name || '').toLowerCase();
    if (!headers) return '';
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) return String(headers[key] || '').trim();
    }
    return '';
  }

  private static rememberHeader(origin: string, headers: Record<string, string>): void {
    if (BookCoverCache.sourceHeaders.size >= BookCoverCache.MAX_HEADER_ENTRIES) {
      const oldest = BookCoverCache.sourceHeaders.keys().next().value as string;
      BookCoverCache.sourceHeaders.delete(oldest);
    }
    BookCoverCache.sourceHeaders.set(origin, headers);
  }

  private static async acquireNetworkSlot(): Promise<void> {
    if (BookCoverCache.activeNetworkTasks < BookCoverCache.MAX_NETWORK_TASKS) {
      BookCoverCache.activeNetworkTasks++;
      return;
    }
    await new Promise<void>((resolve) => {
      BookCoverCache.networkWaiters.push(resolve);
    });
  }

  private static releaseNetworkSlot(): void {
    const next = BookCoverCache.networkWaiters.shift();
    if (next) {
      next();
      return;
    }
    BookCoverCache.activeNetworkTasks = Math.max(0, BookCoverCache.activeNetworkTasks - 1);
  }

  private static async copyCoverUriToCache(root: string, raw: string): Promise<string> {
    if (!raw || raw.startsWith('http://') || raw.startsWith('https://') || !root) {
      return '';
    }
    const dir = `${root}/book_covers`;
    await BookCoverCache.ensureDirAsync(dir);
    const path = BookCoverCache.cachedCoverPath(root, raw);
    if (await BookCoverCache.existsAsync(path)) {
      return path;
    }
    try {
      const source = raw.startsWith('/') ? fileUri.getUriFromPath(raw) : raw;
      await fs.copy(source, fileUri.getUriFromPath(path));
      return await BookCoverCache.existsAsync(path) ? path : '';
    } catch (e) {
      console.warn('复制书籍封面到缓存失败:', e);
      BookCoverCache.deletePath(path);
      return '';
    }
  }

  private static localPathFromUri(raw: string): string {
    if (raw.startsWith('file://')) {
      return decodeURIComponent(raw.substring('file://'.length));
    }
    return raw.startsWith('/') ? raw : '';
  }

  private static exists(path: string): boolean {
    try {
      return fs.accessSync(path);
    } catch (e) {
      return false;
    }
  }

  private static async existsAsync(path: string): Promise<boolean> {
    if (!path) return false;
    try {
      await fs.stat(path);
      return true;
    } catch (e) {
      return false;
    }
  }

  private static async ensureDirAsync(path: string): Promise<void> {
    try {
      await fs.mkdir(path, true);
    } catch (e) {
    }
  }

  private static cachedCoverPath(root: string, url: string): string {
    if (!root) return '';
    return `${root}/book_covers/${BookCoverCache.hashText(url)}${BookCoverCache.coverExt(url)}`;
  }

  private static isAppOwnedPath(filesDir: string, root: string, path: string): boolean {
    return (!!filesDir && path.startsWith(`${filesDir}/covers/`)) ||
      (!!root && path.startsWith(`${root}/book_covers/`));
  }

  private static deletePath(path: string): void {
    try {
      if (path && BookCoverCache.exists(path)) {
        fs.unlinkSync(path);
      }
    } catch (e) {
      console.warn('删除书籍封面缓存失败:', e);
    }
  }

  private static coverExt(value: string): string {
    const lower = value.toLowerCase();
    if (lower.includes('.png')) return '.png';
    if (lower.includes('.webp')) return '.webp';
    if (lower.includes('.bmp')) return '.bmp';
    if (lower.includes('.gif')) return '.gif';
    return '.jpg';
  }

  private static originFromUrl(url: string): string {
    const match = url.match(/^(https?:\/\/[^\/]+)/);
    return match ? match[1] : '';
  }

  private static refererFromUrl(url: string): string {
    const origin = BookCoverCache.originFromUrl(url);
    return origin ? `${origin}/` : '';
  }

  private static hashText(value: string): string {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = value.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash).toString(16);
  }
}
