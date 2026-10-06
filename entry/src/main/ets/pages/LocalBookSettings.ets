import { router } from '@kit.ArkUI';
import { SegmentButton, SegmentButtonOptions } from '@ohos.arkui.advanced.SegmentButton';
import { syncSystemBars } from '../utils/SystemBars';
import { ThemeRuntime } from '../theme/ThemeRuntime';
import { LocalBookScanResult, LocalBookService } from '../core/book/LocalBookService';
import { AppDatabase } from '../model/data/AppDatabase';
import { Book } from '../model/data/Book';
import { SettingsPageLayout } from '../components/SettingsPageLayout';
import { BookUrlImportService } from '../core/book/BookUrlImportService';
import { BookUrlSourceMatcher } from '../core/book/BookUrlSourceMatcher';
import { BookSourceStageRuntimeHost } from '../components/BookSourceStageRuntimeHost';
import { WebBookFetchRuntimeHost } from '../components/WebBookFetchRuntimeHost';
import { SearchExplorePendingBook } from '../utils/SearchExplorePendingBook';
import { SearchBookShelfHelper } from '../utils/SearchBookShelfHelper';
import { BookIdentity } from '../utils/BookIdentity';
import { HdsFeedback } from '../utils/HdsFeedback';

@Entry
@Component
struct LocalBookSettingsPage {
  @StorageLink('appDarkMode') @Watch('refreshTabStyle') appDarkMode: boolean = false;
  @StorageLink('themeRevision') themeRevision: number = 0;
  @StorageLink('appLightButtonColor') appLightButtonColor: string = '#007DFF';
  @StorageLink('appDarkButtonColor') appDarkButtonColor: string = '#3F8CFF';
  @StorageProp('statusBarHeight') statusBarHeight: number = 0;
  @StorageProp('navBarHeight') navBarHeight: number = 0;
  @State isScanning: boolean = false;
  @State statusText: string = '';
  @State importTabs: number[] = [0];
  @State importTabOptions: SegmentButtonOptions = SegmentButtonOptions.tab({
    buttons: [{ text: '书籍链接' }, { text: '本地文件' }]
  });
  @State bookLink: string = '';
  @State isResolving: boolean = false;
  @State isSaving: boolean = false;
  @State linkStatus: string = '';
  @State parsedBook: Book | null = null;
  @State addedToShelf: boolean = false;
  private pageScroller: Scroller = new Scroller();
  private linkService: BookUrlImportService | null = null;
  private linkRequest: number = 0;

  aboutToDisappear(): void {
    this.cancelLinkImport();
  }

  aboutToAppear(): void {
    this.refreshTabStyle();
    this.syncBars();
  }

  onPageShow(): void {
    this.refreshTabStyle();
    this.syncBars();
  }

  refreshTabStyle(): void {
    this.importTabOptions = SegmentButtonOptions.tab({
      buttons: [{ text: '书籍链接' }, { text: '本地文件' }],
      fontColor: this.subTextColor(),
      selectedFontColor: this.primaryTextColor(),
      backgroundColor: ThemeRuntime.inputColor(this.appDarkMode),
      selectedBackgroundColor: this.cardColor()
    });
  }

  build() {
    Stack() {
      WebBookFetchRuntimeHost()
      SettingsPageLayout({ pageTitle: '添加书籍', darkMode: this.appDarkMode,
        scroller: this.pageScroller, pageContent: (): void => this.importContent() })
      BookSourceStageRuntimeHost()
    }
  }

  @Builder
  importContent() {
    Scroll(this.pageScroller) {
      Column({ space: 24 }) {
        Column() {
          SegmentButton({ options: this.importTabOptions, selectedIndexes: $importTabs })
        }
        .width('100%')
        .enabled(!this.isResolving && !this.isSaving && !this.isScanning)
        if (this.importTabs[0] === 0) {
          this.linkImportPanel()
        } else {
          this.localImportPanel()
        }
      }
      .width('100%')
      .constraintSize({ maxWidth: 448 })
      .padding({ left: 16, right: 16,
        top: 64 + this.statusBarHeight,
        bottom: 32 + this.navBarHeight })
    }
    .width('100%')
    .height('100%')
    .align(Alignment.Top)
    .edgeEffect(EdgeEffect.Spring, { alwaysEnabled: true })
  }

