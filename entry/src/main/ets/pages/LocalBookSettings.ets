import { router } from '@kit.ArkUI';
import { BookUrlImportService } from '../core/book/BookUrlImportService';
import { BookUrlSourceMatcher } from '../core/book/BookUrlSourceMatcher';
import { BookCover } from '../components/book/BookCover';
import { BookSourceStageRuntimeHost } from '../components/BookSourceStageRuntimeHost';
import { WebBookFetchRuntimeHost } from '../components/WebBookFetchRuntimeHost';
import { SearchExplorePendingBook } from '../utils/SearchExplorePendingBook';
import { SearchBookShelfHelper } from '../utils/SearchBookShelfHelper';
import { BookIdentity } from '../utils/BookIdentity';
import { syncSystemBars } from '../utils/SystemBars';
import { ThemeRuntime } from '../theme/ThemeRuntime';
import { AppDatabase } from '../model/data/AppDatabase';
import { Book } from '@legado/sourceengine';
import { HdsFeedback } from '../utils/HdsFeedback';
import { AppFontSize } from '../theme/AppFontSize';
import { AppSpacing } from '../theme/AppSpacing';
import { PageScaffold } from '../components/common/PageScaffold';
import { CollapsingHeader } from '../utils/CollapsingHeader';
import { ImmersiveMaterialRuntime } from '../utils/ImmersiveMaterialRuntime';

@Entry
@Component
struct LocalBookSettingsPage {
  @State headerCollapse: number = 0;
  @StorageLink('appDarkMode') appDarkMode: boolean = false;
  @StorageLink('themeRevision') themeRevision: number = 0;
  @StorageLink('appLightButtonColor') appLightButtonColor: string = '#007DFF';
  @StorageLink('appDarkButtonColor') appDarkButtonColor: string = '#3F8CFF';
  @StorageProp('navBarHeight') navBarHeight: number = 0;
  @State bookLink: string = '';
  @State isResolving: boolean = false;
  @State isSaving: boolean = false;
  @State linkStatus: string = '';
  @State parsedBook: Book | null = null;
  @State addedToShelf: boolean = false;
  private linkScroller: Scroller = new Scroller();
  private linkService: BookUrlImportService | null = null;
  private linkRequest: number = 0;

  aboutToAppear(): void {
    this.syncBars();
  }

  onPageShow(): void {
    this.syncBars();
  }

  build() {
    Stack() {
      WebBookFetchRuntimeHost()
      PageScaffold({ title: '书籍链接', scrollable: false,
        collapsible: !ImmersiveMaterialRuntime.supportsHdsTabs(),
        scroller: this.linkScroller,
        externalCollapse: this.headerCollapse, content: () => {
        this.pageContent()
      } })
      BookSourceStageRuntimeHost()
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageColor())
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }

  @Builder
  pageContent() {
    Scroll(this.linkScroller) {
      Column() {
        this.linkImportPanel()
      }
      .width('100%')
      .constraintSize({ maxWidth: 448 })
      .padding({ left: AppSpacing.XL, right: AppSpacing.XL, top: AppSpacing.XXXL,
        bottom: 32 + this.navBarHeight })
    }
    .width('100%')
    .height('100%')
    .align(Alignment.Top)
    .edgeEffect(EdgeEffect.Spring, { alwaysEnabled: true })
    .onDidScroll((_x: number, yOffset: number) => {
      this.headerCollapse = CollapsingHeader.next(this.headerCollapse, yOffset,
        this.linkScroller.currentOffset().yOffset);
    })
    .onScrollStop(() => {
      const target = CollapsingHeader.settle(this.headerCollapse, this.linkScroller.currentOffset().yOffset);
      if (target !== this.headerCollapse) {
        animateTo({ duration: 200, curve: Curve.FastOutSlowIn }, () => {
          this.headerCollapse = target;
        });
      }
    })
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

  aboutToDisappear(): void {
    this.cancelLinkImport();
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
        Row({ space: AppSpacing.LG }) {
          Stack() {
            BookCover({
              bookUrl: this.parsedBook.bookUrl,
              origin: this.parsedBook.origin,
              coverUrl: this.parsedBook.coverUrl,
              name: this.parsedBook.name,
              useBookshelfCover: false,
              placeholderColor: this.buttonColor(),
              decodeWidth: 180,
              decodeHeight: 240
            })
          }
          .width(54)
          .height(72)

          Column({ space: AppSpacing.XS }) {
            Text(this.parsedBook.name).fontSize(18).fontWeight(FontWeight.Medium)
              .fontColor(this.primaryTextColor())
              .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(this.parsedBook.author || '作者未知').fontSize(14).fontColor(this.subTextColor())
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(this.parsedBook.originName).fontSize(13).fontColor(this.subTextColor())
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            if (this.parsedBook.intro.trim()) {
              Text(this.parsedBook.intro.replace(/\s+/g, ' ').trim())
                .fontSize(14).fontColor(this.subTextColor()).maxLines(4)
                .textOverflow({ overflow: TextOverflow.Ellipsis }).margin({ top: AppSpacing.XS })
            }
          }
          .layoutWeight(1).alignItems(HorizontalAlign.Start)
        }
        .width('100%').alignItems(VerticalAlign.Top)
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
}
