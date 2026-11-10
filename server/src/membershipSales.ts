import { MEMBERSHIP_PRODUCTS, MembershipSku } from './membershipPolicy.js';

/** Server configuration only. Never construct this from a request body or query string. */
export interface MembershipSalesPilot {
  userIds: ReadonlySet<string>;
  skus: ReadonlySet<MembershipSku>;
  expiresAt: number;
}

export function parseMembershipSalesPilot(ids = '', products = '', until = ''): MembershipSalesPilot | undefined {
  if (![ids, products, until].some(value => value.trim())) return undefined;
  const userIds = ids.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const skus = products.split(',').map(value => value.trim()).filter(Boolean);
  const expiresAt = Date.parse(until);
  if (!userIds.length || userIds.some(id => !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) ||
      !skus.length || skus.some(sku => !MEMBERSHIP_PRODUCTS.some(product => product.sku === sku)) ||
      !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(until) || !Number.isFinite(expiresAt)) {
    throw new Error('Invalid membership sales pilot: require UUIDs, valid SKUs and an ISO expiry with timezone');
  }
  return { userIds: new Set(userIds), skus: new Set(skus as MembershipSku[]), expiresAt };
}

export function pilotAllows(pilot: MembershipSalesPilot | undefined, userId: string | undefined,
  sku: MembershipSku, now: number): boolean {
  return !!pilot && !!userId && now < pilot.expiresAt &&
    pilot.userIds.has(userId.toLowerCase()) && pilot.skus.has(sku);
}
