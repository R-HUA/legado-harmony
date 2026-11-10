import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const data = new Map();
let current = 'a', calls = [], updates = [], failure, switchOnRead = false;
const store = {
  get: async (key, fallback) => { const result = data.get(key) ?? fallback; if (switchOnRead) current = 'b'; return result; },
  put: async (key, value) => { data.set(key, value); },
  flush: async () => {}, delete: async key => { data.delete(key); }
};
const sandbox = vm.createContext({
  preferences: { getPreferences: async () => store }, util: { generateRandomUUID: () => 'request-1' },
  AccountSessionStore: { account: () => ({ userId: current }), isLoggedIn: () => !!current,
    token: () => 'token-' + current, updateSnapshot: async (_ctx, account) => { updates.push(account); } },
  AccountCommerceApi: { purchaseMembership: async (...args) => {
    calls.push(args); if (failure) throw failure; return { account: { userId: 'a' } };
  } }
});
const source = fs.readFileSync(new URL('../entry/src/main/ets/account/MembershipCommerceService.ets', import.meta.url), 'utf8');
vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), { mode: 'strip' }), sandbox);
const service = vm.runInContext('MembershipCommerceService', sandbox);

failure = Object.assign(new Error('timeout'), { statusCode: 0 });
await assert.rejects(service.purchase({}, 'quote-1', 'a'), /timeout/);
assert.ok(data.has('pending_a'));
await assert.rejects(service.purchase({}, 'quote-2', 'a'), /有一笔/);
failure = undefined;
await service.recover({});
assert.deepEqual(calls[0], calls[1]);
assert.equal(data.size, 0);
assert.equal(updates.length, 1);
await assert.rejects(service.purchase({}, 'quote-2', 'other'), /账号已变化/);
for (const statusCode of [401, 403, 503, 409]) {
  current = 'a'; failure = Object.assign(new Error('rejected'), { statusCode });
  data.set('pending_a', JSON.stringify({ quoteId: 'old', requestId: 'old-request' }));
  await assert.rejects(service.recover({}));
  assert.equal(data.has('pending_a'), statusCode !== 409);
}
// A switch while preferences are loading must not submit A's pending quote with B's token.
current = 'a'; failure = undefined; switchOnRead = true;
data.set('pending_a', JSON.stringify({ quoteId: 'old', requestId: 'old-request' }));
await service.recover({});
assert.equal(calls.at(-1)[2], 'token-a');
assert.equal(updates.length, 1, 'do not overwrite B with A snapshot');
console.log('PASS membership client recovery: persisted identity, retry, account switch, terminal vs uncertain errors');
