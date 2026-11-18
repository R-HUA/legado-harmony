import { LengthMetrics, router } from '@kit.ArkUI';
import { HdsNavigation, HdsNavigationTitleMode, HideMode } from '@kit.UIDesignKit';
import { ThemeRuntime } from '../../theme/ThemeRuntime';
import { AppFontSize } from '../../theme/AppFontSize';
import { ImmersiveBackButton } from '../ImmersiveBackButton';
import { ImmersiveMaterialRuntime } from '../../utils/ImmersiveMaterialRuntime';
import { CollapsingHeader } from '../../utils/CollapsingHeader';
import { HeaderBackdrop } from './HeaderBackdrop';

/**
 * 二级页面的统一骨架：页面底色、沉浸式顶栏（返回、标题、右侧操作）和状态栏/导航条的留白。
 *
 * 内容和右侧操作都用箭头函数传入，保证其中的 this 仍指向页面：
 *   PageScaffold({ title: '其他设置', content: () => { this.pageContent() } })
 *
 * scrollable 为 true 时内容放进带回弹的滚动容器；页面自己用 List 等滚动时传 false，
 * 此时骨架只负责顶部留白，底部留白由页面处理。
 * 列表要从顶栏下方滚过去时再加 edgeToEdge: true，内容铺满整页，上下留白都由页面自己放进列表里。
 * 顶栏默认随内容上滑跟手收起、下滑展开，与首页大标题一致；scrollable 为 false 的页面自己跟踪滚动，
 * 用 CollapsingHeader 算出收起量传给 externalCollapse。不需要收起的页面传 collapsible: false。
 * 设备支持 HDS 时统一改用系统原生 HdsNavigation 标题栏（可滚动页面绑定 Scroller 联动渐变模糊与显隐），
 * API < 23 沿用可收起的自绘顶栏；externalCollapse 用于自绘顶栏及原生模式下右侧操作栏的同步显隐。
 */
@Component
export struct PageScaffold {
  /** 顶栏内容区高度，不含状态栏。 */
  static readonly BAR_HEIGHT: number = 56;

  @Prop title: string = '';
  @Prop scrollable: boolean = true;
  /** 仅在 scrollable 为 false 时有效：内容铺满整页，不留顶栏的位置。 */
  @Prop edgeToEdge: boolean = false;
  /** 滚动内容底部在导航条之上额外留出的高度。 */
  @Prop bottomInset: number = 32;
  @Prop collapsible: boolean = true;
  @Prop externalCollapse: number = 0;
  @State headerCollapse: number = 0;
  /** 页面自行滚动或需要调整滚动位置时传入自己的 Scroller，未传入时使用内置控制器。 */
  scroller: Scroller | undefined = undefined;
  /** 多滚动容器页面（如宽窄屏或双页签）额外绑定的 Scroller 列表。 */
  extraScrollers: Array<Scroller> = [];
  /** 切页面会换滚动容器时传入：每次渲染都现取当前挂载的容器。 */
  scrollerProvider: (() => Array<Scroller>) | undefined = undefined;
  /** 调用方切页时改这个值，触发原生标题栏重新绑定。 */
  @Prop scrollBindingKey: string = '';
  private contentScroller: Scroller = new Scroller();
  @State private actionsWidth: number = 12;
  @StorageProp('appDarkMode') appDarkMode: boolean = false;
  @StorageProp('themeRevision') themeRevision: number = 0;
  @StorageProp('statusBarHeight') statusBarHeight: number = 0;
  @StorageProp('navBarHeight') navBarHeight: number = 0;
  @StorageProp('immersiveLightLevel') immersiveLightLevel: string = 'adaptive';
  @StorageProp('headerFrosted') headerFrosted: boolean = true;
  onBack: () => void = () => {
    router.back();
  };
  @BuilderParam content: () => void = this.emptySlot;
  @BuilderParam actions: () => void = this.emptySlot;

  @Builder
  emptySlot() {
  }

  private allScrollers(): Array<Scroller> {
    // 读取 scrollBindingKey 作为依赖，切页时刷新 HdsNavigation 的滚动容器绑定。
    const _bindingKey = this.scrollBindingKey;
    const result: Array<Scroller> = [];
    if (this.scrollerProvider !== undefined) {
      const provided = this.scrollerProvider();
      if (this.scrollable && provided.length === 0) {
        result.push(this.contentScroller);
      }
      for (let i = 0; i < provided.length; i++) {
        const item = provided[i];
        if (item !== undefined && !result.includes(item)) {
          result.push(item);
        }
      }
      return result;
    }
    if (this.scroller !== undefined) {
      result.push(this.scroller);
    } else if (this.scrollable) {
      result.push(this.contentScroller);
    }
    for (let i = 0; i < this.extraScrollers.length; i++) {
      const extra = this.extraScrollers[i];
      if (extra !== undefined && !result.includes(extra)) {
        result.push(extra);
      }
    }
    return result;
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      if (ImmersiveMaterialRuntime.supportsHdsTabs()) {
        HdsNavigation() {
          this.pageBody()
        }
        .mode(NavigationMode.Stack)
        .titleMode(HdsNavigationTitleMode.MINI)
        .hideBackButton(false)
        .hideToolBar(true)
        .ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.TOP, LayoutSafeAreaEdge.BOTTOM])
        .titleBar({
          avoidLayoutSafeArea: true,
          padding: { end: LengthMetrics.vp(Math.max(16, this.actionsWidth)) },
          content: {
            title: { mainTitle: this.title },
            backIcon: { label: '返回', action: () => this.onBack() }
          },
          style: ImmersiveMaterialRuntime.navigationTitleBarStyle(this.immersiveLightLevel, {
            headerFrosted: this.headerFrosted,
            darkMode: this.appDarkMode
          })
        })
        .bindToScrollable(this.allScrollers())
        .dynamicHideTitleBar({
          hideTitleArea: false,
          hideStatusBar: false,
          mode: HideMode.SCROLL_UP_TO
        })
        .width('100%')
        .height('100%')

