import { router, LengthMetrics } from '@kit.ArkUI';
import { HdsNavigation, HdsNavigationTitleMode, ScrollEffectType } from '@kit.UIDesignKit';
import { ThemeRuntime } from '../theme/ThemeRuntime';
import { ImmersiveMaterialRuntime } from '../utils/ImmersiveMaterialRuntime';
import { ImmersiveBackButton } from './ImmersiveBackButton';

/** 设置页共用原生渐变标题栏，滚动内容由页面提供。 */
@Component
export struct SettingsPageLayout {
  @Prop pageTitle: string = '';
  @Prop darkMode: boolean = false;
  @StorageProp('statusBarHeight') statusBarHeight: number = 0;
  scroller: Scroller = new Scroller();
  @BuilderParam pageContent: () => void = this.emptyContent;

  @Builder
  emptyContent() {}

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      if (ImmersiveMaterialRuntime.supportsHdsTabs()) {
        HdsNavigation() {
          this.pageContent()
        }
        .mode(NavigationMode.Stack)
        .titleMode(HdsNavigationTitleMode.MINI)
        .hideBackButton(false)
        .hideToolBar(true)
        .titleBar({
          avoidLayoutSafeArea: true,
          content: {
            title: { mainTitle: this.pageTitle },
            backIcon: { label: '返回', action: () => router.back() }
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
                titleStyle: { mainTitleColor: ThemeRuntime.primaryTextColor(this.darkMode) },
                backIconStyle: { iconColor: ThemeRuntime.primaryTextColor(this.darkMode) }
              }
            },
            scrollEffectStyle: {
              backgroundStyle: { backgroundColor: ThemeRuntime.pageColor(this.darkMode), maskExtraHeight: 32 },
              contentStyle: {
                titleStyle: { mainTitleColor: ThemeRuntime.primaryTextColor(this.darkMode) },
                backIconStyle: { iconColor: ThemeRuntime.primaryTextColor(this.darkMode) }
              }
            },
            systemMaterialEffect: {
              materialType: ImmersiveMaterialRuntime.materialType(),
              materialLevel: ImmersiveMaterialRuntime.materialLevel()
            }
          }
        })
        .bindToScrollable([this.scroller])
        .width('100%')
        .height('100%')
      } else {
        this.pageContent()
        Row() {
          ImmersiveBackButton({ iconColor: ThemeRuntime.primaryTextColor(this.darkMode),
            darkMode: this.darkMode, onBack: () => router.back() })
          Text(this.pageTitle)
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor(ThemeRuntime.primaryTextColor(this.darkMode))
        }
        .width('100%')
        .height(56 + this.statusBarHeight)
        .padding({ top: this.statusBarHeight })
        .backgroundColor(ThemeRuntime.pageColor(this.darkMode))
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(ThemeRuntime.pageColor(this.darkMode))
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
