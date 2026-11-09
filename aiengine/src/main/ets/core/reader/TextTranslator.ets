import { common } from '@kit.AbilityKit';
import { AiChineseDirection, AiChineseTextHost, AiRuntime } from '../../runtime/AiRuntime';
import { ChineseTextConversion, ComicChineseDictionary } from './ComicChineseDictionary';
import { ChineseTaiwanConversion, ChineseTaiwanConverter } from './ChineseTaiwanConverter';

class HostT2sConversion implements ChineseTextConversion {
  private readonly host: AiChineseTextHost;
  constructor(host: AiChineseTextHost) { this.host = host; }
  convert(text: string): string { return this.host.convert(text, AiChineseDirection.T2S); }
  convertSameLength(text: string): string { return this.host.convertSameLength(text, AiChineseDirection.T2S); }
}

class HostTaiwanConversion implements ChineseTaiwanConversion {
  private readonly host: AiChineseTextHost;
  constructor(host: AiChineseTextHost) { this.host = host; }
  convert(text: string): string { return this.host.convert(text, AiChineseDirection.S2TW); }
}

/**
 * 文本翻译入口。目前只有本地繁→简（及搜索用的简→繁台湾用字），全部委托宿主的 ChineseConverter；
 * 字典由宿主加载一次，进程内共享。
 */
export class TextTranslator {
  private static t2s: ComicChineseDictionary | null = null;
  private static taiwan: ChineseTaiwanConverter | null = null;

  static async dictionary(context: common.Context): Promise<ComicChineseDictionary> {
    const host = AiRuntime.chineseText();
    await host.ensureLoaded(context, AiChineseDirection.T2S);
    if (!TextTranslator.t2s) TextTranslator.t2s = new ComicChineseDictionary(new HostT2sConversion(host));
    return TextTranslator.t2s;
  }

  static async taiwanConverter(context: common.Context): Promise<ChineseTaiwanConverter> {
    const host = AiRuntime.chineseText();
    await host.ensureLoaded(context, AiChineseDirection.S2TW);
    if (!TextTranslator.taiwan) TextTranslator.taiwan = new ChineseTaiwanConverter(new HostTaiwanConversion(host));
    return TextTranslator.taiwan;
  }

  /** 繁→简翻译（漫画对白等 AI 功能用），受宿主授权控制。 */
  static async translate(context: common.Context, text: string): Promise<string> {
    if (!AiRuntime.isAllowed('translation')) throw new Error('当前不可使用翻译');
    const dictionary = await TextTranslator.dictionary(context);
    return dictionary.convert(text);
  }
}
