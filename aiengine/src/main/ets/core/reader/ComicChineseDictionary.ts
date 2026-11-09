/**
 * 繁→简转换器的引擎侧外观。上游 8a783195 版本在此自带 OpenCC 字典解析；本构建改为委托宿主
 * （R-HUA 应用的 ChineseConverter），全应用只有一份简繁实现与一份字典。
 */
export interface ChineseTextConversion {
  convert(text: string): string;
  convertSameLength(text: string): string;
}

export class ComicChineseDictionary {
  private readonly conversion: ChineseTextConversion;

  constructor(conversion: ChineseTextConversion) {
    this.conversion = conversion;
  }

  /** 完整转换（漫画文字层、OCR 预览用），词组可改变长度。 */
  convert(text: string): string {
    return text ? this.conversion.convert(text) : text;
  }

  /** 等长转换（小说正文、搜索比对用）：结果与原文 UTF-16 长度一致。 */
  convertSameLength(text: string): string {
    return text ? this.conversion.convertSameLength(text) : text;
  }
}
