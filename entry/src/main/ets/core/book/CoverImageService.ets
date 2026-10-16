import { BookSource } from '../../model/data/Book';
import { BookCoverCache } from '../../utils/BookCoverCache';

/**
 * 封面显示层：把“渲染器直接加载裸链”改成“先经应用 HTTP 栈缓存成本地文件”。
 *
 * 站点/图床对没有书源 UA 与 Referer 的静态图片请求会返回 Cloudflare 403 挑战页，渲染器直接加载
 * 裸链就只剩空白封面（正文插图同理，见 ComicImagePipeline）。真正的下载与磁盘缓存由
 * BookCoverCache 负责；这里只解决渲染期取值的两个问题：
 *
 *   1. 同步取值：displayUri 命中缓存就返回 file:// 地址，否则返回原始地址并把下载排进队列；
 *   2. 通知重建：ArkUI 的 Image 需要一个 URI，解析完成后必须让封面区块重建一次。解析进度写在
 *      AppStorage 计数里，构建期读取该计数的区块会随之重建（传负数表示只读缓存、不排队）。
 */
export class CoverImageService {
  static readonly VERSION_KEY: string = 'coverImageVersion';
  private static readonly VERSION_DEBOUNCE_MS: number = 200;
  private static readonly MAX_ENTRIES: number = 512;
  /** 封面地址 + 书源 → 已解析地址（失败时记回原始地址，避免重复重试）。 */
  private static resolved: Map<string, string> = new Map();
  private static pending: Map<string, Promise<string>> = new Map();
  private static versionTimer: number = -1;

  /** 调用方已拿到书源对象时（详情/目录等）登记请求头，省掉一次数据库查询。 */
  static primeSource(source: BookSource): void {
    BookCoverCache.primeSource(source);
  }

  /**
   * 渲染期取显示地址。`renderVersion` 由构建期读取 AppStorage 计数得到（见 VERSION_KEY）；
   * 解析完成会写新计数，读过它的区块随之重建。
   */
  static displayUri(url: string, origin: string, pageUrl: string, renderVersion: number): string {
    const target = (url || '').trim();
    if (!target || !/^https?:\/\//i.test(target)) return target;
    const key = CoverImageService.cacheKey(target, origin);
    const cached = CoverImageService.resolved.get(key);
    if (cached) return cached;
    const onDisk = BookCoverCache.resolveCachedCoverInRoot(CoverImageService.cacheRoot(), target);
    if (onDisk) {
      CoverImageService.remember(key, onDisk);
      return onDisk;
    }
    if (renderVersion >= 0) CoverImageService.prefetch(target, origin, pageUrl);
    return target;
  }

  /** 预热封面（书架/列表加载后调用）。重复调用命中内存与磁盘缓存，不产生额外请求。 */
  static prefetch(url: string, origin: string, pageUrl: string): void {
    CoverImageService.resolve(url, origin, pageUrl).catch((): void => {});
  }

  /** 需要拿具体地址而不是渲染值时使用（例如写入通知封面）。 */
  static async resolve(url: string, origin: string, pageUrl: string): Promise<string> {
    const target = (url || '').trim();
    if (!target || !/^https?:\/\//i.test(target)) return target;
    const key = CoverImageService.cacheKey(target, origin);
    const cached = CoverImageService.resolved.get(key);
    if (cached) return cached;
    const running = CoverImageService.pending.get(key);
    if (running) return await running;
    const task = CoverImageService.download(target, origin, pageUrl, key);
    CoverImageService.pending.set(key, task);
    return await task;
  }

  /** 测试与设置变更用：只清内存状态，磁盘缓存仍然复用。 */
  static clearMemory(): void {
    CoverImageService.resolved.clear();
    CoverImageService.pending.clear();
  }

  private static async download(url: string, origin: string, pageUrl: string,
    key: string): Promise<string> {
    try {
      const resolved = await BookCoverCache.resolveCoverInRoot(CoverImageService.cacheRoot(),
        url, origin, pageUrl);
      const value = resolved || url;
      CoverImageService.remember(key, value);
      if (value !== url) CoverImageService.scheduleVersionBump();
      return value;
    } catch (_) {
      CoverImageService.remember(key, url);
      return url;
    } finally {
      CoverImageService.pending.delete(key);
    }
  }

  private static cacheRoot(): string {
    return AppStorage.get<string>('appCacheDir') || '';
  }

  private static cacheKey(url: string, origin: string): string {
    return `${url}\n${(origin || '').trim()}`;
  }

  private static remember(key: string, value: string): void {
    if (CoverImageService.resolved.size >= CoverImageService.MAX_ENTRIES) {
      const oldest = CoverImageService.resolved.keys().next().value as string;
      CoverImageService.resolved.delete(oldest);
    }
    CoverImageService.resolved.set(key, value);
  }

  /**
   * 一次批量解析只重建一次封面区块：封面通常成批返回，逐个 +1 会让书架这类大页面反复重建。
   */
  private static scheduleVersionBump(): void {
    if (CoverImageService.versionTimer >= 0) return;
    CoverImageService.versionTimer = setTimeout((): void => {
      CoverImageService.versionTimer = -1;
      const current = Number(AppStorage.get<number>(CoverImageService.VERSION_KEY) || 0);
      AppStorage.setOrCreate(CoverImageService.VERSION_KEY, current + 1);
    }, CoverImageService.VERSION_DEBOUNCE_MS);
  }
}
