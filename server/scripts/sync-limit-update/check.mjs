// Exercise the candidate's real normalization and quota-selection code without a database or network.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(process.argv[2], 'utf8');
let member = null;
const config = { membershipEnabled: true, membershipSourceLimitsEnabled: false, cloudFiles: { enabled: false } };
const sandbox = vm.createContext({ Buffer, config,
  membershipSnapshot: async () => member,
  inTransaction: async action => action({ query: async sql => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    throw new Error('Unexpected database access before rejecting oversized source');
  } })
});
vm.runInContext(source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, ''), sandbox);
const exchange = vm.runInContext('exchangeSync', sandbox);
const operation = { opId: '123e4567-e89b-42d3-a456-426614174000', entityType: 'book_source',
  entityId: 'legacy', operation: 'upsert', baseRevision: 0, payload: { rules: 'x'.repeat(1000 * 1024) } };
const body = { protocolVersion: 1, appVersion: '3.0.0', deviceId: '123e4567-e89b-42d3-a456-426614174001',
  cursor: 0, operations: [operation] };
const ordinary = { statusCode: 413, code: 'SYNC_PAYLOAD_TOO_LARGE', message: '单项同步数据不能超过 512KB' };
for (const sku of ['', 'MONTHLY', 'ANNUAL', 'LIFETIME', 'SUPER_LIFETIME']) {
  member = sku ? { active: true, state: { sku } } : null;
  await assert.rejects(exchange('test-user', body), sku === 'SUPER_LIFETIME' ?
    { ...ordinary, message: '单项同步数据不能超过 960KB' } : ordinary);
}
member.active = false;
await assert.rejects(exchange('test-user', body), ordinary);
member.active = true;
config.membershipEnabled = false;
await assert.rejects(exchange('test-user', body), ordinary);
await assert.rejects(exchange('test-user', { ...body, operations: [{ ...operation, entityType: 'reader_settings' }] }),
  { statusCode: 413, code: 'SYNC_PAYLOAD_TOO_LARGE', message: '单项同步数据不能超过 64KB' });
console.log('PASS: free/monthly/annual/lifetime=512KB; active super=960KB; disabled/restricted=512KB; other data=64KB');