  @Builder
  linkImportPanel() {
    Column({ space: 16 }) {
      Column({ space: 8 }) {
        TextArea({ text: this.bookLink, placeholder: '粘贴书籍详情页链接' })
          .height(112)
          .fontSize(16)
          .fontColor(this.primaryTextColor())
          .placeholderColor(this.subTextColor())
          .backgroundColor(this.cardColor())
          .borderRadius(16)
          .padding(16)
          .enabled(!this.isResolving && !this.isSaving)
          .onChange((value: string) => {
            this.bookLink = value;
            this.parsedBook = null;
            this.addedToShelf = false;
            this.linkStatus = '';
          })
        Text('自动匹配已启用的书源')
          .fontSize(13).fontColor(this.subTextColor())
          .margin({ left: 12 })
      }
      .width('100%').alignItems(HorizontalAlign.Start)

      if (this.linkStatus && !this.parsedBook) {
        Text(this.linkStatus).fontSize(14).fontColor(this.subTextColor())
          .width('100%').padding({ left: 12, right: 12 })
      }

      if (this.parsedBook) {
        Column({ space: 8 }) {
          Text(this.parsedBook.name).fontSize(18).fontWeight(FontWeight.Medium)
            .fontColor(this.primaryTextColor())
          Text(this.parsedBook.author || '作者未知').fontSize(14).fontColor(this.subTextColor())
          Text(this.parsedBook.originName).fontSize(13).fontColor(this.subTextColor())
          if (this.parsedBook.intro) {
            Text(this.parsedBook.intro).fontSize(14).fontColor(this.subTextColor()).maxLines(4)
              .textOverflow({ overflow: TextOverflow.Ellipsis }).margin({ top: 4 })
          }
        }
        .width('100%').alignItems(HorizontalAlign.Start)
        .padding(16).borderRadius(16).backgroundColor(this.cardColor())
        Button(this.addedToShelf ? '已在书架' : (this.isSaving ? '正在加入' : '加入书架'))
          .width('100%').height(48)
          .backgroundColor(this.buttonColor()).fontColor('#FFFFFF')
          .enabled(!this.isSaving && !this.addedToShelf)
          .onClick(() => this.saveLinkedBook())
        if (!this.addedToShelf && this.linkStatus && this.linkStatus !== '解析成功') {
          Text(this.linkStatus).fontSize(14).fontColor(this.subTextColor()).width('100%')
        }
      } else {
        Button(this.isResolving ? '取消解析' : '解析链接')
          .width('100%').height(48)
          .backgroundColor(this.buttonColor()).fontColor('#FFFFFF')
          .enabled(this.isResolving || this.bookLink.trim().length > 0)
          .onClick(() => {
            if (this.isResolving) this.cancelLinkImport();
            else this.resolveLink();
          })
      }
      if (!this.isResolving && !this.parsedBook && this.linkStatus.includes('书源')) {
        Button('管理书源')
          .fontSize(14).fontColor(this.buttonColor()).backgroundColor(Color.Transparent)
          .onClick(() => router.pushUrl({ url: 'pages/BookSource' }))
      }
    }
    .width('100%').alignItems(HorizontalAlign.Center)
  }

  @Builder
  localImportPanel() {
    Column({ space: 16 }) {
      Row({ space: 16 }) {
        SymbolGlyph($r('sys.symbol.doc'))
          .fontSize(32).fontColor([this.buttonColor()])
        Column({ space: 6 }) {
          Text('TXT / EPUB').fontSize(17).fontWeight(FontWeight.Medium)
            .fontColor(this.primaryTextColor())
          Text('支持多选，导入后可离线阅读')
            .fontSize(13).fontColor(this.subTextColor())
        }
        .layoutWeight(1).alignItems(HorizontalAlign.Start)
      }
      .width('100%').padding(20).borderRadius(16).backgroundColor(this.cardColor())
      Button(this.isScanning ? '正在导入' : '选择文件')
        .width('100%').height(48)
        .backgroundColor(this.buttonColor()).fontColor('#FFFFFF')
        .enabled(!this.isScanning)
        .onClick(() => this.addBooks())
      if (this.statusText) {
        Text(this.statusText).fontSize(14).fontColor(this.subTextColor())
          .width('100%').padding({ left: 12, right: 12 })
      }
    }
    .width('100%')
  }

