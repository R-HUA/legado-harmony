#!/usr/bin/env bash
# Install an account-scoped, 24-hour MONTHLY purchase pilot. No membership or wallet writes.
set -euo pipefail
test "$(id -u)" -eq 0
live=/www/wwwroot/qingye.icynol.com
node=/www/server/nodejs/v22.23.1/bin/node
service=legado-account.service
env_file=/etc/legado-account.env
archive=/root/membership-pilot-20261021.zip
printf '%s  %s\n' '443584288DFA8C359CF159A16D0354CEF44002DD06B14684E60C8C675570B934' "$archive" | sha256sum -c -
systemctl is-active --quiet "$service"
test -f "$env_file" && test ! -L "$env_file"
test "$(runuser -u postgres -- /www/server/pgsql/bin/psql -X -w -h /tmp -d legado_commerce -At \
  -v ON_ERROR_STOP=1 -c 'SELECT count(*)=4 AND NOT bool_or(sales_enabled) FROM membership_products')" = t

candidate=$(mktemp -d /tmp/qingye-membership-pilot.XXXXXX)
chmod 755 "$candidate"
unzip -q "$archive" -d "$candidate"
ln -s "$live/node_modules" "$candidate/node_modules"
ln -s "$live/migrations" "$candidate/migrations"
cp "$live/package.json" "$candidate/package.json"
cp "$live/membershipPolicy.js" "$candidate/membershipPolicy.js"
(
  cd "$candidate"
  sha256sum -c SHA256SUMS
  runuser -u postgres -- "$node" --input-type=module < scripts/membership-pg-concurrency.mjs
)

backup=$(mktemp -d /root/qingye-membership-pilot-backup.XXXXXX)
echo "Backup directory: $backup"
cp -p "$env_file" "$backup/environment.before"
files=(config.js index.js membershipRoutes.js membershipService.js membershipSales.js)
for file in "${files[@]}"; do
  test ! -L "$live/$file"
  if [ -f "$live/$file" ]; then cp -p "$live/$file" "$backup/$file"; fi
  "$node" --check "$candidate/$file"
done

health() {
  "$node" --input-type=module <<'NODE'
for (const url of ['http://127.0.0.1:8080/health', 'https://qingye.icynol.com/health']) {
  let ok = false;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok && (await r.json()).ok === true) { ok = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ok) throw new Error('Health check failed: ' + url);
  console.log('PASS health:', url);
}
NODE
}
changed=0
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$changed" -eq 1 ]; then
    echo "Pilot update failed; restoring files and configuration from $backup" >&2
    systemctl stop "$service" || true
    for file in "${files[@]}"; do
      if [ -f "$backup/$file" ]; then cp -p "$backup/$file" "$live/$file";
      else rm -f -- "$live/$file"; fi
    done
    cp -p "$backup/environment.before" "$env_file"
    if systemctl start "$service" && health; then echo 'PASS previous service restored';
    else echo "Rollback needs attention: $backup" >&2; fi
  fi
  exit "$result"
}
trap finish EXIT
changed=1
# Rewrite only the three pilot keys. No source-limit, payment or OBS configuration changes.
"$node" --input-type=module - "$env_file" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
const until = new Date(Date.now() + 24 * 3600000).toISOString();
let text = readFileSync(file, 'utf8');
text = text.replace(/^\s*MEMBERSHIP_PILOT_(?:USER_IDS|SKUS|UNTIL)\s*=.*(?:\r?\n|$)/gm, '');
writeFileSync(file, text.trimEnd() + '\nMEMBERSHIP_PILOT_USER_IDS=d105489a-3d17-4f18-af36-7a15e5e1b3ae\nMEMBERSHIP_PILOT_SKUS=MONTHLY\nMEMBERSHIP_PILOT_UNTIL=' + until + '\n');
console.log('Pilot expires (UTC):', until);
NODE
systemd-run --quiet --wait --pipe -p EnvironmentFile="$env_file" \
  -p WorkingDirectory="$candidate" "$node" --input-type=module -e '
const {config} = await import("./config.js");
if (!config.membershipEnabled || config.membershipSourceLimitsEnabled ||
    !config.membershipSalesPilot?.userIds.has("d105489a-3d17-4f18-af36-7a15e5e1b3ae") ||
    config.membershipSalesPilot.skus.size !== 1 || !config.membershipSalesPilot.skus.has("MONTHLY")) {
  throw new Error("Pilot configuration check failed");
}
console.log("PASS pilot configuration; source limits remain disabled");'

systemctl stop "$service"
for file in "${files[@]}"; do install -o www -g www -m 644 "$candidate/$file" "$live/$file"; done
systemctl start "$service"
health
"$node" --input-type=module <<'NODE'
const r = await fetch('http://127.0.0.1:8080/v1/membership/catalog');
const catalog = await r.json();
if (!r.ok || catalog.products.length !== 4 || catalog.products.some(p => p.salesEnabled)) {
  throw new Error('Public sales must remain closed');
}
const privateCatalog = await fetch('http://127.0.0.1:8080/v1/membership/catalog/account');
if (privateCatalog.status !== 401) throw new Error('Account catalog must require authentication');
console.log('PASS public sales closed; account catalog requires login');
NODE
pid=$(systemctl show "$service" -p MainPID --value)
restarts=$(systemctl show "$service" -p NRestarts --value)
sleep 3
systemctl is-active --quiet "$service"
test "$pid" -gt 0
test "$(systemctl show "$service" -p MainPID --value)" = "$pid"
test "$(systemctl show "$service" -p NRestarts --value)" = "$restarts"
changed=0
echo 'PASS membership pilot installed. No production database changes. Only icyn/MONTHLY for 24 hours.'
systemctl show "$service" --no-pager -p MainPID -p NRestarts -p ActiveState -p SubState
