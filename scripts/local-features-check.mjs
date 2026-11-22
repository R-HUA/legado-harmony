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
  const names = [...raw.matchAll(/export (?:class|enum|function|const) (\w+)/g)].map(match => match[1]);
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
load('theme/share/ThemePackageFormat.ts');
load('theme/ThemePackRegistry.ets');
load('theme/BuiltinThemeRegistry.ets');
load('account/ThemeAccessPolicy.ets');
for (const theme of bindings.BuiltinThemeRegistry.all()) {
  assert.equal(bindings.BuiltinThemeRegistry.isFree(theme.id), true);
  assert.equal(bindings.ThemeAccessPolicy.hasThemeAccess(theme.id), true);
  assert.equal(bindings.ThemeAccessPolicy.canUseBubbleStyle(theme.light.regexEmphasis.bubbleStyle), true);
}
assert.equal(bindings.BuiltinThemeRegistry.isFree('unknown-theme'), false);
load('utils/TtsVoiceAvailability.ts');
load('utils/PlaybackSpeed.ts');
load('utils/TtsSettingsStore.ets');
const settings = bindings.TtsSettingsStore.fromStorage();
assert.equal(settings.cloudVoiceId, '');
assert.equal(settings.customVoiceId, 'custom-test');

// (a) 上游新增账号/密码/注销/绑定接口及华为授权入口必须在 COMMERCE_ENABLED=false 时于发起请求前被拦截。
for (const action of [
  () => api.registerWithPassword('user', 'password123'),
  () => api.loginWithPassword('user', 'password123'),
  () => api.fetchLoginMethods('token'),
  () => api.bindHuawei('code', 'token'),
  () => api.requestAccountDeletion('password123', 'token'),
  () => api.cloudRequest('/summary', 'GET', '', 'token')
]) {
  await assert.rejects(action, error => error.errorCode === 'SERVICE_DISABLED');
}
const requestsBeforeAuth = requests.length;
Object.assign(bindings, {
  authentication: {
    HuaweiIDProvider: class {
      createAuthorizationWithHuaweiIDRequest() {
        throw new Error('HuaweiIDProvider must not run when commerce is disabled');
      }
    },
    AuthenticationController: class {}
  },
  common: {},
  Context: class {},
  util: { generateRandomUUID: () => 'uuid', Base64Helper: class {} },
  image: {},
  AccountSessionStore: {
    ...bindings.AccountSessionStore,
    load: async () => {},
    isLoggedIn: () => false,
    token: () => ''
  },
  CloudSyncSettingsStore: { STORAGE_ENABLED: 'cloudSyncEnabled', load: async () => {} }
});
load('account/HuaweiAccountService.ets');
await assert.rejects(() => bindings.HuaweiAccountService.login({}), error => error.errorCode === 'SERVICE_DISABLED');
await assert.rejects(() => bindings.HuaweiAccountService.authorize({}), error => error.errorCode === 'SERVICE_DISABLED');
assert.equal(requests.length, requestsBeforeAuth, 'Blocked account/auth methods must never reach HTTP');

// (b) main_pages.json 必须为合法 JSON 且不注册账号/会员/云空间路由。
const readRepo = rel => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const mainPages = JSON.parse(readRepo('entry/src/main/resources/base/profile/main_pages.json'));
assert.ok(Array.isArray(mainPages.src) && mainPages.src.length === 73,
  `main_pages.json must list 73 local routes, got ${mainPages.src?.length}`);
assert.equal(mainPages.src.includes('pages/CoverSettings'), true, 'main_pages.json must include pages/CoverSettings');
for (const removedRoute of [
  'pages/AccountCenter',
  'pages/MemberBenefits',
  'pages/MemberSettings',
  'pages/CloudFiles',
  'pages/AccountPasswordLogin',
  'pages/AccountSecurity'
]) {
  assert.equal(mainPages.src.includes(removedRoute), false, `main_pages.json must exclude ${removedRoute}`);
}

// (c) SettingsTabPage.ets 必须按开关隐藏账号总结卡和在线阅读入口。
const settingsTabSource = readRepo('entry/src/main/ets/components/home/SettingsTabPage.ets');
assert.match(settingsTabSource, /if\s*\(\s*AccountCommerceConfig\.COMMERCE_ENABLED\s*\)\s*\{\s*this\.accountSummaryCard\(\)\s*\}/,
  'SettingsTabPage.ets must gate accountSummaryCard() by AccountCommerceConfig.COMMERCE_ENABLED');