  cancelLinkImport(): void {
    this.linkRequest++;
    this.linkService?.cancel();
    this.linkService = null;
    if (this.isResolving) this.linkStatus = '已取消解析';
    this.isResolving = false;
  }

  async resolveLink(): Promise<void> {
    if (this.isResolving || this.isSaving) return;
    const request = ++this.linkRequest;
    this.isResolving = true;
    this.parsedBook = null;
    this.addedToShelf = false;
    this.linkStatus = '正在匹配书源';
    const service = new BookUrlImportService();
    this.linkService = service;
    try {
      const link = BookUrlSourceMatcher.normalize(this.bookLink);
      const db = AppDatabase.getInstance();
      await db.initWithContext(getContext(this));
      const existing = await db.getBook(link);
      if (request !== this.linkRequest) return;
      if (existing && !SearchExplorePendingBook.isPendingAddToShelf(existing)) {
        this.parsedBook = existing;
        this.addedToShelf = true;
        this.linkStatus = '这本书已在书架中';
        return;
      }
      const sources = await db.getAllBookSources();
      if (request !== this.linkRequest) return;
      const book = await service.resolve(link, sources, (message: string) => {
        if (request === this.linkRequest) this.linkStatus = message;
      });
      if (request !== this.linkRequest) return;
      this.parsedBook = book;
      this.linkStatus = '解析成功';
    } catch (error) {
      if (request === this.linkRequest) this.linkStatus = (error as Error).message || '解析失败，请重试';
    } finally {
      if (request === this.linkRequest) {
        this.isResolving = false;
        this.linkService = null;
      }
    }
  }

  async saveLinkedBook(): Promise<void> {
    const book = this.parsedBook;
    if (!book || this.isSaving || this.addedToShelf) return;
    this.isSaving = true;
    try {
      const db = AppDatabase.getInstance();
      await db.initWithContext(getContext(this));
      const existing = await db.getBook(book.bookUrl) ||
        await SearchBookShelfHelper.findShelfBookByKey(BookIdentity.keyOfBook(book), true);
      if (existing) {
        if (SearchExplorePendingBook.isPendingAddToShelf(existing)) {
          SearchExplorePendingBook.clearPendingAddToShelf(existing);
          await db.updateBook(existing, true, 'url_import_keep_existing');
        }
      } else {
        SearchExplorePendingBook.clearPendingAddToShelf(book);
        await db.insertBook(book, 'url_import_add');
      }
      AppStorage.setOrCreate('shelfUpdateTime', Date.now());
      this.addedToShelf = true;
      this.linkStatus = existing ? '这本书已在书架中' : '已加入书架';
      HdsFeedback.showToast(this.linkStatus);
    } catch (error) {
      console.error('链接书籍加入书架失败:', error);
      this.linkStatus = '加入书架失败，请重试';
    } finally {
      this.isSaving = false;
    }
  }

  async addBooks(): Promise<void> {
    if (this.isScanning) return;
    this.isScanning = true;
    try {
      const selected = await LocalBookService.chooseBookFiles(getContext(this));
      if (selected.length === 0) return;
      this.statusText = `正在导入${selected.length}本书...`;
      const result = await LocalBookService.importSelectedFiles(getContext(this), selected);
      this.finishImport(result);
    } catch (e) {
      console.error('添加本地书籍失败:', e);
      this.statusText = '导入失败，请重新选择文件';
      HdsFeedback.showToast('导入失败');
    } finally {
      this.isScanning = false;
    }
  }

  finishImport(result: LocalBookScanResult): void {
    const failed = result.failed > 0 ? `，${result.failed}本失败` : '';
    this.statusText = `导入完成：成功${result.imported}本${failed}`;
    AppStorage.setOrCreate('shelfUpdateTime', Date.now());
    HdsFeedback.showToast(this.statusText);
  }

  pageColor(): string {
    return ThemeRuntime.pageColor(this.appDarkMode);
  }

  cardColor(): string {
    return ThemeRuntime.cardColor(this.appDarkMode);
  }

  primaryTextColor(): string {
    return ThemeRuntime.primaryTextColor(this.appDarkMode);
  }

  subTextColor(): string {
    return ThemeRuntime.subTextColor(this.appDarkMode);
  }

  buttonColor(): string {
    return ThemeRuntime.buttonColor(this.appDarkMode);
  }

  syncBars(): void {
    syncSystemBars(getContext(this), this.appDarkMode, this.pageColor());
  }
}
