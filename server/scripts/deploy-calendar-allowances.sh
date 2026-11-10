#!/usr/bin/env bash
# One-time deployment for the verified 2026-10-22 production baseline.
set -Eeuo pipefail
umask 077

stage=${1:?Supply the verified staging directory}
backup=${2:?Supply the verified backup directory}
live=/www/wwwroot/qingye.icynol.com
node=/www/server/nodejs/v22.23.1/bin/node
service=legado-account.service
env_file=/etc/legado-account.env
files=(membershipPolicy.js membershipService.js cloudFileService.js)
test "$(id -u)" -eq 0
test "$(realpath "$stage")" = /root/qingye-calendar-stage.76NjFt
test "$(realpath "$backup")" = /root/qingye-calendar-backup.cZVrsu
exec 9>/root/qingye-calendar-deploy.lock
flock -n 9
test ! -e "$stage/DEPLOYED"
test ! -e "$stage/ACTIVATION_ATTEMPTED"
exec > >(tee -a "$stage/deploy.log") 2>&1
echo 'Checking deployment inputs...'
printf '%s  %s\n' c7ac5a1b612ecb3e5dc8ba225559a7aff73488c0d7f8260bbea0f4c3905ade26 \
  /root/qingye-calendar-allowances-compat-20261022.zip | sha256sum -c -
(cd "$stage" && sha256sum -c SHA256SUMS)
test -s "$backup/legado_commerce.dump"
/www/server/pgsql/bin/pg_restore --list "$backup/legado_commerce.dump" >/dev/null
cmp "$backup/environment.before" "$env_file"
for file in "${files[@]}" membershipSales.js cloudObjectStore.js package.json; do
  test -f "$live/$file" && test ! -L "$live/$file"
  cmp "$backup/server/$file" "$live/$file"
done
for file in "$live"/*.js "$live/package.json"; do
  name=${file##*/}
  case "$name" in
    membershipPolicy.js|membershipService.js|cloudFileService.js)
      cmp "$stage/runtime/$name" "$stage/server/$name" ;;
    *) cmp "$stage/runtime/$name" "$file" ;;
  esac
done
for file in "${files[@]}"; do "$node" --check "$stage/server/$file"; done
test "$(systemctl show "$service" -p WorkingDirectory --value)" = "$live"
systemctl is-active --quiet "$service"
"$node" --input-type=module - "$stage/preflight.json" <<'PREFLIGHT'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(p.identity.database, 'legado_commerce');
assert.equal(p.identity.role, 'qingye');
assert.equal(p.identity.can_create, true);
assert.equal(p.owners.length, 5);
assert(p.owners.every(row => row.tableowner === 'qingye'));
PREFLIGHT

stop_requested=0
activation=0
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$stop_requested" -eq 1 ]; then
    if [ "$activation" -eq 0 ]; then
      echo 'FAIL before activation. Restoring the previous code; schema additions may remain.'
      if systemctl stop "$service" && [ "$(systemctl show "$service" -p MainPID --value)" = 0 ]; then
        restored=1
        for file in "${files[@]}"; do
          cp -p "$backup/server/$file" "$live/$file" || restored=0
          cmp -s "$backup/server/$file" "$live/$file" || restored=0
        done
        if [ "$restored" -eq 1 ] && systemctl start "$service" && systemctl is-active --quiet "$service"; then
          echo 'Previous service is active. Send the output for diagnosis before retrying.'
        else
          echo 'ATTENTION: previous service recovery needs inspection.'
        fi
      else
        echo 'ATTENTION: could not confirm the service stopped; code was not restored.'
      fi
    else
      echo 'FAIL after activation. Stopping the new service; no automatic code/database rollback.'
      systemctl stop "$service" || true
      echo 'New claims or usage may exist. Send this output before taking further action.'
    fi
    systemctl show "$service" -p ActiveState -p SubState -p MainPID || true
    echo "BACKUP_DIR=$backup"
    echo "LOG=$stage/deploy.log"
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo 'Stopping service for the schema and code update...'
stop_requested=1
systemctl stop "$service"
test "$(systemctl show "$service" -p MainPID --value)" = 0
test "$(systemctl show "$service" -p ActiveState --value)" = inactive

