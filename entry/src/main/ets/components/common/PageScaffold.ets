import { LengthMetrics, router } from '@kit.ArkUI';
import { HdsNavigation, HdsNavigationTitleMode, ScrollEffectType } from '@kit.UIDesignKit';
import { ThemeRuntime } from '../../theme/ThemeRuntime';
import { AppFontSize } from '../../theme/AppFontSize';
import { ImmersiveMaterialRuntime } from '../../utils/ImmersiveMaterialRuntime';
import { ImmersiveBackButton } from '../ImmersiveBackButton';

/**
 * 二级页面的统一骨架：页面底色、沉浸式顶栏（返回、标题、右侧操作）和状态栏/导航条的留白。
 *
 * 内容和右侧操作都用箭头函数传入，保证其中的 this 仍指向页面：
 *   PageScaffold({ title: '其他设置', content: () => { this.pageContent() } })
 *
 * scrollable 为 true 时内容放进带回弹的滚动容器；页面自己用 List 等滚动时传 false，
 * 此时骨架只负责顶部留白，底部留白由页面处理。
 * 自行滚动的页面传入 scroller 启用渐变标题栏；未传时沿用普通顶栏。
 * 列表要从顶栏下方滚过去时再加 edgeToEdge: true，内容铺满整页，上下留白都由页面自己放进列表里。
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
  /** 页面自行滚动时传入实际使用的控制器，标题栏与内容保持联动。 */
  scroller: Scroller | undefined = undefined;
  private contentScroller: Scroller = new Scroller();
  @State private actionsWidth: number = 12;
  @StorageProp('appDarkMode') appDarkMode: boolean = false;
  @StorageProp('themeRevision') themeRevision: number = 0;
  @StorageProp('statusBarHeight') statusBarHeight: number = 0;
  @StorageProp('navBarHeight') navBarHeight: number = 0;
  onBack: () => void = () => {
    router.back();
  };
  @BuilderParam content: () => void = this.emptySlot;
  @BuilderParam actions: () => void = this.emptySlot;

  @Builder
  emptySlot() {
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      if (ImmersiveMaterialRuntime.supportsHdsTabs() && (this.scrollable || this.scroller !== undefined)) {
        HdsNavigation() {
          this.pageBody()
        }
        .mode(NavigationMode.Stack)
        .titleMode(HdsNavigationTitleMode.MINI)
        .hideBackButton(false)
        .hideToolBar(true)
        .titleBar({
          avoidLayoutSafeArea: true,
          padding: { end: LengthMetrics.vp(this.actionsWidth) },
          content: {
            title: { mainTitle: this.title },
            backIcon: { label: '返回', action: () => this.onBack() }
          },
          style: {
            scrollEffectOpts: {
              enableScrollEffect: true,
              scrollEffectType: ScrollEffectType.GRADIENT_BLUR,
              blurEffectiveStartOffset: LengthMetrics.vp(0),
              blurEffectiveEndOffset: LengthMetrics.vp(8)
            },
            originalStyle: {
              contentStyle: {
                titleStyle: { mainTitleColor: ThemeRuntime.primaryTextColor(this.appDarkMode) },
                backIconStyle: { iconColor: ThemeRuntime.primaryTextColor(this.appDarkMode) }
              }
            },
            scrollEffectStyle: {
              backgroundStyle: { backgroundColor: ThemeRuntime.pageColor(this.appDarkMode), maskExtraHeight: 32 },
              contentStyle: {
                titleStyle: { mainTitleColor: ThemeRuntime.primaryTextColor(this.appDarkMode) },
                backIconStyle: { iconColor: ThemeRuntime.primaryTextColor(this.appDarkMode) }
              }
            },
            systemMaterialEffect: {
              materialType: ImmersiveMaterialRuntime.materialType(),
              materialLevel: ImmersiveMaterialRuntime.materialLevel()
            }
          }
        })
        .bindToScrollable([this.scroller || this.contentScroller])
        .width('100%')
        .height('100%')

        // 保留调用方的操作构建器，并为原生标题预留其实际宽度。
        Row() {
          this.actions()
        }
        .height(PageScaffold.BAR_HEIGHT)
        .padding({ right: 12 })
        .margin({ top: this.statusBarHeight })
        .align(Alignment.TopEnd)
        .onAreaChange((_oldValue: Area, newValue: Area) => {
          const width = parseFloat(String(newValue.width));
          if (Number.isFinite(width) && Math.abs(width - this.actionsWidth) >= 1) {
            this.actionsWidth = width;
          }
        })
      } else {
        this.pageBody()
        this.titleBar()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(ThemeRuntime.pageColor(this.appDarkMode))
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }

  @Builder
  pageBody() {
    if (this.scrollable) {
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
      .width('100%')
      .height('100%')
      .align(Alignment.TopStart)
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
    .backgroundColor(ThemeRuntime.topBarColor(this.appDarkMode))
    .backdropBlur(ThemeRuntime.topBarBlur())
    .alignItems(VerticalAlign.Center)
  }
}