        // 保留调用方的操作构建器，对齐右上角并为原生标题预留其实际宽度，与原生标题一致常驻显示。
        Row() {
          Row() {
            this.actions()
          }
          .height(PageScaffold.BAR_HEIGHT)
          .padding({ right: 12 })
          .alignItems(VerticalAlign.Center)
          .onAreaChange((_oldValue: Area, newValue: Area) => {
            const width = parseFloat(String(newValue.width));
            if (Number.isFinite(width) && Math.abs(width - this.actionsWidth) >= 1) {
              this.actionsWidth = width;
            }
          })
        }
        .width('100%')
        .height(PageScaffold.BAR_HEIGHT)
        .margin({ top: this.statusBarHeight })
        .justifyContent(FlexAlign.End)
        .hitTestBehavior(HitTestMode.Transparent)
      } else {
        if (this.scrollable) {
          this.scrollableBody()
        } else {
          Column() {
            this.content()
          }
          .width('100%')
          .height('100%')
          .padding({ top: this.edgeToEdge ? 0 : PageScaffold.BAR_HEIGHT + this.statusBarHeight - this.collapseAmount() })
          .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
        }

        HeaderBackdrop({
          statusBarHeight: this.statusBarHeight,
          backdropHeight: PageScaffold.BAR_HEIGHT + this.statusBarHeight - this.collapseAmount(),
          backdropColor: ThemeRuntime.topBarColor(this.appDarkMode)
        })
          .width('100%')

        if (this.collapsible) {
          Column() {
            this.titleBar()
          }
          .width('100%')
          .height(PageScaffold.BAR_HEIGHT + this.statusBarHeight - this.collapseAmount())
          .clip(true)
          .opacity(CollapsingHeader.contentOpacity(this.collapseAmount()))
          .enabled(CollapsingHeader.acceptsTouch(this.collapseAmount()))
          .hitTestBehavior(CollapsingHeader.acceptsTouch(this.collapseAmount()) ?
            HitTestMode.Default : HitTestMode.BLOCK_DESCENDANTS)
        } else {
          this.titleBar()
        }
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(ThemeRuntime.pageColor(this.appDarkMode))
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }

  collapseAmount(): number {
    if (!this.collapsible) return 0;
    return this.scrollable ? this.headerCollapse : Math.max(0, Math.min(CollapsingHeader.DISTANCE, this.externalCollapse));
  }

  @Builder
  scrollableBody() {
    Scroll(this.scroller || this.contentScroller) {
      Column() {
        this.content()
      }
      .width('100%')
      .padding({
        top: PageScaffold.BAR_HEIGHT + this.statusBarHeight,
        bottom: this.bottomInset + this.navBarHeight
      })
    }
    .edgeEffect(EdgeEffect.Spring, { alwaysEnabled: true })
    .scrollBar(BarState.Off)
    .width('100%')
    .height('100%')
    .align(Alignment.TopStart)
    .onDidScroll((_xOffset: number, yOffset: number) => {
      if (!this.collapsible) return;
      this.headerCollapse = CollapsingHeader.next(this.headerCollapse, yOffset,
        (this.scroller || this.contentScroller).currentOffset().yOffset);
    })
    .onScrollStop(() => {
      if (!this.collapsible) return;
      const target = CollapsingHeader.settle(this.headerCollapse,
        (this.scroller || this.contentScroller).currentOffset().yOffset);
      if (target !== this.headerCollapse) {
        animateTo({ duration: 200, curve: Curve.FastOutSlowIn }, () => {
          this.headerCollapse = target;
        });
      }
    })
  }

  @Builder
  pageBody() {
    if (this.scrollable) {
      this.scrollableBody()
    } else {
      Column() {
        this.content()
      }
      .width('100%')
      .height('100%')
      .padding({ top: this.edgeToEdge ? 0 : PageScaffold.BAR_HEIGHT + this.statusBarHeight })
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
    }
  }

  @Builder
  titleBar() {
    Row() {
      ImmersiveBackButton({ iconColor: ThemeRuntime.primaryTextColor(this.appDarkMode), darkMode: this.appDarkMode,
        buttonSize: 40, containerWidth: 56, materialScale: 0.83, compactLayout: true,
        onBack: () => this.onBack() })
      Text(this.title)
        .fontSize(AppFontSize.TITLE)
        .fontWeight(FontWeight.Bold)
        .fontColor(ThemeRuntime.primaryTextColor(this.appDarkMode))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      this.actions()
    }
    .width('100%')
    .height(PageScaffold.BAR_HEIGHT + this.statusBarHeight)
    .padding({ top: this.statusBarHeight })
    .alignItems(VerticalAlign.Center)
  }
}