systemd-run --quiet --wait --pipe \
  -p EnvironmentFile="$env_file" -p WorkingDirectory="$stage/runtime" \
  "$node" --input-type=module <<'MIGRATE'
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { pool } from './db.js';
import { membershipCatalog, membershipSnapshot } from './membershipService.js';
import { membershipGiftChars, membershipCalendarCycle } from './membershipPolicy.js';
import { CloudFileService } from './cloudFileService.js';
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '60s'");
  const identity = (await client.query('SELECT current_database() AS db, current_user AS role')).rows[0];
  assert.equal(identity.db, 'legado_commerce');
  assert.equal(identity.role, 'qingye');
  const before = (await client.query('SELECT sku, sales_enabled FROM membership_products ORDER BY sku')).rows;
  const schema = (await client.query(`SELECT
    to_regclass('public.cloud_download_monthly_usage') IS NOT NULL AS monthly_exists,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='membership_gift_claims' AND column_name='gift_month') AS gifts_exist`)).rows[0];
  assert.equal(schema.monthly_exists, false, 'Monthly table already exists; inspect before retrying');
  assert.equal(schema.gifts_exist, false, 'Gift migration already exists; inspect before retrying');
  for (const file of ['000_schema_prerequisites.sql', '021_membership_calendar_gifts.sql', '022_cloud_calendar_downloads.sql']) {
    const sql = readFileSync('../migrations/' + file, 'utf8');
    assert.equal((sql.match(/^BEGIN;\s*$/gm) || []).length, 1);
    assert.equal((sql.match(/^COMMIT;\s*$/gm) || []).length, 1);
    await client.query(sql.replace(/^(?:BEGIN|COMMIT);[ \t]*\r?$/gm, ''));
    console.log('PASS migration:', file);
  }
  const after = (await client.query('SELECT sku, sales_enabled FROM membership_products ORDER BY sku')).rows;
  assert.deepEqual(after, before);
  const fresh = (await client.query(`SELECT
    (SELECT count(*)::int FROM membership_products WHERE sales_starts_at IS NOT NULL) AS schedules,
    (SELECT count(*)::int FROM membership_promotions) AS promotions,
    (SELECT count(*)::int FROM cloud_download_monthly_usage) AS monthly_rows,
    (SELECT count(*)::int FROM membership_gift_claims WHERE gift_month IS NOT NULL) AS new_claims,
    (SELECT count(*)::int FROM cloud_download_tickets WHERE download_month IS NOT NULL) AS new_tickets`)).rows[0];
  assert.deepEqual(fresh, { schedules: 0, promotions: 0, monthly_rows: 0, new_claims: 0, new_tickets: 0 });
  const owners = (await client.query(`SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public'
    AND tablename IN ('membership_promotions','cloud_file_tombstones','cloud_download_monthly_usage')`)).rows;
  assert.equal(owners.length, 3);
  assert(owners.every(row => row.tableowner === 'qingye'));
  const catalog = await membershipCatalog(client);
  assert.equal(catalog.length, 4);
  for (const [sku, standard, premium] of [['MONTHLY',0,0], ['ANNUAL',5000,2500], ['LIFETIME',8000,4000], ['SUPER_LIFETIME',12000,6000]]) {
    assert.equal(membershipGiftChars(sku, 'STANDARD'), standard);
    assert.equal(membershipGiftChars(sku, 'PREMIUM'), premium);
  }
  // Read real account snapshots without claiming gifts or reserving download bytes.
  const users = (await client.query('SELECT user_id FROM membership_accounts LIMIT 3')).rows;
  const cloud = new CloudFileService(work => work(client), {});
  for (const { user_id } of users) {
    const snapshot = await membershipSnapshot(client, user_id);
    const summary = await cloud.summary(user_id);
    assert.equal(summary.downloadBytes, 0);
    assert.equal(summary.downloadQuotaBytes, 1073741824);
    if (snapshot.active) {
      const cycle = membershipCalendarCycle(snapshot.state, snapshot.serverNow);
      assert.deepEqual(snapshot.giftCycle, cycle);
    }
  }
  writeFileSync('../migration-checks.json', JSON.stringify({ identity, before, after, fresh, owners, sampledAccounts: users.length }, null, 2));
  await client.query('COMMIT');
  console.log('PASS: migrations committed; sales unchanged; gift amounts and fresh monthly quota checked');
  console.log('PASS: account snapshot checks:', users.length);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
MIGRATE

for file in "${files[@]}"; do
  install -o "$(stat -c %u "$backup/server/$file")" -g "$(stat -c %g "$backup/server/$file")" \
    -m "$(stat -c %a "$backup/server/$file")" "$stage/server/$file" "$live/$file"
  cmp "$stage/server/$file" "$live/$file"
done
date -u +%FT%TZ > "$stage/ACTIVATION_ATTEMPTED"
activation=1
systemctl start "$service"
"$node" --input-type=module <<'HEALTH'
import assert from 'node:assert/strict';
for (const url of ['http://127.0.0.1:8080/health', 'https://qingye.icynol.com/health']) {
  let ok = false;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok && (await r.json()).ok === true) { ok = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(ok, 'Health check failed: ' + url);
  console.log('PASS health:', url);
}
const r = await fetch('http://127.0.0.1:8080/v1/membership/catalog', { signal: AbortSignal.timeout(5000) });
assert(r.ok, 'Membership catalog HTTP failure');
const body = await r.json();
assert(Array.isArray(body.products) && body.products.length === 4, 'Membership catalog shape mismatch');
console.log('PASS membership catalog HTTP');
HEALTH
pid=$(systemctl show "$service" -p MainPID --value)
restarts=$(systemctl show "$service" -p NRestarts --value)
sleep 5
systemctl is-active --quiet "$service"
test "$pid" -gt 0
test "$(systemctl show "$service" -p MainPID --value)" = "$pid"
test "$(systemctl show "$service" -p NRestarts --value)" = "$restarts"
for file in "${files[@]}"; do cmp "$stage/server/$file" "$live/$file"; done
date -u +%FT%TZ > "$stage/DEPLOYED"
stop_requested=0
echo 'PASS: calendar allowances deployed and verified'
systemctl show "$service" -p ActiveState -p SubState -p MainPID -p NRestarts
echo "BACKUP_DIR=$backup"
echo "LOG=$stage/deploy.log"
