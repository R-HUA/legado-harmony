import assert from 'node:assert/strict';
import test from 'node:test';
import {
  membershipAnniversary, membershipCycle, membershipGiftCycle, membershipGiftChars, membershipBenefits,
  planMembershipPurchase, MembershipState, MembershipError, MembershipSku
} from './membershipPolicy.js';

const time = (value: string) => Date.parse(value + '+08:00');
const jan31 = time('2028-01-31T00:15:00');
const initial = planMembershipPurchase(null, [], 'MONTHLY', jan31, 'period-a');

test('complete entitlement matrix denies paid benefits before activation and at expiry', () => {
  const free = {
    memberThemes: false, animatedAvatar: false, ttsPriority: false,
    sourceCount: 50, sourceBytes: 50 * 1024, cloudStorageBytes: 0, monthlyDownloadBytes: 0,
    standardGiftChars: 0, premiumGiftChars: 0
  };
  assert.deepEqual(membershipBenefits(null, jan31), free);
  const gifts: Record<MembershipSku, [number, number]> = {
    MONTHLY: [0, 0], ANNUAL: [5000, 2500], LIFETIME: [8000, 4000], SUPER_LIFETIME: [12000, 6000]
  };
  for (const sku of Object.keys(gifts) as MembershipSku[]) {
    const state = planMembershipPurchase(null, [], sku, jan31, sku).next;
    const superMember = sku === 'SUPER_LIFETIME';
    assert.deepEqual(membershipBenefits(state, jan31), {
      memberThemes: true, animatedAvatar: state.expiresAt === null, ttsPriority: true,
      sourceCount: superMember ? null : 500, sourceBytes: superMember ? null : 512 * 1024,
      cloudStorageBytes: superMember ? 1024 ** 3 : 0, monthlyDownloadBytes: superMember ? 1024 ** 3 : 0,
      standardGiftChars: gifts[sku][0], premiumGiftChars: gifts[sku][1]
    }, sku);
    assert.deepEqual(membershipBenefits(state, jan31 - 1), free, `${sku}: not started`);
    if (state.expiresAt !== null) assert.deepEqual(membershipBenefits(state, state.expiresAt), free, `${sku}: expired`);
  }
});

test('Beijing month-end anchors recover their day, including leap years', () => {
  assert.equal(membershipAnniversary(jan31, 1), time('2028-02-29T00:15:00'));
  assert.equal(membershipAnniversary(jan31, 2), time('2028-03-31T00:15:00'));
  const leapDay = time('2028-02-29T15:00:00');
  assert.equal(membershipAnniversary(leapDay, 12), time('2029-02-28T15:00:00'));
  assert.equal(membershipAnniversary(leapDay, 48), time('2032-02-29T15:00:00'));
});

test('annual renewal extends the original anchor by twelve months', () => {
  const renewal = planMembershipPurchase(initial.next, [initial.term!], 'ANNUAL', jan31 + 1000, 'ignored');
  assert.equal(renewal.payablePoints, 480);
  assert.equal(renewal.next.periodId, 'period-a');
  assert.equal(renewal.next.expiresAt, time('2029-02-28T00:15:00'));
  assert.equal(renewal.term!.startsAt, initial.next.expiresAt);
});

test('a new membership at the exact expiry creates a separate grant period', () => {
  const next = planMembershipPurchase(initial.next, [], 'MONTHLY', initial.next.expiresAt!, 'period-b');
  assert.equal(next.newPeriod, true);
  assert.equal(next.next.periodId, 'period-b');
  assert.equal(next.creditPoints, 0);
});

test('cycles change at the exact anniversary and cannot be collected in advance', () => {
  const annual = planMembershipPurchase(null, [], 'ANNUAL', jan31, 'annual').next;
  const boundary = time('2028-02-29T00:15:00');
  assert.equal(membershipCycle(annual, boundary - 1).index, 0);
  assert.equal(membershipCycle(annual, boundary).index, 1);
  assert.equal(membershipCycle(annual, time('2028-03-30T00:15:00')).index, 1);
  assert.throws(() => membershipCycle(annual, annual.expiresAt!), MembershipError);
  assert.throws(() => membershipCycle(annual, jan31 - 1), MembershipError);
});

test('upgrade credits only unused time, including future prepaid terms, rounded down', () => {
  const midpoint = jan31 + (initial.term!.endsAt - jan31) / 2;
  const renewal = planMembershipPurchase(initial.next, [], 'ANNUAL', jan31 + 1, 'unused');
  const upgrade = planMembershipPurchase(renewal.next, [initial.term!, renewal.term!],
    'LIFETIME', midpoint, 'unused');
  assert.equal(upgrade.creditPoints, 510);
  assert.equal(upgrade.payablePoints, 780);
  assert.equal(upgrade.next.expiresAt, null);
  assert.equal(upgrade.next.periodId, 'period-a');
  assert.equal(membershipCycle(upgrade.next, midpoint).index, 0);
});

