import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';

/**
 * 繁简转换（参考 HapeLee/legado-with-MD3 的 ChineseUtils 设计）：
 * 全局阅读设置 chineseConverterType 驱动（0 不转换 / 1 繁转简 / 2 简转繁），
 * 词典数据来自 OpenCC ver.1.1.9 文本词典（TSCharacters/TSPhrases、STCharacters/STPhrases、TWVariants），
 * 先按词组最长匹配，再按单字映射。本模块是应用内唯一的简繁转换实现：阅读正文与章节名、
 * 规则引擎的 java.t2s / java.s2t、搜索关键词的台湾用字变体，以及 aiengine 的漫画文字层
 * （经 AiRuntime 注入的宿主接口）都走这里。
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
/** 内部方向：简→繁后再换台湾用字（OpenCC s2tw = STPhrases/STCharacters + TWVariants），只给搜索关键词用。 */
export const CHINESE_CONVERTER_S2TW: number = 3;

const CHARS_PER_PARSE_SLICE: number = 8000;

/**
 * t2s 词组排除表（沿用 MD3 版 fixT2sDict 的机制）。
 *
 * 2026-11 按 TSPhrases.txt（OpenCC 1.1.9）审计原 MD3 列表：112 项里 109 项根本不在 TSPhrases 中
 * （MD3 的列表针对港台地区词表，对 t2s 无效），只有「明覆」「明瞭」「沈船」命中，而它们的词组
 * 结果（明复/明了/沉船）恰是正确转换，排除后反而保留繁体原字。因此清空列表、保留机制；
 * scripts/chinese-converter-check.mjs 校验此处每一项都真实存在于 t2s 词组表中。
 */
export const T2S_EXCLUDED_PHRASES: string[] = [];

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

/**
 * 等长转换：结果与原文 UTF-16 长度逐位对齐（阅读进度偏移、查找高亮都按原文位置记）。
 * 会改变长度的词组（如映射到扩展区汉字）跳过并退回单字；会改变长度的单字保留原字。
 */
export function convertWithChineseDictionarySameLength(text: string, dict: ChineseDictionary): string {
  if (!text || (dict.chars.size === 0 && dict.phrases.size === 0)) return text;
  const units = Array.from(text);
  const out: string[] = [];
  const maxLen = dict.maxPhraseLength;
  const sameChar = (ch: string): string => {
    const mapped = dict.chars.get(ch);
    return mapped !== undefined && mapped.length === ch.length ? mapped : ch;
  };
  for (let i = 0; i < units.length; i++) {
    const ch = units[i];
    if (maxLen < 2 || !dict.phraseStarts.has(ch)) {
      out.push(sameChar(ch));
      continue;
    }
    const limit = Math.min(maxLen, units.length - i);
    let consumed = 0;
    for (let len = limit; len >= 2; len--) {
      const candidate = units.slice(i, i + len).join('');
      const target = dict.phrases.get(candidate);
      if (target !== undefined && target.length === candidate.length) {
        out.push(target);
        consumed = len;
        break;
      }
    }
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    out.push(sameChar(ch));
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
  private static readonly TW_VARIANTS_PATH: string = 'chinese/tw_variants.txt';
  private static twVariants: ChineseDictionary | null = null;
  private static twVariantsLoading: Promise<void> | null = null;

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

  /** 等长同步转换（见 convertWithChineseDictionarySameLength）；词典未就绪时原样返回并触发后台加载。 */
  static convertTextSameLength(text: string, converterType: number): string {
    const type = ChineseConverter.normalizeType(converterType);
    if (!text || type === CHINESE_CONVERTER_OFF) return text;
    const dict = ChineseConverter.dictionaries[type];
    if (!dict) {
      ChineseConverter.ensureLoaded(null, type).catch(() => {});
      return text;
    }
    return convertWithChineseDictionarySameLength(text, dict);
  }

  static isTaiwanLoaded(): boolean {
    return ChineseConverter.isLoaded(CHINESE_CONVERTER_S2T) && ChineseConverter.twVariants !== null;
  }

  /** 加载简→繁词典与台湾用字变体表。 */
  static async ensureTaiwanLoaded(context: common.Context | null): Promise<void> {
    await ChineseConverter.ensureLoaded(context, CHINESE_CONVERTER_S2T);
    if (ChineseConverter.twVariants || !ChineseConverter.rememberedContext) return;
    if (!ChineseConverter.twVariantsLoading) {
      const ctx = ChineseConverter.rememberedContext;
      ChineseConverter.twVariantsLoading = ChineseConverter.readRawText(ctx, ChineseConverter.TW_VARIANTS_PATH)
        .then((text: string): void => {
          const dict = createEmptyChineseDictionary();
          applyChineseDictionaryLines(dict, text ? text.split('\n') : [], 0, Number.MAX_SAFE_INTEGER, false, null);
          ChineseConverter.twVariants = dict;
        }).catch((error: Error): void => {
          console.warn('台湾用字变体表加载失败:', error);
        }).then((): void => {
          ChineseConverter.twVariantsLoading = null;
        });
    }
    await ChineseConverter.twVariantsLoading;
  }

  /** 简→繁（台湾用字）：先 s2t 词组/单字，再按 TWVariants 换字。词典未就绪时原样返回并触发后台加载。 */
  static convertTaiwan(text: string): string {
    if (!text) return text;
    const variants = ChineseConverter.twVariants;
    const s2t = ChineseConverter.dictionaries[CHINESE_CONVERTER_S2T];
    if (!variants || !s2t) {
      ChineseConverter.ensureTaiwanLoaded(null).catch(() => {});
      return text;
    }
    return convertWithChineseDictionary(convertWithChineseDictionary(text, s2t), variants);
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
