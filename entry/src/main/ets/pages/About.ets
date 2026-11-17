import { bundleManager, common } from '@kit.AbilityKit';
import { syncSystemBars } from '../utils/SystemBars';
import { ThemeRuntime } from '../theme/ThemeRuntime';
import { HdsFeedback } from '../utils/HdsFeedback';
import { AppFontSize } from '../theme/AppFontSize';
import { AppSpacing } from '../theme/AppSpacing';
import { PageScaffold } from '../components/common/PageScaffold';
import { SystemDialogSession } from '../utils/SystemDialogSession';
import { AboutContent } from '../model/AboutContent';

@Entry
@Component
struct AboutPage {
  @StorageLink('appDarkMode') appDarkMode: boolean = false;
  @StorageLink('themeRevision') themeRevision: number = 0;
  @State appVersionName: string = '';
  @State noticesExpanded: boolean = false;
  @State viewportHeight: number = 640;
  private aboutDialog: SystemDialogSession = new SystemDialogSession();

  aboutToAppear(): void {
    this.syncBars();
    this.loadAppVersion();
  }

  onPageShow(): void {
    this.syncBars();
  }

  onPageHide(): void {
    this.closeDialog();
  }

  aboutToDisappear(): void {
    this.closeDialog();
  }

  @Builder
  hero() {
    Column() {
      Image($r('app.media.icon'))
        .width(84)
        .height(84)
        .borderRadius(23)
        .objectFit(ImageFit.Contain)
        .shadow(ThemeRuntime.floatingControlShadow(this.appDarkMode))
        .accessibilityText('开源轻页图标')
      Text('开源轻页')
        .fontSize(AppFontSize.DISPLAY)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.primaryTextColor())
        .letterSpacing(3)
        .margin({ top: 18 })
      Text('让阅读，回到文字本身')
        .fontSize(AppFontSize.CAPTION)
        .fontColor(this.subTextColor())
        .letterSpacing(1)
        .margin({ top: AppSpacing.SM })
      Text(`VERSION  ${this.appVersionName || '-'}`)
        .fontSize(AppFontSize.CAPTION)
        .fontColor(this.subTextColor())
        .padding({ left: AppSpacing.LG, right: AppSpacing.LG, top: AppSpacing.XS, bottom: AppSpacing.XS })
        .backgroundColor(this.accentSurfaceColor())
        .borderRadius(20)
        .margin({ top: AppSpacing.XL })
    }
    .width('100%')
    .padding({ top: AppSpacing.XXXL, bottom: 28 })
  }

  @Builder
  introductionCard() {
    Column({ space: AppSpacing.MD }) {
      Text('OPEN SOURCE · OPEN PAGES')
        .fontSize(AppFontSize.CAPTION)
        .fontColor(this.accentColor())
        .letterSpacing(1)
      Text('轻轻翻开，自在阅读。')
        .fontSize(AppFontSize.SUBTITLE)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.primaryTextColor())
      Text(AboutContent.INTRODUCTION)
        .fontSize(AppFontSize.CAPTION)
        .fontColor(this.subTextColor())
        .lineHeight(22)
        .textAlign(TextAlign.End)
        .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(AppSpacing.XXL)
    .backgroundColor(this.cardColor())
    .borderRadius(this.cardRadius())
  }

  @Builder
  actionCard(icon: Resource, title: string, subtitle: string, action: () => void) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: AppSpacing.MD }) {
        SymbolGlyph(icon)
          .fontSize(21)
          .fontColor([this.accentColor()])
        Column({ space: AppSpacing.XXS }) {
          Text(title)
            .fontSize(AppFontSize.BODY)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.primaryTextColor())
          Text(subtitle)
            .fontSize(AppFontSize.CAPTION)
            .fontColor(this.subTextColor())
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
    }
    .layoutWeight(1)
    .constraintSize({ minHeight: 84 })
    .padding({ left: AppSpacing.LG, right: AppSpacing.LG, top: AppSpacing.XL, bottom: AppSpacing.XL })
    .backgroundColor(this.cardColor())
    .borderRadius(this.cardRadius())
    .onClick(action)
  }

  @Builder
  noticeText(title: string, message: string) {
    Column({ space: AppSpacing.SM }) {
      Text(title)
        .fontSize(AppFontSize.BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.primaryTextColor())
      Text(message)
        .fontSize(AppFontSize.CAPTION)
        .lineHeight(21)
        .fontColor(this.subTextColor())
        .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  notices() {
    Column() {
      Divider()
        .color(ThemeRuntime.dividerColor(this.appDarkMode))
      Button({ type: ButtonType.Normal }) {
        Row({ space: AppSpacing.MD }) {
          SymbolGlyph($r('sys.symbol.security_shield'))
            .fontSize(16)
            .fontColor([this.subTextColor()])
          Text('项目与使用说明')
            .fontSize(AppFontSize.BODY)
            .fontColor(this.primaryTextColor())
          Blank()
          SymbolGlyph(this.noticesExpanded ? $r('sys.symbol.chevron_up') : $r('sys.symbol.chevron_down'))
            .fontSize(12)
            .fontColor([this.subTextColor()])
        }
        .width('100%')
      }
      .width('100%')
      .constraintSize({ minHeight: 56 })
      .padding({ left: AppSpacing.XXS, right: AppSpacing.XXS, top: AppSpacing.LG, bottom: AppSpacing.LG })
      .backgroundColor(Color.Transparent)
      .accessibilityText(`项目与使用说明，${this.noticesExpanded ? '已展开' : '已收起'}`)
      .onClick(() => { this.noticesExpanded = !this.noticesExpanded; })
      if (this.noticesExpanded) {
        Column({ space: AppSpacing.XL }) {
          this.noticeText('项目说明', AboutContent.PROJECT_DESCRIPTION)
          this.noticeText('合规说明', AboutContent.COMPLIANCE_NOTICE)
          this.noticeText('使用提醒', AboutContent.USAGE_NOTICE)
          Text('请仅使用自有、授权或明确允许访问的内容与规则。')
            .fontSize(AppFontSize.CAPTION)
            .fontColor(this.subTextColor())
            .width('100%')
        }
        .width('100%')
        .padding({ bottom: AppSpacing.XL })
      }
    }
    .width('100%')
    .margin({ top: AppSpacing.XXL })
  }

  @Builder
  pageContent() {
    Column() {
      this.hero()
      this.introductionCard()
      Row({ space: AppSpacing.LG }) {
        this.actionCard($r('sys.symbol.code_slash'), '开源与许可', 'GPL-3.0', () => this.openLicenceDialog())
        this.actionCard($r('sys.symbol.doc_text'), '崩溃记录', '闪退与卡死记录', () => this.openCrashReports())
      }
      .width('100%')
      .margin({ top: AppSpacing.LG })
      this.notices()
      Text('开源相伴，阅读自由')
        .fontSize(AppFontSize.CAPTION)
        .fontColor(this.subTextColor())
        .padding({ top: AppSpacing.XL, bottom: 32 })
    }
    .width('100%')
    .constraintSize({ maxWidth: 560 })
    .padding({ left: AppSpacing.XXL, right: AppSpacing.XXL })
  }

  @Builder
  closeDialogButton() {
    Button({ type: ButtonType.Circle }) {
      SymbolGlyph($r('sys.symbol.xmark'))
        .fontSize(16)
        .fontColor([this.primaryTextColor()])
    }
    .width(44)
    .height(44)
    .backgroundColor(ThemeRuntime.softFillColor(this.appDarkMode))
    .accessibilityText('关闭')
    .onClick(() => this.closeDialog())
  }

  @Builder
  contactRow(icon: Resource, title: string, detail: string, action: () => void) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: AppSpacing.LG }) {
        SymbolGlyph(icon)
          .fontSize(20)
          .fontColor([this.accentColor()])
        Column({ space: AppSpacing.XS }) {
          Text(title)
            .fontSize(AppFontSize.BODY)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.primaryTextColor())
          Text(detail)
            .fontSize(AppFontSize.CAPTION)
            .fontColor(this.accentColor())
            .wordBreak(WordBreak.BREAK_ALL)
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(12)
          .fontColor([this.subTextColor()])
      }
      .width('100%')
    }
    .width('100%')
    .constraintSize({ minHeight: 64 })
    .padding(AppSpacing.XL)
    .backgroundColor(ThemeRuntime.softFillColor(this.appDarkMode))
    .borderRadius(ThemeRuntime.largeRadius())
    .onClick(action)
  }

  @Builder
  licenceContent() {
    Column({ space: AppSpacing.LG }) {
      Row() {
        Text('开放，因分享而生')
          .fontSize(AppFontSize.SUBTITLE)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.primaryTextColor())
          .layoutWeight(1)
        this.closeDialogButton()
      }
      .width('100%')
      Text('GPL-3.0')
        .fontSize(AppFontSize.BODY_LARGE)
        .fontColor(this.accentColor())
      Text('开源轻页采用 GPL-3.0 许可证，并包含适用 MIT、Apache-2.0 许可证的第三方组件。')
        .fontSize(AppFontSize.BODY)
        .fontColor(this.subTextColor())
        .lineHeight(24)
        .width('100%')
      this.contactRow($r('sys.symbol.doc_text'), '开源许可详情', '源码信息、版权声明和完整许可文本', () => {
        this.closeDialog();
        this.getUIContext().getRouter().pushUrl({ url: 'pages/OpenSourceLicenses' }).catch((error: Error) => {
          console.warn('打开开源许可失败:', error);
          HdsFeedback.showToast('暂时无法打开开源许可');
        });
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(AppSpacing.XXXL)
  }

  @Builder
  dialogContent() {
    Scroll() {
      Column() {
        this.licenceContent()
      }
      .width('100%')
    }
    .width('100%')
    .constraintSize({ maxHeight: Math.max(120, this.viewportHeight * 0.82) })
    .scrollBar(BarState.Off)
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      PageScaffold({ title: '关于', bottomInset: 0, content: () => {
        this.pageContent()
      } })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageColor())
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
    .onAreaChange((_oldArea: Area, area: Area): void => {
      const nextHeight = Number(area.height);
      if (nextHeight > 0) this.viewportHeight = nextHeight;
    })
  }

  openCrashReports(): void {
    this.getUIContext().getRouter().pushUrl({ url: 'pages/CrashReports' }).catch((error: Error) => {
      console.warn('打开崩溃记录失败:', error);
      HdsFeedback.showToast('暂时无法打开崩溃记录');
    });
  }

  openLicenceDialog(): void {
    if (this.aboutDialog.isOpen()) return;
    this.aboutDialog.open(this.getUIContext(), (): void => {
      this.dialogContent();
    }, {
      darkMode: this.appDarkMode,
      backgroundColor: this.cardColor(),
      autoCancel: true,
      maskColor: ThemeRuntime.scrimColor(this.appDarkMode),
      warnTag: '显示关于页弹窗失败:'
    });
  }

  closeDialog(): void {
    this.aboutDialog.close(this.getUIContext());
  }

  pageColor(): string { return ThemeRuntime.pageColor(this.appDarkMode); }
  cardColor(): string { return ThemeRuntime.cardColor(this.appDarkMode); }
  primaryTextColor(): string { return ThemeRuntime.primaryTextColor(this.appDarkMode); }
  subTextColor(): string { return ThemeRuntime.subTextColor(this.appDarkMode); }
  accentColor(): string { return ThemeRuntime.accentColor(this.appDarkMode); }
  accentSurfaceColor(): string { return ThemeRuntime.accentSurfaceColor(this.appDarkMode); }
  cardRadius(): number { return Math.max(22, ThemeRuntime.cardRadius()); }

  syncBars(): void {
    syncSystemBars(this.getUIContext().getHostContext() as common.UIAbilityContext, this.appDarkMode, this.pageColor());
  }

  loadAppVersion(): void {
    try {
      this.appVersionName = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT)
        .versionName || '';
    } catch (error) {
      console.warn('获取应用版本信息失败:', error);
      this.appVersionName = '';
    }
  }
}