test('permanent upgrade credits the paid permanent value once, without duplicate time credits', () => {
  const life = planMembershipPurchase(null, [], 'LIFETIME', jan31, 'life').next;
  const upgrade = planMembershipPurchase(life, [initial.term!], 'SUPER_LIFETIME', jan31 + 100, 'unused');
  assert.equal(upgrade.payablePoints, 1200);
  assert.equal(upgrade.next.periodId, 'life');
  assert.throws(() => planMembershipPurchase(life, [], 'LIFETIME', jan31 + 1, 'x'), MembershipError);
  assert.throws(() => planMembershipPurchase(life, [], 'ANNUAL', jan31 + 1, 'x'), MembershipError);
  assert.throws(() => planMembershipPurchase(upgrade.next, [], 'SUPER_LIFETIME', jan31 + 100, 'x'), MembershipError);
});

test('historical discounted permanent memberships credit only their recorded value', () => {
  const life: MembershipState = {
    ...planMembershipPurchase(null, [], 'LIFETIME', jan31, 'life').next,
    permanentCreditPoints: 690
  };
  assert.equal(planMembershipPurchase(life, [], 'SUPER_LIFETIME', jan31, 'x').payablePoints, 1800);
});

test('gift amounts follow the four product tiers; permanent periods never expire by age', () => {
  assert.equal(membershipGiftChars('MONTHLY', 'STANDARD'), 0);
  assert.equal(membershipGiftChars('MONTHLY', 'PREMIUM'), 0);
  assert.equal(membershipGiftChars('ANNUAL', 'STANDARD'), 5000);
  assert.equal(membershipGiftChars('ANNUAL', 'PREMIUM'), 2500);
  assert.equal(membershipGiftChars('LIFETIME', 'STANDARD'), 8000);
  assert.equal(membershipGiftChars('LIFETIME', 'PREMIUM'), 4000);
  assert.equal(membershipGiftChars('SUPER_LIFETIME', 'STANDARD'), 12000);
  assert.equal(membershipGiftChars('SUPER_LIFETIME', 'PREMIUM'), 6000);
  const life = planMembershipPurchase(null, [], 'SUPER_LIFETIME', jan31, 'life').next;
  assert.equal(membershipCycle(life, membershipAnniversary(jan31, 240)).index, 240);
  assert.equal(membershipBenefits(life, jan31).cloudStorageBytes, 1024 ** 3);
  assert.equal(membershipBenefits(life, jan31).sourceCount, null);
  assert.equal(membershipBenefits(initial.next, initial.next.expiresAt!).sourceBytes, 50 * 1024);
  assert.equal(membershipBenefits(initial.next, jan31).standardGiftChars, 0);
  assert.equal(membershipBenefits(initial.next, jan31, 'ANNUAL').premiumGiftChars, 2500);
});

test('gift months start at Beijing midnight, cover leap/ordinary February and cross years', () => {
  const annual = planMembershipPurchase(null, [], 'ANNUAL', jan31, 'annual').next;
  const feb = time('2028-02-01T00:00:00');
  assert.deepEqual(membershipGiftCycle(annual, feb - 1), {
    index: 2028 * 12, startsAt: time('2028-01-01T00:00:00'), endsAt: feb
  });
  assert.deepEqual(membershipGiftCycle(annual, feb), {
    index: 2028 * 12 + 1, startsAt: feb, endsAt: time('2028-03-01T00:00:00')
  });
  assert.equal(membershipGiftCycle(annual, Date.parse('2028-02-29T16:00:00Z')).index, 2028 * 12 + 2);
  assert.equal(membershipCycle(annual, feb).index, 0); // Legacy paid-term anniversary remains available for compatibility.
  const life = planMembershipPurchase(annual, [], 'LIFETIME', feb, 'unused').next;
  assert.equal(membershipGiftCycle(life, feb).index, membershipGiftCycle(annual, feb).index);
  assert.equal(membershipGiftCycle(life, time('2029-02-15T00:00:00')).endsAt, time('2029-03-01T00:00:00'));
  assert.equal(membershipGiftCycle(life, time('2029-01-01T00:00:00')).index, 2029 * 12);
  assert.throws(() => membershipGiftCycle(annual, jan31 - 1), MembershipError);
  assert.throws(() => membershipGiftCycle(annual, annual.expiresAt!), MembershipError);
  // A partial final membership month still has a calendar window, but expiry blocks claiming.
  assert.equal(membershipGiftCycle(annual, annual.expiresAt! - 1).endsAt, time('2029-02-01T00:00:00'));
});
