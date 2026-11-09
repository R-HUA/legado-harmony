import { BookSource, NativeSourceService } from '@legado/sourceengine';

export class BookSourceExport {
  static toObject(source: BookSource): Object {
    if (NativeSourceService.isNative(source)) return NativeSourceService.exportObject(source);
    let result: Record<string, Object> = {};
    try {
      const parsed = JSON.parse(source.rawSourceJson || '{}') as Object;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result = parsed as Record<string, Object>;
      }
    } catch (_) {}
    result['bookSourceUrl'] = source.bookSourceUrl;
    result['bookSourceName'] = source.bookSourceName;
    result['bookSourceType'] = source.bookSourceType;
    result['bookSourceGroup'] = source.bookSourceGroup;
    result['bookSourceComment'] = source.bookSourceComment;
    result['bookUrlPattern'] = source.bookUrlPattern;
    result['customOrder'] = source.customOrder;
    result['enabled'] = source.enabled;
    result['enabledExplore'] = source.enabledExplore;
    result['enabledCookieJar'] = source.enabledCookieJar;
    result['jsLib'] = source.jsLib;
    result['header'] = source.header;
    result['loginUrl'] = source.loginUrl;
    result['loginUi'] = source.loginUi;
    result['loginCheckJs'] = source.loginCheckJs;
    result['searchUrl'] = source.searchUrl;
    result['exploreUrl'] = source.exploreUrl;
    result['ruleSearch'] = BookSourceExport.mergeRuleForExport(result['ruleSearch'], source.searchRule);
    result['ruleExplore'] = BookSourceExport.mergeRuleForExport(result['ruleExplore'], source.exploreRule);
    result['ruleBookInfo'] = BookSourceExport.mergeRuleForExport(result['ruleBookInfo'], source.bookInfoRule);
    result['ruleToc'] = BookSourceExport.mergeRuleForExport(result['ruleToc'], source.tocRule);
    result['ruleContent'] = BookSourceExport.mergeRuleForExport(result['ruleContent'], source.contentRule);
    result['variableComment'] = source.variableComment;
    result['lastUpdateTime'] = source.lastUpdateTime;
    result['respondTime'] = source.respondTime;
    result['weight'] = source.weight;
    result['concurrentRate'] = source.concurrentRate;
    result['customButton'] = source.customButton;
    result['eventListener'] = source.eventListener;
    if (source.isPinned || result['isPinned'] !== undefined) result['isPinned'] = source.isPinned;
    if (source.isLocked || result['isLocked'] !== undefined) result['isLocked'] = source.isLocked;
    return result;
  }

  private static mergeRuleForExport(rawRule: Object | undefined, storedRule: Object): Object {
    const merged: Record<string, Object> = {};
    if (rawRule && typeof rawRule === 'object' && !Array.isArray(rawRule)) {
      const rawRecord = rawRule as Record<string, Object>;
      for (const key of Object.keys(rawRecord)) merged[key] = rawRecord[key];
    }
    const stored = JSON.parse(JSON.stringify(storedRule || {})) as Record<string, Object>;
    for (const key of Object.keys(stored)) merged[key] = stored[key];
    return merged;
  }

}
