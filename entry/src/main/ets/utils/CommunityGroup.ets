import { common } from '@kit.AbilityKit';
import { HdsFeedback } from './HdsFeedback';

export class CommunityGroup {
  static readonly QQ_GROUP_NUMBER: string = '345769197';

  static async open(context: common.UIAbilityContext): Promise<void> {
    try {
      await context.startAbility({
        action: 'ohos.want.action.viewData',
        uri: `mqqapi://card/show_pslcard?src_type=internal&version=1&uin=${CommunityGroup.QQ_GROUP_NUMBER}&card_type=group&source=qrcode`
      });
    } catch (error) {
      console.error('打开 QQ 交流群失败:', error);
      try {
        HdsFeedback.showToast(`未找到 QQ 或无法打开群资料，请手动搜索群号 ${CommunityGroup.QQ_GROUP_NUMBER}`);
      } catch (toastError) {
        console.error('显示 QQ 交流群提示失败:', toastError);
      }
    }
  }
}
