import { BookSource } from '../../model/data/Book';
import { JavaRegexCompat } from '../rule/JavaRegexCompat';

export class BookUrlSourceMatches {
  sources: BookSource[] = [];
  invalidPatternCount: number = 0;
}

/** 仅接受用户粘贴的网页地址，不将输入当作书源请求选项或脚本执行。 */
export class BookUrlSourceMatcher {
  static normalize(input: string): string {
    const value = input.trim();
    if (!/^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(value) ||
      /[\u0000-\u0020\u007f\\<>"{}]/.test(value) || !BookUrlSourceMatcher.authority(value)) {
      throw new Error('请输入完整的 HTTP 或 HTTPS 书籍详情链接');
    }
    return value.replace(/^https?:/i, (scheme: string): string => scheme.toLowerCase());
  }

  private static authority(value: string): string {
    const match = /^https?:\/\/([^/?#\s]+)/i.exec(value);
    if (!match || match[1].includes('@')) return '';
    const authority = match[1].toLowerCase();
    if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9\u0080-\uffff](?:[a-z0-9\u0080-\uffff.-]*[a-z0-9\u0080-\uffff])?)(?::\d{1,5})?$/.test(authority)) return '';
    const port = /:(\d+)$/.exec(authority);
    if (port && (Number(port[1]) < 1 || Number(port[1]) > 65535)) return '';
    return authority.replace(/^(.+):(?:80|443)$/, (whole: string, host: string): string => {
      return (/^http:\/\//i.test(value) && whole.endsWith(':80')) ||
        (/^https:\/\//i.test(value) && whole.endsWith(':443')) ? host : whole;
    });
  }

  static match(bookUrl: string, sources: BookSource[]): BookUrlSourceMatches {
    const result = new BookUrlSourceMatches();
    const authority = BookUrlSourceMatcher.authority(bookUrl);
    if (!authority) return result;
    const sameSite: BookSource[] = [];
    const patterns: BookSource[] = [];
    for (const source of sources) {
      if (!source.enabled) continue;
      // 与阅读相同：站点直接匹配优先，再尝试显式详情地址正则。
      if (BookUrlSourceMatcher.authority(source.bookSourceUrl) === authority) {
        sameSite.push(source);
      } else if (source.bookUrlPattern.trim()) {
        try {
          const pattern = JavaRegexCompat.compile(source.bookUrlPattern);
          const matched = new RegExp(`^(?:${pattern.source})(?![\\s\\S])`, pattern.flags).exec(bookUrl);
          if (matched && matched.index === 0 && matched[0].length === bookUrl.length) patterns.push(source);
        } catch (_) {
          result.invalidPatternCount++;
        }
      }
    }
    result.sources = sameSite.concat(patterns);
    return result;
  }
}
