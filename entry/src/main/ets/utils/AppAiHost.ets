import { common } from '@kit.AbilityKit';
import { AiChineseDirection, AiChineseTextHost, AiHost, AiRuntime } from '@legado/aiengine';
import { digestHashHex } from '@legado/sourceengine';
import { AiAccessPolicy } from '../account/AiAccessPolicy';
import { ReaderCacheBudget } from '../core/book/ReaderCacheBudget';
import { ReaderCacheCoordinator } from '../core/book/ReaderCacheCoordinator';
import { ReaderComicImageExport } from '../core/reader/ReaderComicImageExport';
import { ReaderImageMarker } from '../core/book/ReaderImageMarker';
import { ReaderImageResults } from '../core/book/ReaderImageResults';
import { ChineseConverter } from './ChineseConverter';

/** 简繁转换只有一份实现：aiengine 的繁简接口全部转到应用的 ChineseConverter。 */
export class AppChineseTextHost implements AiChineseTextHost {
  async ensureLoaded(context: common.Context, direction: number): Promise<void> {
    if (direction === AiChineseDirection.S2TW) {
      await ChineseConverter.ensureTaiwanLoaded(context);
      if (!ChineseConverter.isTaiwanLoaded()) throw new Error('简繁字典加载失败');
      return;
    }
    await ChineseConverter.ensureLoaded(context, direction);
    if (!ChineseConverter.isLoaded(direction)) throw new Error('简繁字典加载失败');
  }

  convert(text: string, direction: number): string {
    return direction === AiChineseDirection.S2TW ? ChineseConverter.convertTaiwan(text) :
      ChineseConverter.convertText(text, direction);
  }

  convertSameLength(text: string, direction: number): string {
    return direction === AiChineseDirection.S2TW ? ChineseConverter.convertTaiwan(text) :
      ChineseConverter.convertTextSameLength(text, direction);
  }
}

/** 应用保留授权、网络/图片来源与缓存策略；AI 引擎只通过这里访问应用。 */
export class AppAiHost implements AiHost {
  static install(): void { AiRuntime.install(new AppAiHost(), new AppChineseTextHost()); }
  isAllowed(feature: string): boolean { return AiAccessPolicy.isAllowed(feature); }
  cacheDir(): string { return AppStorage.get<string>('appCacheDir') || ''; }
  downloadImage(source: string): Promise<Uint8Array> { return ReaderComicImageExport.downloadImage(source); }
  digestHashHex(algorithm: string, value: string): string { return digestHashHex(algorithm, value); }
  touchComicFile(path: string): void { ReaderCacheBudget.touchComicFile(path); }
  noteComicWrite(path?: string): void { ReaderCacheBudget.noteComicWrite(path); }
  retainComicFile(path: string): () => void { return ReaderCacheCoordinator.retainFile(path); }
  resolveImageSource(marker: string): string {
    const value = ReaderImageMarker.parse(marker).source;
    const pending = ReaderImageMarker.pendingRaw(value);
    const source = pending ? ReaderImageResults.current(pending) : value;
    return ReaderImageMarker.failureReason(source) ? '' : source;
  }
}
