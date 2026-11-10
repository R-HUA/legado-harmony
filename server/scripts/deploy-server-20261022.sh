#!/usr/bin/env bash
# Deploy the 2026-10-22 server changes. No database migrations.
#   - Monthly membership no longer includes the monthly reading gift (tier follows the covering order)
#   - Permanent super members may sync single book sources up to 960 KiB
#   - Retention cleanup drains every expired row; sync receipts kept 3 days; revoked devices purged
#   - TTS queue priority respects refund debt; deleting a cloud file frees its space in one request
# Upload qingye-server-20261022.zip and this script to /root, then: bash /root/deploy-server-20261022.sh
set -euo pipefail
test "$(id -u)" -eq 0
live=/www/wwwroot/qingye.icynol.com
node=/www/server/nodejs/v22.23.1/bin/node
service=legado-account.service
env_file=/etc/legado-account.env
archive=/root/qingye-server-20261022.zip
files=(cloudFileService.js config.js index.js maintenance.js membershipPolicy.js membershipService.js sync.js)

printf '%s  %s\n' '7BEDF0DA2014D18B678DD02BEB4BB27C1DAB9CD358EEEF63C6299A01A421C1FE' "$archive" | sha256sum -c -
test -x "$node"
systemctl is-active --quiet "$service"
test -f "$env_file" && test ! -L "$env_file"
for file in "${files[@]}"; do test -f "$live/$file" && test ! -L "$live/$file"; done

# 1. Build a candidate from every live module plus the new ones, and prove that all imports still
#    link before anything live is touched.
candidate=$(mktemp -d /tmp/qingye-deploy-20261022.XXXXXX)
chmod 755 "$candidate"
cp -p "$live"/*.js "$candidate"/
unzip -oq "$archive" -d "$candidate"
(cd "$candidate" && sha256sum -c SHA256SUMS)
ln -s "$live/node_modules" "$candidate/node_modules"
cp "$live/package.json" "$candidate/package.json"
if [ -e "$live/migrations" ]; then ln -s "$live/migrations" "$candidate/migrations"; fi
for file in "${files[@]}"; do "$node" --check "$candidate/$file"; done
systemd-run --quiet --wait --pipe -p EnvironmentFile="$env_file" -p WorkingDirectory="$candidate" \
  "$node" --input-type=module -e '
import { readdirSync, readFileSync } from "node:fs";
const modules = readdirSync(".").filter(n => n.endsWith(".js") && n !== "index.js" && !n.endsWith(".test.js"));
for (const name of modules) await import("./" + name);
const source = readFileSync("index.js", "utf8");
const pattern = /import\s*\{([^}]*)\}\s*from\s*[\x22\x27](\.\/[^\x22\x27]+)[\x22\x27]/g;
let match, checked = 0;
while ((match = pattern.exec(source))) {
  const target = await import(match[2]);
  for (const part of match[1].split(",")) {
    const name = part.trim().split(/\s+as\s+/)[0].trim();
    if (!name) continue;
    if (!(name in target)) throw new Error("index.js needs " + name + " from " + match[2]);
    checked++;
  }
}
const { config } = await import("./config.js");
console.log("PASS " + modules.length + " modules link; index.js imports checked: " + checked +
  "; receipt retention days: " + config.sync.receiptRetentionDays);
process.exit(0);'

# 2. Back up what will change.
backup=$(mktemp -d /root/qingye-deploy-20261022-backup.XXXXXX)
echo "Backup directory: $backup"
cp -p "$env_file" "$backup/environment.before"
for file in "${files[@]}"; do cp -p "$live/$file" "$backup/$file"; done

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
const catalog = await fetch('http://127.0.0.1:8080/v1/membership/catalog');
const body = await catalog.json();
if (!catalog.ok || !Array.isArray(body.products) || body.products.length !== 4) {
  throw new Error('Membership catalog check failed');
}
console.log('PASS membership catalog responds');
NODE
}

changed=0
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$changed" -eq 1 ]; then
    echo "Deploy failed; restoring files and configuration from $backup" >&2
    for file in "${files[@]}"; do cp -p "$backup/$file" "$live/$file"; done
    cp -p "$backup/environment.before" "$env_file"
    if systemctl restart "$service" && health; then echo 'PASS previous version restored' >&2;
    else echo "Rollback needs attention: $backup" >&2; fi
  fi
  exit "$result"
}
trap finish EXIT
changed=1

# 3. Receipts only make retried uploads idempotent; keep 3 days. Only an explicit other value is rewritten.
if grep -Eq '^\s*SYNC_RECEIPT_RETENTION_DAYS\s*=' "$env_file"; then
  sed -i -E 's/^\s*SYNC_RECEIPT_RETENTION_DAYS\s*=.*/SYNC_RECEIPT_RETENTION_DAYS=3/' "$env_file"
  echo 'Set SYNC_RECEIPT_RETENTION_DAYS=3'
else
  echo 'SYNC_RECEIPT_RETENTION_DAYS not set; the new default is 3'
fi

# 4. Install and restart.
for file in "${files[@]}"; do
  install -o "$(stat -c %U "$backup/$file")" -g "$(stat -c %G "$backup/$file")" \
    -m "$(stat -c %a "$backup/$file")" "$candidate/$file" "$live/$file"
done
systemctl restart "$service"
health
pid=$(systemctl show "$service" -p MainPID --value)
restarts=$(systemctl show "$service" -p NRestarts --value)
sleep 5
systemctl is-active --quiet "$service"
test "$pid" -gt 0
test "$(systemctl show "$service" -p MainPID --value)" = "$pid"
test "$(systemctl show "$service" -p NRestarts --value)" = "$restarts"
(cd "$live" && sha256sum -c "$candidate/SHA256SUMS")
changed=0
rm -rf -- "$candidate"
echo 'PASS server 2026-10-22 deployed. No database changes.'
systemctl show "$service" --no-pager -p MainPID -p NRestarts -p ActiveState -p SubState
journalctl -u "$service" --since '-2 min' --no-pager | grep -E 'deleted expired|cleanup failed|error' | tail -5 || true
