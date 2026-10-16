import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

// 执行生产代码，网络与系统存储使用替身，验证停用边界及本地权益。
const storage = new Map([['ttsCloudVoiceId', 'xiaoyan'], ['ttsCustomVoiceId', 'custom-test']]);
const requests = [];
const bindings = {
  AppStorage: { get: key => storage.get(key), setOrCreate: (key, value) => storage.set(key, value) },
  http: {
    HttpDataType: { ARRAY_BUFFER: 2 },
    RequestMethod: { GET: 'GET', POST: 'POST' },
    createHttp: () => ({
      request: async (url) => { requests.push(url); return { responseCode: 200, result: '{}' }; },
      destroy() {}
    })
  },
  AccountSessionStore: { hasValidEntitlement() { throw Error('Local themes must not query entitlements'); } }
};
function load(file) {
  const raw = fs.readFileSync(new URL('../entry/src/main/ets/' + file, import.meta.url), 'utf8');
  const names = [...raw.matchAll(/export (?:class|enum) (\w+)/g)].map(match => match[1]);
  const source = raw.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  Object.assign(bindings, vm.runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }) +
    '\n;({' + names.join(',') + '})', bindings));
}
load('account/AccountCommerceModels.ets');
load('account/AccountCommerceConfig.ets');
load('account/AccountCommerceApi.ets');
const api = bindings.AccountCommerceApi;
for (const action of [() => api.login('code'), () => api.fetchAccount('token'),
  () => api.fetchThemeCatalog(), () => api.fetchTtsCatalog(), () => api.fetchTtsWallet('token'),
  () => api.redeemTheme('theme', 'request', 60, 365, 'token'),
  () => api.creditIapPurchase('receipt', 'token'),
  () => api.redeemTtsPackage('sku', 'request', 'token')]) {
  await assert.rejects(action, error => error.errorCode === 'SERVICE_DISABLED');
}
assert.equal(requests.length, 0, 'Disabled commerce must never reach HTTP');
await api.fetchSyncSummary('token');
await api.fetchSyncDevices('token');
assert.equal(requests.length, 2);
assert.ok(requests.every(url => url.includes('/v1/sync/')));
load('theme/ThemeModels.ets');
load('theme/BuiltinThemeRegistry.ets');
load('account/ThemeAccessPolicy.ets');
for (const theme of bindings.BuiltinThemeRegistry.all()) {
  assert.equal(bindings.BuiltinThemeRegistry.isFree(theme.id), true);
  assert.equal(bindings.ThemeAccessPolicy.hasThemeAccess(theme.id), true);
  assert.equal(bindings.ThemeAccessPolicy.canUseBubbleStyle(theme.light.regexEmphasis.bubbleStyle), true);
}
assert.equal(bindings.BuiltinThemeRegistry.isFree('unknown-theme'), false);
load('utils/TtsSettingsStore.ets');
const settings = bindings.TtsSettingsStore.fromStorage();
assert.equal(settings.cloudVoiceId, '');
assert.equal(settings.customVoiceId, 'custom-test');
console.log('Local features check passed: commerce blocked before HTTP, sync retained, themes free, old cloud voice disabled.');
