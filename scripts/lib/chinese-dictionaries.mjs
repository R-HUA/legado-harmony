// 用应用唯一的简繁实现（entry/src/main/ets/utils/ChineseConverter.ts）的纯函数构建 OpenCC 字典，
// 供简繁相关检查脚本使用。字典文件原样打包在 entry/src/main/resources/rawfile/chinese/。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { readEtsModule } from './ets-module-staging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const chineseDictDir = path.join(root, 'entry/src/main/resources/rawfile/chinese');

export function readChineseDictionary(name) {
  return fs.readFileSync(path.join(chineseDictDir, name), 'utf8');
}

export function loadChineseConverter() {
  const source = readEtsModule('utils/ChineseConverter.ts');
  const names = [...source.matchAll(/export (?:class|function|const) (\w+)/g)].map((match) => match[1]);
  const stripped = source.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  const mod = vm.runInNewContext(stripTypeScriptTypes(stripped, { mode: 'transform' }) +
    '\n;({' + names.join(',') + '})', { console, setTimeout: (fn) => fn() });
  const build = (chars, phrases, excluded) => {
    const dict = mod.createEmptyChineseDictionary();
    const charLines = readChineseDictionary(chars).split('\n');
    mod.applyChineseDictionaryLines(dict, charLines, 0, charLines.length, false, null);
    if (phrases) {
      const phraseLines = readChineseDictionary(phrases).split('\n');
      mod.applyChineseDictionaryLines(dict, phraseLines, 0, phraseLines.length, true, excluded);
    }
    return dict;
  };
  const t2s = build('t2s_characters.txt', 't2s_phrases.txt', mod.T2S_EXCLUDED_PHRASES);
  const s2t = build('s2t_characters.txt', 's2t_phrases.txt', null);
  const tw = build('tw_variants.txt', null, null);
  // 置入生产类，后续直接走 ChineseConverter 的静态方法（convertText / convertTextSameLength / convertTaiwan）。
  mod.ChineseConverter.dictionaries[mod.ChineseConverter.TYPE_T2S] = t2s;
  mod.ChineseConverter.dictionaries[mod.ChineseConverter.TYPE_S2T] = s2t;
  mod.ChineseConverter.twVariants = tw;
  const C = mod.ChineseConverter;
  return {
    mod, C, t2s, s2t, tw,
    /** ReaderTextConverter（ReaderTextConvertRuntime.load 返回的同一形状）。 */
    readerConverter: {
      convert: (text) => C.convertText(text, C.TYPE_T2S),
      convertSameLength: (text) => C.convertTextSameLength(text, C.TYPE_T2S)
    },
    /** SearchChineseScript 的 ChineseScriptConverter（与 SearchChineseScriptRuntime 一致：繁→简等长，简→繁台湾用字）。 */
    searchConverter: {
      toSimplified: (text) => C.convertTextSameLength(text, C.TYPE_T2S),
      toTraditional: (text) => C.convertTaiwan(text)
    }
  };
}
