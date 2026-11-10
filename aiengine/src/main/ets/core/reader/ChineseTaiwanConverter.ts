/** 简→繁（台湾用字）的引擎侧外观：OpenCC s2tw（STPhrases/STCharacters + TWVariants），由宿主实现。 */
export interface ChineseTaiwanConversion {
  convert(text: string): string;
}

export class ChineseTaiwanConverter {
  private readonly conversion: ChineseTaiwanConversion;

  constructor(conversion: ChineseTaiwanConversion) {
    this.conversion = conversion;
  }

  convert(text: string): string {
    return text ? this.conversion.convert(text) : text;
  }
}
