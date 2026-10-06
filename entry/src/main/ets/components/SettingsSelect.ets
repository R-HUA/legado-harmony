import deviceInfo from '@ohos.deviceInfo';
import { uiMaterial } from '@kit.ArkUI';
import { ThemeRuntime } from '../theme/ThemeRuntime';
import { ImmersiveMaterialRuntime } from '../utils/ImmersiveMaterialRuntime';

/** 设置行的选择器：行内透明，弹出菜单独立使用材质与原生勾选。 */
@Component
export struct SettingsSelect {
  @StorageProp('immersiveLightLevel') immersiveLightLevel: string = 'adaptive';
  @Prop options: SelectOption[] = [];
  @Prop selectedIndex: number = 0;
  @Prop selectedLabel: ResourceStr = '';
  @Prop darkMode: boolean = false;
  @Prop textSize: number = 14;
  @Prop textColor: ResourceColor = $r('sys.color.font_secondary');
  onSelected: (index: number) => void = () => {};

  build() {
    Row() {
      // 新属性直接走声明式 Select 入口；设备的 AttributeModifier 代理未提供这些方法。
      if (deviceInfo.sdkApiVersion >= 26) {
        Select(this.options)
          .selected(this.selectedIndex)
          .value(this.selectedLabel)
          .font({ size: this.textSize })
          .fontColor(this.textColor)
          .backgroundColor(Color.Transparent)
          .padding({ left: 0, right: 0 })
          .arrowPosition(ArrowPosition.END)
          .optionBgColor(Color.Transparent)
          .optionFontColor(ThemeRuntime.primaryTextColor(this.darkMode))
          .selectedOptionFontColor(ThemeRuntime.primaryTextColor(this.darkMode))
          .showDefaultSelectedIcon(true)
          .systemMaterial(uiMaterial.Material.empty)
          .menuSystemMaterial(ImmersiveMaterialRuntime.selectMenuMaterial(this.immersiveLightLevel))
          .onSelect((index: number) => this.onSelected(index))
      } else if (deviceInfo.sdkApiVersion >= 20) {
        Select(this.options)
          .selected(this.selectedIndex)
          .value(this.selectedLabel)
          .font({ size: this.textSize })
          .fontColor(this.textColor)
          .backgroundColor(Color.Transparent)
          .padding({ left: 0, right: 0 })
          .arrowPosition(ArrowPosition.END)
          .optionBgColor(Color.Transparent)
          .optionFontColor(ThemeRuntime.primaryTextColor(this.darkMode))
          .selectedOptionFontColor(ThemeRuntime.primaryTextColor(this.darkMode))
          .showDefaultSelectedIcon(true)
          .menuBackgroundColor(ThemeRuntime.dropdownPanelColor(this.darkMode))
          .onSelect((index: number) => this.onSelected(index))
      } else {
        Select(this.options)
          .selected(this.selectedIndex)
          .value(this.selectedLabel)
          .font({ size: this.textSize })
          .fontColor(this.textColor)
          .backgroundColor(Color.Transparent)
          .padding({ left: 0, right: 0 })
          .arrowPosition(ArrowPosition.END)
          .optionBgColor(Color.Transparent)
          .optionFontColor(ThemeRuntime.primaryTextColor(this.darkMode))
          .selectedOptionFontColor(ThemeRuntime.accentColor(this.darkMode))
          .selectedOptionBgColor(ThemeRuntime.accentSurfaceColor(this.darkMode))
          .onSelect((index: number) => this.onSelected(index))
      }
    }
  }
}