assert.match(settingsTabSource, /if\s*\(\s*!LocalBuildFeatures\.WEB_PARSE_ALWAYS_ON\s*\)\s*\{[\s\S]*?'pages\/WebParseSettings'/,
  'SettingsTabPage.ets must gate pages/WebParseSettings entry by !LocalBuildFeatures.WEB_PARSE_ALWAYS_ON');

// (d) WebParseSettingsStore 在 WEB_PARSE_ALWAYS_ON=true 下应始终开启，忽略磁盘 false 并阻止 disable()。
load('config/LocalBuildFeatures.ets');
const webParseStorage = new Map();
const webParseVm = vm.createContext({
  AppStorage: {
    get: key => webParseStorage.get(key),
    setOrCreate: (key, value) => webParseStorage.set(key, value)
  },
  preferences: {
    getPreferences: async () => ({
      get: async (_key, fallback) => (fallback === '' ? false : fallback),
      put: async () => {},
      flush: async () => {}
    })
  },
  AppDatabase: {
    getInstance: () => ({
      initWithContext: async () => {},
      countBookSources: async () => 0
    })
  },
  console
});
const compileModule = file => stripTypeScriptTypes(
  readRepo('entry/src/main/ets/' + file)
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export /gm, ''),
  { mode: 'strip' }
);
vm.runInContext(
  compileModule('config/LocalBuildFeatures.ets') + '\n' +
  compileModule('utils/WebParseSettingsStore.ets') +
  '\nglobalThis.webParseApi = { WebParseSettingsStore };',
  webParseVm
);
const { WebParseSettingsStore } = webParseVm.webParseApi;
assert.equal(WebParseSettingsStore.enabled(), true);
assert.equal(WebParseSettingsStore.visibleBook('https://example.com'), true);
await WebParseSettingsStore.load({});
assert.equal(webParseStorage.get('webParseEnabled'), true);
assert.equal(webParseStorage.get('webParseNoticePending'), false);
await WebParseSettingsStore.disable({});
assert.equal(WebParseSettingsStore.enabled(), true);

