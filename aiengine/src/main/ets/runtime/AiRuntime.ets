/*
 * Harmony Book AI Engine (local GPL-3.0 build for R-HUA/legado-harmony).
 * 宿主接口与运行时注册。引擎不直接依赖 entry 的任何模块：会员/网络/缓存策略和简繁词典都由宿主注入。
 */
import { common } from '@kit.AbilityKit';

/** 宿主能力：授权判断、缓存目录、图片下载、摘要与漫画缓存记账。 */
export interface AiHost {
  /** feature: 'super-resolution' | 'colorization' | 'translation' */
  isAllowed(feature: string): boolean;
  cacheDir(): string;
  downloadImage(source: string): Promise<Uint8Array>;
  digestHashHex(algorithm: string, value: string): string;
  touchComicFile(path: string): void;
  noteComicWrite(path?: string): void;
  /** 处理期间租用漫画缓存文件，防止被缓存清理删除；返回释放函数。 */
  retainComicFile(path: string): () => void;
  /** 阅读器图片标记 → 可读取的图片地址；解析不了时返回空串。 */
  resolveImageSource(marker: string): string;
}

/**
 * 简繁转换方向（与宿主 ChineseConverter 一致）：1 繁→简，2 简→繁，3 简→繁（台湾用字，仅搜索关键词使用）。
 * 引擎本身不带字典，所有繁简转换都委托给宿主的唯一实现。
 */
export class AiChineseDirection {
  static readonly T2S: number = 1;
  static readonly S2T: number = 2;
  static readonly S2TW: number = 3;
}

export interface AiChineseTextHost {
  ensureLoaded(context: common.Context, direction: number): Promise<void>;
  convert(text: string, direction: number): string;
  /** 结果与原文 UTF-16 长度一致；会改变长度的词组/单字保留原文。 */
  convertSameLength(text: string, direction: number): string;
}

export class AiRuntime {
  private static installedHost: AiHost | null = null;
  private static installedChinese: AiChineseTextHost | null = null;

  static install(host: AiHost, chinese?: AiChineseTextHost): void {
    AiRuntime.installedHost = host;
    if (chinese) AiRuntime.installedChinese = chinese;
  }

  static installChineseText(chinese: AiChineseTextHost): void {
    AiRuntime.installedChinese = chinese;
  }

  static installed(): boolean {
    return AiRuntime.installedHost !== null;
  }

  static host(): AiHost {
    const host = AiRuntime.installedHost;
    if (!host) throw new Error('AI 引擎宿主未安装（AiRuntime.install）');
    return host;
  }

  static chineseText(): AiChineseTextHost {
    const chinese = AiRuntime.installedChinese;
    if (!chinese) throw new Error('简繁转换宿主未安装（AiRuntime.installChineseText）');
    return chinese;
  }

  static isAllowed(feature: string): boolean {
    const host = AiRuntime.installedHost;
    return host ? host.isAllowed(feature) : false;
  }
}
