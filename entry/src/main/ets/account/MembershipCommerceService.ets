import { Context } from '@kit.AbilityKit';
import preferences from '@ohos.data.preferences';
import { util } from '@kit.ArkTS';
import { AccountCommerceApi } from './AccountCommerceApi';
import { AccountSessionStore } from './AccountSessionStore';
import { AccountApiError } from './AccountCommerceModels';

class PendingMembershipPurchase {
  quoteId: string = '';
  requestId: string = '';
}

export class MembershipCommerceService {
  static async claimSuperTheme(context: Context, themeId: string): Promise<void> {
    const userId = AccountSessionStore.account().userId;
    const token = AccountSessionStore.token();
    if (!userId || !token) throw new Error('请先登录');
    const store = await preferences.getPreferences(context, 'membership_theme_claims');
    const key = `${userId}_${themeId}`;
    const old = await store.get(key, '') as string;
    const requestId = old || util.generateRandomUUID();
    await store.put(key, requestId);
    await store.flush();
    try {
      const response = await AccountCommerceApi.claimSuperTheme(themeId, requestId, token);
      if (AccountSessionStore.account().userId !== userId) throw new Error('登录账号已变化，请重新进入主题页');
      await AccountSessionStore.updateSnapshot(context, response.account);
      await store.delete(key);
      await store.flush();
      if (response.claim.expiresAt <= Date.now()) throw new Error('上次领取已确认，请重新领取本年的主题');
    } catch (error) {
      const apiError = error as AccountApiError;
      if (apiError.statusCode >= 400 && apiError.statusCode < 500 && apiError.statusCode !== 429) {
        await store.delete(key);
        await store.flush();
      }
      throw error as Error;
    }
  }

  // Only write after the user confirms the exact quote. Retry the same identity after a timeout/restart.
  static async purchase(context: Context, quoteId: string, expectedUserId: string): Promise<void> {
    const userId = AccountSessionStore.account().userId;
    if (!userId || !AccountSessionStore.isLoggedIn()) throw new Error('请先登录');
    if (userId !== expectedUserId) throw new Error('登录账号已变化，请重新查看价格');
    const store = await preferences.getPreferences(context, 'membership_orders');
    const key = `pending_${userId}`;
    const old = await store.get(key, '') as string;
    if (old) throw new Error('有一笔购买正在确认，请先刷新会员状态');
    if (AccountSessionStore.account().userId !== userId) throw new Error('登录账号已变化，请重新查看价格');
    const pending = new PendingMembershipPurchase();
    pending.quoteId = quoteId;
    pending.requestId = util.generateRandomUUID();
    await store.put(key, JSON.stringify(pending));
    await store.flush();
    await MembershipCommerceService.recover(context);
  }

  static async recover(context: Context): Promise<void> {
    const userId = AccountSessionStore.account().userId;
    if (!userId || !AccountSessionStore.isLoggedIn()) return;
    const token = AccountSessionStore.token();
    const store = await preferences.getPreferences(context, 'membership_orders');
    const key = `pending_${userId}`;
    const raw = await store.get(key, '') as string;
    if (!raw) return;
    const pending = JSON.parse(raw) as PendingMembershipPurchase;
    try {
      const response = await AccountCommerceApi.purchaseMembership(pending.quoteId, pending.requestId,
        token);
      if (AccountSessionStore.account().userId === userId) {
        await AccountSessionStore.updateSnapshot(context, response.account);
      }
      await store.delete(key);
      await store.flush();
    } catch (error) {
      const apiError = error as AccountApiError;
      // An unavailable rollout gate, authentication failure or network error is not proof of non-payment.
      if (apiError.statusCode === 400 || apiError.statusCode === 409) {
        await store.delete(key);
        await store.flush();
      }
      throw error as Error;
    }
  }
}
