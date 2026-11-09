/*
 * Provenance: wip3l/qingye-reader commit 8a783195b0da9191742e41f32086d084017439c3 (2026-10-24, GPL-3.0),
 * entry/src/main/ets/core/reader/ComicChineseConverter.ets. Modified for R-HUA/legado-harmony: membership check replaced by AiRuntime host authorization; dictionary loading routed to the host ChineseConverter via TextTranslator.
 */
import { common } from '@kit.AbilityKit';
import { AiRuntime } from '../../runtime/AiRuntime';
import { ReaderComicSuperResolutionAccess } from './ReaderComicSuperResolution';
import { ComicChineseDictionary } from './ComicChineseDictionary';
import { ComicTextRecognizer } from './ComicTextRecognizer';
import { ComicTextLayer, ComicTextResult } from './ComicTextTypes';
import { TextTranslator } from './TextTranslator';

export class ComicChineseConverter {
  private static loading: Promise<ComicChineseDictionary> | null = null;

  /** 漫画繁→简能否使用：取值同 ReaderComicSuperResolutionAccess；授权由宿主决定（本地构建不设会员门槛）。 */
  static access(): string {
    if (!ComicTextRecognizer.supported()) return ReaderComicSuperResolutionAccess.UNSUPPORTED;
    if (!AiRuntime.isAllowed('translation')) return ReaderComicSuperResolutionAccess.MEMBER_REQUIRED;
    return ReaderComicSuperResolutionAccess.READY;
  }

  static async load(context: common.Context): Promise<ComicChineseDictionary> {
    if (!ComicChineseConverter.loading) {
      ComicChineseConverter.loading = TextTranslator.dictionary(context).catch((error: Error) => {
        ComicChineseConverter.loading = null;
        throw error;
      });
    }
    return await ComicChineseConverter.loading;
  }

  /** 阅读页的繁→简文字层：识别（有缓存）后只重写转换后有变化、且底色可安全覆盖的行。 */
  static async layer(context: common.Context, source: string, active: () => boolean): Promise<ComicTextLayer> {
    const result: ComicTextResult = await ComicTextRecognizer.recognize(context, source, active,
      (_done: number, _total: number): void => {});
    const dictionary = await ComicChineseConverter.load(context);
    const layer = ComicTextLayer.build(result, (text: string): string => dictionary.convert(text));
    // 只记数量，不写漫画原文和图片地址。
    console.info(`[ComicText] ${result.width}x${result.height} 识别 ${result.regions.length} 行，` +
      `改写 ${layer.patches.length} 行，底色不纯跳过 ${layer.skipped} 行，用时 ${result.elapsedMs}ms`);
    return layer;
  }
}
