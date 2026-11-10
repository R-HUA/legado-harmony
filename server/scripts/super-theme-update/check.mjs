import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, runtime, packageDir, live] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(resolve(packageDir, 'manifest.json'), 'utf8'));
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const load = name => import(pathToFileURL(resolve(runtime, name)).href);
if (mode === 'baseline') {
  for (const [file, accepted] of Object.entries(manifest.acceptedBaselines)) {
    let hash = null;
    try { hash = digest(resolve(live, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(accepted.includes(hash), `BASELINE_MISMATCH: ${file}; actual SHA256=${hash}. Stop and adapt the package to this server version.`);
  }
  console.log('PASS: replaced modules match the supported baseline');
  process.exit(0);
}
if (mode === 'health') {
  for (const url of ['http://127.0.0.1:8080/health', 'https://qingye.icynol.com/health']) {
    let ok = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (response.ok && (await response.json()).ok === true) { ok = true; break; }
      } catch {}
      await new Promise(done => setTimeout(done, 1000));
    }
    assert(ok, `Health check failed: ${url}`);
    console.log('PASS health:', url);
  }
  const response = await fetch('http://127.0.0.1:8080/v1/themes/catalog', { signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  const theme = body.themes?.find(item => item.themeId === 'obsidian-archive');
  assert(response.ok && theme?.acquisition === 'SUPER_CLAIM' && theme.pricePoints === 0);
  const denied = await fetch('http://127.0.0.1:8080/v1/membership/themes/obsidian-archive/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'deployment-auth-check' }),
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(denied.status, 401, 'Claim endpoint must reject unauthenticated callers');
  console.log('PASS: claim-only catalog and claim authentication; no entitlement was created');
  process.exit(0);
}
// Import named dependencies without executing index.js (which would start another HTTP listener).
if (mode === 'check') {
  for (const file of ['membershipRoutes.js', 'themeCatalog.js', 'superThemeService.js']) await load(file);
  const source = readFileSync(resolve(runtime, 'index.js'), 'utf8');
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"]/g)) {
    const module = await load(match[2]);
    for (const item of match[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/)[0];
      if (name) assert(name in module, `Missing dependency export: ${match[2]}::${name}`);
    }
  }
  console.log('PASS: candidate modules and entry-point dependency exports load');
}
const { pool } = await load('db.js');
const client = await pool.connect();
try {
  if (mode === 'check') {
    await client.query('BEGIN READ ONLY');
    const identity = (await client.query(`SELECT current_database() AS database, current_user AS role,
      has_schema_privilege(current_user,'public','CREATE') AS can_create`)).rows[0];
    assert.equal(identity.database, 'legado_commerce');
    assert.equal(identity.role, 'qingye');
    // Schema changes run as the database administrator; the application remains least-privileged.
    for (const [table, column] of [['theme_catalog','member_included'], ['membership_gift_claims','gift_month'],
      ['membership_products','sales_starts_at'], ['cloud_files','meta']]) {
      assert.equal((await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name=$1 AND column_name=$2`, [table, column])).rowCount, 1, `Missing prerequisite: ${table}.${column}`);
    }
    for (const table of ['theme_entitlements','membership_accounts','cloud_download_monthly_usage']) {
      assert((await client.query('SELECT to_regclass($1) AS name', ['public.' + table])).rows[0].name, `Missing table: ${table}`);
    }
    assert.equal((await client.query("SELECT has_table_privilege(current_user,'theme_catalog','SELECT') AS allowed")).rows[0].allowed, true, 'Application needs SELECT on theme_catalog');
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
      assert.equal((await client.query("SELECT has_table_privilege(current_user,'theme_entitlements',$1) AS allowed", [privilege])).rows[0].allowed, true, 'Missing theme_entitlements privilege: ' + privilege);
    }
    await client.query('COMMIT');
    console.log('PASS: expected database, application role, runtime permissions and schema prerequisites');
  } else if (mode === 'verify') {
    await client.query('BEGIN READ ONLY');
    const theme = (await client.query("SELECT * FROM theme_catalog WHERE theme_id='obsidian-archive'")).rows[0];
    assert(theme && theme.acquisition === 'SUPER_CLAIM' && Number(theme.price_points) === 0 && !theme.member_included && theme.enabled);
    for (const privilege of ['SELECT','INSERT']) {
      assert.equal((await client.query("SELECT has_table_privilege(current_user,'membership_theme_claims',$1) AS allowed",[privilege])).rows[0].allowed, true, 'Missing claim ledger privilege: ' + privilege);
    }
    await client.query('SELECT 1 FROM membership_theme_claims LIMIT 0');
    await client.query('COMMIT');
    console.log('PASS: migrated catalog and claim ledger accessible to the application; no grants created');
  } else throw new Error('Unknown mode');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally { client.release(); await pool.end(); }
