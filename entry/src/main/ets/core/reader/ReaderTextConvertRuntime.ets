import { common } from '@kit.AbilityKit';
import { CooperativeScheduler } from '@legado/sourceengine';
import { ChineseConverter } from '../../utils/ChineseConverter';
import { ReaderTextConverter, ReaderTextConvert } from './ReaderTextConvert';

/** 按方向包装 ChineseConverter 的等长转换，供 ReaderTextConvert 的检测/分片使用。 */
class ReaderDirectionConverter implements ReaderTextConverter {
  private readonly converterType: number;

  constructor(converterType: number) {
    this.converterType = converterType;
  }

  convertSameLength(text: string): string {
    return ChineseConverter.convertTextSameLength(text, this.converterType);
  }
}

/**
 * 小说正文简繁转换的进程内入口。词典由应用唯一的 ChineseConverter 加载与持有（漫画文字层、搜索、
 * 书源 java.t2s/java.s2t 共用同一份）；正文使用等长转换，按原文记下的进度偏移照常可用。
 * converterType 取 ChineseConverter.TYPE_T2S / TYPE_S2T，默认繁→简（开书检测用）。
 */
export class ReaderTextConvertRuntime {
  /** 连续转换超过这么久就让出一次主线程。 */
  private static readonly SLICE_MS: number = 8;

  /** 词典已就绪；没加载时同步调用方（章节标题）先显示原文，加载后由宿主刷新。 */
  static ready(converterType: number = ChineseConverter.TYPE_T2S): boolean {
    return ChineseConverter.isLoaded(converterType);
  }

  static async load(context: common.Context,
    converterType: number = ChineseConverter.TYPE_T2S): Promise<ReaderTextConverter> {
    await ChineseConverter.ensureLoaded(context, converterType);
    if (!ChineseConverter.isLoaded(converterType)) throw new Error('简繁字典加载失败');
    return new ReaderDirectionConverter(converterType);
  }

  static async convert(context: common.Context, text: string,
    converterType: number = ChineseConverter.TYPE_T2S): Promise<string> {
    if (!text || ChineseConverter.normalizeType(converterType) === ChineseConverter.TYPE_OFF) return text;
    await ReaderTextConvertRuntime.load(context, converterType);
    const parts = ReaderTextConvert.chunks(text);
    let sliceStart = Date.now();
    for (let index = 0; index < parts.length; index++) {
      if (ReaderTextConvert.isMarker(parts[index])) continue;
      parts[index] = ChineseConverter.convertTextSameLength(parts[index], converterType);
      if (index < parts.length - 1 && Date.now() - sliceStart >= ReaderTextConvertRuntime.SLICE_MS) {
        await CooperativeScheduler.yieldToEventLoop();
        sliceStart = Date.now();
      }
    }
    return parts.join('');
  }

  /** 同步转换短文本（章节标题、查找词）；词典未就绪时原样返回。 */
  static convertNow(text: string, converterType: number = ChineseConverter.TYPE_T2S): string {
    if (!text || !ChineseConverter.isLoaded(converterType)) return text;
    return ReaderTextConvert.convert(new ReaderDirectionConverter(converterType), text);
  }
}
