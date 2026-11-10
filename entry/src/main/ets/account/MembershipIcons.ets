/**
 * 会员档位的视觉资料。昵称颜色、卡片渐变取自对应图标的主色：
 * 月度青蓝星页、年度紫色环绕星页、终身金色无限星轨、终身超级曜黑香槟金。
 */
export class MembershipIcons {
  static readonly SKUS: string[] = ['MONTHLY', 'ANNUAL', 'LIFETIME', 'SUPER_LIFETIME'];

  static forSku(sku: string): Resource {
    if (sku === 'MONTHLY') return $r('app.media.membership_monthly');
    if (sku === 'LIFETIME') return $r('app.media.membership_lifetime');
    if (sku === 'SUPER_LIFETIME') return $r('app.media.membership_super_lifetime');
    return $r('app.media.membership_annual');
  }

  static label(sku: string): string {
    if (sku === 'MONTHLY') return '月度会员';
    if (sku === 'ANNUAL') return '年度会员';
    if (sku === 'LIFETIME') return '终身会员';
    if (sku === 'SUPER_LIFETIME') return '终身超级会员';
    return '';
  }

  /** 会员昵称颜色；非会员返回空串，由调用方使用普通文字色。 */
  static nameColor(sku: string, darkMode: boolean): string {
    if (sku === 'MONTHLY') return darkMode ? '#5FD3DC' : '#138A99';
    if (sku === 'ANNUAL') return darkMode ? '#B89CFF' : '#7448D6';
    if (sku === 'LIFETIME') return darkMode ? '#E9BC69' : '#A86F14';
    if (sku === 'SUPER_LIFETIME') return darkMode ? '#E2C99B' : '#75562D';
    return '';
  }

  /** 档位强调色：选中边框、徽标底色等；非会员使用香槟金。 */
  static accent(sku: string, darkMode: boolean): string {
    if (sku === 'SUPER_LIFETIME') return darkMode ? '#D6B878' : '#8A6838';
    return MembershipIcons.nameColor(sku, darkMode) || (darkMode ? '#D9B77A' : '#B08A4E');
  }

  /** 会员卡底色渐变，从左上到右下。 */
  static cardGradient(sku: string, darkMode: boolean): Array<[ResourceColor, number]> {
    if (sku === 'MONTHLY') {
      return darkMode ? [['#1D4447', 0], ['#12292C', 1]] : [['#E3F8F8', 0], ['#B1E6E8', 1]];
    }
    if (sku === 'ANNUAL') {
      return darkMode ? [['#33285A', 0], ['#1E1834', 1]] : [['#F1EAFF', 0], ['#D2C0F8', 1]];
    }
    if (sku === 'LIFETIME') {
      return darkMode ? [['#46371F', 0], ['#2A2115', 1]] : [['#FCF2DC', 0], ['#EBCB8F', 1]];
    }
    if (sku === 'SUPER_LIFETIME') {
      return darkMode ? [['#303136', 0], ['#15171C', 1]] : [['#F1EDE5', 0], ['#E9DFD1', 1]];
    }
    return darkMode ? [['#3A3224', 0], ['#26211A', 1]] : [['#F7ECD6', 0], ['#E6CFA2', 1]];
  }

  /** 会员卡上的主文字色。 */
  static cardTextColor(darkMode: boolean): string {
    return darkMode ? '#F4EEE4' : '#2B2418';
  }

  static cardSubTextColor(darkMode: boolean): string {
    return darkMode ? '#C9BFAE' : '#6E5F48';
  }
}
