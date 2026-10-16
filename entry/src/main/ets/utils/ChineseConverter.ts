import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';

/**
 * 繁简转换（参考 HapeLee/legado-with-MD3 的 ChineseUtils 设计）：
 * 全局阅读设置 chineseConverterType 驱动（0 不转换 / 1 繁转简 / 2 简转繁），
 * 词典数据来自 OpenCC ver.1.1.9 文本词典（TSCharacters/TSPhrases、STCharacters/STPhrases），
 * 先按词组最长匹配，再按单字映射；规则引擎的 java.t2s / java.s2t 与阅读正文共用本模块。
 */

export interface ChineseDictionary {
  chars: Map<string, string>;
  phrases: Map<string, string>;
  maxPhraseLength: number;
  phraseStarts: Set<string>;
}

export const CHINESE_CONVERTER_OFF: number = 0;
export const CHINESE_CONVERTER_T2S: number = 1;
export const CHINESE_CONVERTER_S2T: number = 2;

const CHARS_PER_PARSE_SLICE: number = 8000;

/**
 * MD3 版 fixT2sDict 的排除词表：这些词的词组级转换（多为地区词映射）在小说阅读
 * 场景下属于过度转换（如「雪梨」「芝士」「明瞭」），命中词组表时跳过、保留单字转换。
 */
const T2S_EXCLUDED_PHRASES: string[] = [
  '槃',
  '划槳', '列根', '雪梨', '雪糕', '多士', '起司', '芝士', '沙芬', '母音',
  '华乐', '民乐', '晶元', '晶片', '映像', '明覆', '明瞭', '新力', '新喻',
  '零錢', '零钱', '離線', '碟片', '模組', '桌球', '案頭', '機車', '電漿',
  '鳳梨', '魔戒', '載入', '菲林', '整合', '變數', '解碼', '散钱', '插水',
  '房屋', '房价', '快取', '德士', '建立', '常式', '席丹', '布殊', '布希',
  '巴哈', '巨集', '夜学', '向量', '半形', '加彭', '列印', '函式', '全形',
  '光碟', '介面', '乳酪', '沈船', '永珍', '演化', '牛油', '相容', '磁碟',
  '菲林', '規則', '酵素', '雷根', '饭盒',
  '路易斯', '非同步', '出租车', '周杰倫', '马铃薯', '馬鈴薯', '機械人', '電單車',
  '電扶梯', '音效卡', '飆車族', '點陣圖', '個入球', '顆進球', '沃尓沃', '晶片集',
  '斯瓦巴', '斜角巷', '战列舰', '快速面', '希特拉', '太空梭', '吐瓦魯', '吉布堤',
  '吉布地', '史太林', '南冰洋', '区域网', '波札那', '解析度', '酷洛米', '金夏沙',
  '魔獸紀元', '高空彈跳', '铁达尼号', '太空战士', '埃及妖后', '吉里巴斯', '附加元件',
  '魔鬼終結者', '純文字檔案', '奇幻魔法Melody', '列支敦斯登'
];

export function createEmptyChineseDictionary(): ChineseDictionary {
  return {
    chars: new Map<string, string>(),
    phrases: new Map<string, string>(),
    maxPhraseLength: 0,
    phraseStarts: new Set<string>()
  };
}

/** 解析一行 OpenCC 词典文本：`key\t候选1 候选2`，取首个候选。返回该行是否写入了一条映射。 */
export function applyChineseDictionaryLine(dict: ChineseDictionary, line: string,
  isPhrase: boolean, excludedPhrases: string[] | null = null): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  const tab = trimmed.indexOf('\t');
  if (tab <= 0) return false;
  const key = trimmed.substring(0, tab);
  const candidates = trimmed.substring(tab + 1).trim().split(/\s+/);
  if (candidates.length === 0 || !candidates[0]) return false;
  const target = candidates[0];
  // 同形词组条目（如 s2t 的「皇后→皇后」）必须保留：它用于在词组跨度内阻止单字表
  // 的多字位误转（后→後）；同形的单字条目才是无效映射，跳过以省内存。
  if (target === key && !isPhrase) return false;
  if (excludedPhrases !== null && excludedPhrases.indexOf(key) >= 0) return false;
  if (isPhrase) {
    dict.phrases.set(key, target);
    if (key.length > dict.maxPhraseLength) dict.maxPhraseLength = key.length;
    dict.phraseStarts.add(key.substring(0, 1));
  } else {
    dict.chars.set(key, target);
  }
  return true;
}

/** 分片解析词典文本，便于大词典（s2t 词组约 5 万行）在事件循环间让出。 */
export function applyChineseDictionaryLines(dict: ChineseDictionary, lines: string[],
  startIndex: number, count: number, isPhrase: boolean,
  excludedPhrases: string[] | null = null): number {
  const end = Math.min(lines.length, startIndex + count);
  for (let i = startIndex; i < end; i++) {
    applyChineseDictionaryLine(dict, lines[i], isPhrase, excludedPhrases);
  }
  return end;
}

/** 词组最长匹配优先，其次单字映射，未命中的字符原样保留。 */
export function convertWithChineseDictionary(text: string, dict: ChineseDictionary): string {
  if (!text || (dict.chars.size === 0 && dict.phrases.size === 0)) return text;
  const units = Array.from(text);
  const out: string[] = [];
  const maxLen = dict.maxPhraseLength;
  for (let i = 0; i < units.length; i++) {
    const ch = units[i];
    const mappedChar = dict.chars.get(ch);
    if (maxLen < 2 || !dict.phraseStarts.has(ch)) {
      out.push(mappedChar !== undefined ? mappedChar : ch);
      continue;
    }
    const limit = Math.min(maxLen, units.length - i);
    let matched = '';
    let consumed = 0;
    for (let len = limit; len >= 2; len--) {
      const candidate = units.slice(i, i + len).join('');
      const target = dict.phrases.get(candidate);
      if (target !== undefined) {
        matched = target;
        consumed = len;
        break;
      }
    }
    if (consumed > 0) {
      out.push(matched);
      i += consumed - 1;
      continue;
    }
    out.push(mappedChar !== undefined ? mappedChar : ch);
  }
  return out.join('');
}

