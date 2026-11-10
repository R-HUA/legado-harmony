// Run the actual ArkTS crop/submit handlers: animation must never go through PixelMap/JPEG.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { projectRoot } from './lib/ets-module-staging.mjs';

const pageSource = fs.readFileSync(`${projectRoot}/entry/src/main/ets/pages/AccountCenter.ets`, 'utf8');
function method(name) {
  const match = new RegExp(`^  (?:async )?${name}\\(`, 'm').exec(pageSource);
  assert(match, name);
  const end = pageSource.indexOf('\n  }', match.index);
  return pageSource.slice(match.index, end + 4);
}
const bytes = Buffer.from('GIF89a-animation-test-bytes');
let fileSize = bytes.length;
let closed = 0;
let submitted;
const notices = [];
const permanent = (sku = 'SUPER_LIFETIME', benefits = { animatedAvatar: true }) => ({
  active: true, restricted: false, state: { sku, expiresAt: null }, benefits
});
const account = { iapDebtPoints: 0, membership: permanent() };
let refresh = async () => account;
const context = vm.createContext({
  console: { error() {} },
  fs: { OpenMode: { READ_ONLY: 0 }, openSync: () => ({ fd: 1 }), statSync: () => ({ size: fileSize }),
    closeSync: () => { closed++; },
    read: async (_fd, buffer, { offset }) => {
      const count = Math.min(buffer.byteLength, 5); // Exercise partial reads.
      new Uint8Array(buffer).set(bytes.subarray(offset, offset + count));
      return count;
    } },
  image: { createImageSource() { throw new Error('Animation must not be decoded into a static PixelMap'); } },
  AvatarCrop: class {},
  MembershipSnapshot: class {},
  AccountSessionStore: { account: () => account },
  util: { Base64Helper: class { encodeToStringSync(value) { return Buffer.from(value).toString('base64'); } } },
  HdsFeedback: { showToast: value => notices.push(value) },
  HuaweiAccountService: { updateProfile: async (...args) => { submitted = args; }, refresh: () => refresh() }
});
vm.runInContext(stripTypeScriptTypes(`globalThis.page = {
  ${['confirmAvatarCrop', 'canUseAnimatedAvatar', 'ensureAnimatedAvatarAccess', 'useDefaultAvatar', 'saveProfile'].map(method).join(',\n')}
};`, { mode: 'strip' }), context);
const page = context.page;
Object.assign(page, { accountLoggedIn: true, processingCrop: false, cropSourceUri: 'photo://animated.gif',
  cropAnimated: true, cropSourceWidth: 400, cropSourceHeight: 200,
  cropZoom: 2, cropOffsetX: 1, cropOffsetY: -1,
  releaseProfileAvatarPreview() {}, errorMessage: (_e, fallback) => fallback,
  profileNameInput: '读者', savingProfile: false, context: {} });
await page.confirmAvatarCrop();
assert.equal(page.profileAvatarBase64, bytes.toString('base64'));
assert.deepEqual(JSON.parse(JSON.stringify(page.profileAvatarCrop)), { size: 100, left: 300, top: 0 });
assert.equal(page.profileAvatarPreview, 'photo://animated.gif');
assert.equal(page.processingCrop, false);
assert.equal(closed, 1);
await page.saveProfile();
assert.equal(submitted[2], bytes.toString('base64'));
assert.equal(submitted[4].left, 300, 'crop reaches profile API');
page.useDefaultAvatar();
assert.equal(page.profileAvatarCrop, null);
assert.equal(page.profileAvatarBase64, '');
assert.equal(page.removeProfileAvatar, true);
for (const member of [null, { active: true, restricted: false, benefits: {} },
  { active: false, restricted: false, benefits: { animatedAvatar: true } },
  { active: true, restricted: true, benefits: { animatedAvatar: true } }]) {
  account.membership = member;
  assert.equal(page.canUseAnimatedAvatar(), false);
}
for (const sku of ['LIFETIME', 'SUPER_LIFETIME']) {
  account.membership = permanent(sku, {});
  assert.equal(page.canUseAnimatedAvatar(), true, 'missing new field must not erase permanent identity');
  assert.equal(await page.ensureAnimatedAvatarAccess(), false, 'old backend must not receive unsupported GIF');
  assert.match(notices.at(-1), /服务暂未就绪/);
  refresh = async () => { account.membership = permanent(sku); return account; };
  assert.equal(await page.ensureAnimatedAvatarAccess(), true, 'refresh upgrades cached old response');
  account.membership.benefits.animatedAvatar = false;
  refresh = async () => account;
  assert.equal(await page.ensureAnimatedAvatarAccess(), false, 'explicit capability denial is respected');
}
for (const sku of ['MONTHLY', 'ANNUAL']) {
  account.membership = permanent(sku);
  assert.equal(await page.ensureAnimatedAvatarAccess(), false);
  assert.match(notices.at(-1), /仅限有效/);
}
account.membership = permanent();
refresh = async () => { throw new Error('offline'); };
assert.equal(await page.ensureAnimatedAvatarAccess(), false);
assert.match(notices.at(-1), /暂时无法核验/);
refresh = async () => account;
account.iapDebtPoints = 1;
assert.equal(page.canUseAnimatedAvatar(), false);
account.iapDebtPoints = 0;
page.cropSourceUri = 'photo://too-large.gif';
fileSize = 2 * 1024 * 1024 + 1;
await page.confirmAvatarCrop();
assert.equal(page.processingCrop, false);
assert.equal(page.profileAvatarBase64, '');
assert.equal(closed, 2);
console.log('Animated avatar client checks passed: original bytes, partial reads, crop, submission, entitlement and cleanup.');
