import { MembershipSnapshot } from './MembershipModels';

/** 每月朗读礼包的资格判断，会员页入口提示和我的权益页共用。 */
export class MembershipGiftRules {
  /** 月度会员不含每月朗读礼包；年度、终身与终身超级会员可领。 */
  static included(membership: MembershipSnapshot, sku: string): boolean {
    if (!membership.active || membership.restricted) return false;
    // 历史领取记录仅用于展示已领字数，不能作为当前档位的礼包资格。
    const benefits = membership.benefits;
    if (benefits) return benefits.standardGiftChars > 0 || benefits.premiumGiftChars > 0;
    return sku === 'ANNUAL' || sku === 'LIFETIME' || sku === 'SUPER_LIFETIME';
  }

  /** 本期礼包可领但还没领。 */
  static pending(membership: MembershipSnapshot, sku: string): boolean {
    return MembershipGiftRules.included(membership, sku) && !membership.claim;
  }
}