interface DictionarySource {
  charsPath: string;
  phrasesPath: string;
  excludedPhrases: string[] | null;
}

export class ChineseConverter {
  static readonly TYPE_OFF: number = CHINESE_CONVERTER_OFF;
  static readonly TYPE_T2S: number = CHINESE_CONVERTER_T2S;
  static readonly TYPE_S2T: number = CHINESE_CONVERTER_S2T;
  private static readonly SOURCES: Record<number, DictionarySource> = {
    1: { charsPath: 'chinese/t2s_characters.txt', phrasesPath: 'chinese/t2s_phrases.txt',
      excludedPhrases: T2S_EXCLUDED_PHRASES },
    2: { charsPath: 'chinese/s2t_characters.txt', phrasesPath: 'chinese/s2t_phrases.txt',
      excludedPhrases: null }
  };
  private static rememberedContext: common.Context | null = null;
  private static readonly dictionaries: Record<number, ChineseDictionary | null> = { 1: null, 2: null };
  private static readonly loadingPromises: Record<number, Promise<void> | null> = { 1: null, 2: null };

  static normalizeType(converterType: number): number {
    const value = Math.round(Number(converterType));
    if (value === CHINESE_CONVERTER_T2S) return CHINESE_CONVERTER_T2S;
    if (value === CHINESE_CONVERTER_S2T) return CHINESE_CONVERTER_S2T;
    return CHINESE_CONVERTER_OFF;
  }

  static isLoaded(converterType: number): boolean {
    return ChineseConverter.dictionaries[ChineseConverter.normalizeType(converterType)] !== null &&
      ChineseConverter.dictionaries[ChineseConverter.normalizeType(converterType)] !== undefined;
  }

  /**
   * 加载指定方向的词典。context 可为 null（此时复用先前记忆的上下文），
   * 两者都缺时静默跳过——调用方随后按未加载处理，不会阻塞。
   */
  static async ensureLoaded(context: common.Context | null, converterType: number): Promise<void> {
    const type = ChineseConverter.normalizeType(converterType);
    if (type === CHINESE_CONVERTER_OFF) return;
    if (context) ChineseConverter.rememberedContext = context;
    if (ChineseConverter.isLoaded(type)) return;
    if (!ChineseConverter.rememberedContext) return;
    const inFlight = ChineseConverter.loadingPromises[type];
    if (inFlight) return inFlight;
    const loadPromise = ChineseConverter.loadDictionary(type).catch((error: Error) => {
      console.warn(`简繁词典加载失败(type=${type}):`, error);
      ChineseConverter.dictionaries[type] = null;
    }).then(() => {
      ChineseConverter.loadingPromises[type] = null;
    });
    ChineseConverter.loadingPromises[type] = loadPromise;
    return loadPromise;
  }

  /** 同步转换。词典未就绪时原样返回并触发后台加载（与改版前 java.t2s 的空转行为一致）。 */
  static convertText(text: string, converterType: number): string {
    const type = ChineseConverter.normalizeType(converterType);
    if (!text || type === CHINESE_CONVERTER_OFF) return text;
    const dict = ChineseConverter.dictionaries[type];
    if (!dict) {
      ChineseConverter.ensureLoaded(null, type).catch(() => {});
      return text;
    }
    return convertWithChineseDictionary(text, dict);
  }

  private static yieldToEventLoop(): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(resolve, 0);
    });
  }

  private static async loadDictionary(type: number): Promise<void> {
    const source = ChineseConverter.SOURCES[type];
    const context = ChineseConverter.rememberedContext;
    if (!source || !context) return;
    const charsText = await ChineseConverter.readRawText(context, source.charsPath);
    const phrasesText = await ChineseConverter.readRawText(context, source.phrasesPath);
    const dict = createEmptyChineseDictionary();
    const charLines = charsText ? charsText.split('\n') : [];
    let cursor = ChineseConverter.applyChunked(dict, charLines, 0, false, source.excludedPhrases);
    while (cursor < charLines.length) {
      await ChineseConverter.yieldToEventLoop();
      cursor = ChineseConverter.applyChunked(dict, charLines, cursor, false, source.excludedPhrases);
    }
    const phraseLines = phrasesText ? phrasesText.split('\n') : [];
    cursor = ChineseConverter.applyChunked(dict, phraseLines, 0, true, source.excludedPhrases);
    while (cursor < phraseLines.length) {
      await ChineseConverter.yieldToEventLoop();
      cursor = ChineseConverter.applyChunked(dict, phraseLines, cursor, true, source.excludedPhrases);
    }
    ChineseConverter.dictionaries[type] = dict;
  }

  private static applyChunked(dict: ChineseDictionary, lines: string[], startIndex: number,
    isPhrase: boolean, excludedPhrases: string[] | null): number {
    return applyChineseDictionaryLines(dict, lines, startIndex, CHARS_PER_PARSE_SLICE,
      isPhrase, excludedPhrases);
  }

  private static async readRawText(context: common.Context, rawFilePath: string): Promise<string> {
    const bytes = await context.resourceManager.getRawFileContent(rawFilePath);
    const decoder = util.TextDecoder.create('utf-8');
    return decoder.decodeWithStream(bytes, { stream: false });
  }
}
