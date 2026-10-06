import { Book, BookSource } from '../../model/data/Book';
import { WebBookService } from './WebBookService';
import { BookUrlSourceMatcher } from './BookUrlSourceMatcher';
import { BookTypeSupport } from './BookTypeSupport';

/** 链接导入只解析候选；用户确认前不写入书架。 */
export class BookUrlImportService {
  private service: WebBookService = new WebBookService();
  private canceled: boolean = false;

  cancel(): void {
    this.canceled = true;
    this.service.cancelPendingRequests();
  }

  async resolve(input: string, sources: BookSource[], onProgress: (message: string) => void): Promise<Book> {
    const bookUrl = BookUrlSourceMatcher.normalize(input);
    const matches = BookUrlSourceMatcher.match(bookUrl, sources);
    if (matches.sources.length === 0) {
      throw new Error(matches.invalidPatternCount > 0 ?
        '未找到匹配书源，部分书源的详情链接规则无效，请在书源管理中检查' :
        '未找到匹配书源，请先导入并启用该网站的书源');
    }
    for (let index = 0; index < matches.sources.length; index++) {
      if (this.canceled) throw new Error('已取消解析');
      const source = matches.sources[index];
      onProgress(`正在使用“${source.bookSourceName}”解析（${index + 1}/${matches.sources.length}）`);
      const book = new Book();
      book.bookUrl = bookUrl;
      book.origin = source.bookSourceUrl;
      book.originName = source.bookSourceName;
      book.group = -2147483645;
      BookTypeSupport.applyBookType(book, source);
      try {
        const resolved = await this.service.getBookInfo(source, book);
        if (this.canceled) throw new Error('已取消解析');
        // WebBookService 在网络失败/验证页时可能返回原对象，不能当成解析成功。
        if (resolved.name.trim() && resolved.tocUrl.trim()) return resolved;
      } catch (error) {
        if (this.canceled) throw new Error('已取消解析');
        console.warn('链接导入书源解析失败:', source.bookSourceName, error);
      }
    }
    throw new Error('匹配的书源未能解析书籍，请确认是详情页链接，并检查网络、书源规则或书源登录状态');
  }
}