// (e) 眼动翻页入口/XComponent/提示/相机权限关闭，aiengine 仍保留开源 FaceEye 兼容桩。
assert.equal(bindings.LocalBuildFeatures.EYE_TURN, false);
const settingsPageSource = readRepo('entry/src/main/ets/pages/Settings.ets');
assert.match(settingsPageSource, /if\s*\(\s*LocalBuildFeatures\.EYE_TURN\s*\)\s*\{[\s\S]*?眼动翻页（beta）[\s\S]*?新版识别模型（beta）[\s\S]*?eyeTurnCalibrationStatusItem\(\)/,
  'Settings.ets must gate eye-turn settings block by LocalBuildFeatures.EYE_TURN');
const readBookSource = readRepo('entry/src/main/ets/pages/ReadBook.ets');
assert.match(readBookSource, /if\s*\(\s*LocalBuildFeatures\.EYE_TURN\s*\)\s*\{\s*ReaderSettingGroup\(\{\s*title:\s*'眼动'/,
  'ReadBook.ets must gate eye-turn ReaderSettingGroup by LocalBuildFeatures.EYE_TURN');
assert.match(readBookSource, /if\s*\(\s*LocalBuildFeatures\.EYE_TURN\s*&&\s*this\.readerEyeTurnEnabled\s*\)\s*\{[\s\S]*?reader_eye_turn_camera_surface/,
  'ReadBook.ets must gate camera XComponent by LocalBuildFeatures.EYE_TURN');
assert.match(readBookSource, /readerEyeTurnCueAllowed\(\)\s*:\s*boolean\s*\{\s*return\s+LocalBuildFeatures\.EYE_TURN\s*&&/,
  'ReadBook.ets must gate readerEyeTurnCueAllowed() by LocalBuildFeatures.EYE_TURN');
const aiIndexSource = readRepo('aiengine/Index.ets');
assert.ok(aiIndexSource.includes('FaceEyeLandmarks') && aiIndexSource.includes('FaceEyeSample'),
  'aiengine/Index.ets must export FaceEyeLandmarks and FaceEyeSample');
const moduleJson = JSON.parse(readRepo('entry/src/main/module.json5'));
assert.equal(
  moduleJson.module.requestPermissions.some(perm => perm.name === 'ohos.permission.CAMERA'),
  false,
  'entry/src/main/module.json5 must not request ohos.permission.CAMERA'
);

// (f) TtsSettings.ets 必须按开关隐藏在线朗读额度与兑换字数包入口。
const ttsSettingsSource = readRepo('entry/src/main/ets/pages/TtsSettings.ets');
assert.match(
  ttsSettingsSource,
  /if\s*\(\s*AccountCommerceConfig\.COMMERCE_ENABLED\s*\)\s*\{\s*this\.ttsCommerceSection\(\)\s*;?\s*this\.ttsPackagesSection\(\)\s*;?\s*\}/,
  'TtsSettings.ets must gate ttsCommerceSection() and ttsPackagesSection() by AccountCommerceConfig.COMMERCE_ENABLED'
);

// (g) About.ets 移除交流与反馈、贡献者感谢和备案号，保留崩溃记录与开源许可；Index.ets 同步更新崩溃记录路径提示。
const aboutSource = readRepo('entry/src/main/ets/pages/About.ets');
for (const removedText of [
  '交流与反馈',
  'i@icynol.com',
  'QQ 交流群',
  'CommunityGroup',
  '与轻页同行',
  'thanksCard',
  'AboutContributor',
  '蜀ICP备',
  'APP 备案编号',
  '版权与投诉',
  'COMPLAINT_NOTICE'
]) {
  assert.equal(aboutSource.includes(removedText), false, `About.ets must exclude ${removedText}`);
}
assert.ok(aboutSource.includes("'pages/CrashReports'"), 'About.ets must keep pages/CrashReports entry');
assert.ok(aboutSource.includes("'pages/OpenSourceLicenses'"), 'About.ets must keep pages/OpenSourceLicenses entry');
const indexSource = readRepo('entry/src/main/ets/pages/Index.ets');
assert.ok(indexSource.includes('“关于 › 崩溃记录”'), 'Index.ets crash prompt must point to 关于 › 崩溃记录');
assert.equal(indexSource.includes('“关于 › 交流与反馈 › 崩溃记录”'), false,
  'Index.ets crash prompt must not mention 交流与反馈');

// (h) 自定义主题云同步与 DataSync 文件同步行受商业化开关门控。
const dataSyncSource = readRepo('entry/src/main/ets/pages/DataSync.ets');
assert.match(
  dataSyncSource,
  /if\s*\(\s*AccountCommerceConfig\.COMMERCE_ENABLED\s*\)\s*\{[\s\S]*?fileSyncRow\([\s\S]*?'THEME'\)/,
  'DataSync.ets must gate THEME fileSyncRow by AccountCommerceConfig.COMMERCE_ENABLED'
);
const cloudThemeSyncSource = readRepo('entry/src/main/ets/account/CloudThemeSync.ets');
assert.match(cloudThemeSyncSource, /remotePackageIds\(\)[\s\S]*?if\s*\(\s*!AccountCommerceConfig\.COMMERCE_ENABLED\s*\)\s*return\s*\[\]/,
  'CloudThemeSync.remotePackageIds() must return [] when commerce is disabled');
assert.match(cloudThemeSyncSource, /ensureSchemePacks\([\s\S]*?if\s*\(\s*!AccountCommerceConfig\.COMMERCE_ENABLED/,
  'CloudThemeSync.ensureSchemePacks() must bail out when commerce is disabled');

// (i) 设置搜索索引必须剔除停用入口并同步本地特性开关。
const searchIndex = await import('../entry/src/main/ets/utils/SettingsSearchIndex.ts');
assert.equal(searchIndex.DEFAULT_SETTINGS_SEARCH_FLAGS.eyeTurn, bindings.LocalBuildFeatures.EYE_TURN);
assert.equal(searchIndex.DEFAULT_SETTINGS_SEARCH_FLAGS.webParseAlwaysOn, bindings.LocalBuildFeatures.WEB_PARSE_ALWAYS_ON);
assert.equal(searchIndex.DEFAULT_SETTINGS_SEARCH_FLAGS.commerceEnabled, bindings.AccountCommerceConfig.COMMERCE_ENABLED);
assert.equal(searchIndex.DEFAULT_SETTINGS_SEARCH_FLAGS.comicColorizer, false);
for (const hiddenQuery of ['眼动', '新版识别模型', 'AI着色', '着色', '在线阅读', '云同步']) {
  assert.deepEqual(searchIndex.searchSettings(hiddenQuery), [], `Settings search must exclude "${hiddenQuery}"`);
}
for (const hiddenTitle of ['眼动翻页（beta）', '新版识别模型（beta）', 'AI着色', '网页解析', '在线阅读', '云同步']) {
  assert.equal(
    searchIndex.SETTINGS_SEARCH_ENTRIES.some(e => e.title === hiddenTitle),
    false,
    `Settings search entries must exclude "${hiddenTitle}"`
  );
}
assert.equal(
  searchIndex.SETTINGS_SEARCH_ENTRIES.some(e => e.page.url === 'pages/WebParseSettings'),
  false,
  'Settings search must not expose pages/WebParseSettings when WEB_PARSE_ALWAYS_ON=true'
);
assert.ok(searchIndex.searchSettings('简繁转换').some(e => e.title === '简繁转换'),
  'Settings search must include 简繁转换');
assert.ok(searchIndex.searchSettings('导入安卓').some(e => e.page.url === 'pages/DataBackup'),
  'Settings search must route 安卓阅读备份 import directly to pages/DataBackup');

console.log('Local features check passed: commerce blocked before HTTP, sync retained, themes free, old cloud voice disabled, web parse always on, eye-turn & camera disabled, settings search filtered.');
