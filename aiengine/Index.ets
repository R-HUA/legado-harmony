// @legado/aiengine 公开接口（R-HUA/legado-harmony 本地构建，GPL-3.0）。
// 来源与改动说明见 README.md / NOTICE.md。
export { AiChineseDirection, AiChineseTextHost, AiHost, AiRuntime } from './src/main/ets/runtime/AiRuntime';
export {
  ComicTextColorSampler, ComicTextColors, ComicTextGeometry, ComicTextLayer, ComicTextPatch, ComicTextPoint, ComicTextRegion, ComicTextResult,
  ComicTextTile
} from './src/main/ets/core/reader/ComicTextTypes';
export { ComicTextRecognizer } from './src/main/ets/core/reader/ComicTextRecognizer';
export {
  ReaderComicSuperResolution, ReaderComicSuperResolutionAccess
} from './src/main/ets/core/reader/ReaderComicSuperResolution';
export { ReaderComicComputeQueue } from './src/main/ets/core/reader/ReaderComicComputeQueue';
export { ComicChineseConverter } from './src/main/ets/core/reader/ComicChineseConverter';
export { ChineseTextConversion, ComicChineseDictionary } from './src/main/ets/core/reader/ComicChineseDictionary';
export { ChineseTaiwanConversion, ChineseTaiwanConverter } from './src/main/ets/core/reader/ChineseTaiwanConverter';
export { TextTranslator } from './src/main/ets/core/reader/TextTranslator';
export { ComicColorModels, ComicColorResult, ComicColorizer } from './src/main/ets/core/reader/ComicColorizer';
export { ComicColorCandidate, ReaderComicColorSession } from './src/main/ets/core/reader/ReaderComicColorSession';
