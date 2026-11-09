export class MembershipState {
  periodId: string = '';
  sku: string = '';
  anchorAt: number = 0;
  paidMonths: number = 0;
  expiresAt: number | null = null;
  revision: number = 0;
}

export class MembershipCycle {
  index: number = 0;
  startsAt: number = 0;
  endsAt: number = 0;
}

export class MembershipClaim {
  tier: string = '';
  chars: number = 0;
}

export class MembershipBenefits {
  animatedAvatar: boolean = false;
  standardGiftChars: number = 0;
  premiumGiftChars: number = 0;
  sourceCount: number | null = 50;
  sourceBytes: number | null = 50 * 1024;
  cloudStorageBytes: number = 0;
  monthlyDownloadBytes: number = 0;
}

export class MembershipSnapshot {
  state: MembershipState | null = null;
  active: boolean = false;
  restricted: boolean = false;
  cycle: MembershipCycle | null = null;
  /** 礼包按北京时间自然月领取，endsAt 为下月一日零点（不含）；cycle 保留旧开通日周期供兼容。 */
  giftCycle: MembershipCycle | null = null;
  /** 当前时刻由哪个商品覆盖；定期会员续费后 state.sku 只是最后一次购买的商品。 */
  tierSku: string | null = null;
  claim: MembershipClaim | null = null;
  benefits: MembershipBenefits = new MembershipBenefits();
  serverNow: number = 0;
}

export class MembershipPromotion {
  pricePoints: number = 0;
  label: string = '';
  startsAt: number = 0;
  endsAt: number = 0;
}

export class MembershipProduct {
  sku: string = '';
  name: string = '';
  /** 原价；当前实际扣点见 pricePoints（活动期间更低）。 */
  points: number = 0;
  pricePoints: number = 0;
  months: number | null = null;
  tier: string = '';
  salesEnabled: boolean = false;
  /** 计划开售时间；null 表示由服务端手动开关。 */
  salesStartsAt: number | null = null;
  /** 进行中或即将开始的活动价。 */
  promotion: MembershipPromotion | null = null;
}

export class MembershipCatalog {
  products: MembershipProduct[] = [];
}

export class MembershipQuote {
  quoteId: string = '';
  sku: string = '';
  expiresAt: number = 0;
  listPoints: number = 0;
  creditPoints: number = 0;
  payablePoints: number = 0;
}

export class MembershipOrder {
  id: string = '';
  sku: string = '';
  pointsSpent: number = 0;
  creditPoints: number = 0;
  createdAt: number = 0;
}
export class MembershipOrderList { orders: MembershipOrder[] = []; }
