#!/usr/bin/env bash
# Deploy the verified shared-storage patch only; no database or configuration edits.
set -euo pipefail
test "$(id -u)" -eq 0
live=/www/wwwroot/qingye.icynol.com
archive=/root/shared-storage-fix-20261021.zip
node=/www/server/nodejs/v22.23.1/bin/node
service=legado-account.service
test -f "$live/sync.js"
test ! -L "$live/sync.js"
test -x "$node"
systemctl is-active --quiet "$service"
printf '%s  %s\n' \
  '7D84358CFCAA6FBC570DCF12C8E7447E717C0FCC8C0972781CE6BBFA439B64AF' \
  "$archive" | sha256sum -c -

backup=$(mktemp -d /root/qingye-shared-quota-backup.XXXXXX)
cp -p "$live/sync.js" "$backup/sync.js.before"
unzip -p "$archive" sync.js > "$backup/sync.js.new"
printf '%s  %s\n' \
  'B2D0DAB6519AD2324CC934A934A0EF7C209B94E12D0DEBAC968B4C28323C16C9' \
  "$backup/sync.js.new" | sha256sum -c -
echo "Backup directory: $backup"

health() {
  "$node" --input-type=module <<'NODE'
const urls = ['http://127.0.0.1:8080/health', 'https://qingye.icynol.com/health'];
for (const url of urls) {
  let ok = false;
  for (let i = 0; i < 15; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok && (await response.json()).ok === true) { ok = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ok) { console.error('FAIL health:', url); process.exit(1); }
  console.log('PASS health:', url);
}
NODE
}

replacement=''
switched=0
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$switched" -eq 1 ]; then
    echo 'Update failed; restoring previous sync.js.' >&2
    rollback=$(mktemp "$live/.sync-rollback.XXXXXX.js")
    if cp -p "$backup/sync.js.before" "$rollback" && mv -f "$rollback" "$live/sync.js" \
      && systemctl restart "$service" && health; then
      echo 'Previous sync.js restored; health checks passed.' >&2
    else
      echo "Rollback needs attention; backup: $backup/sync.js.before" >&2
    fi
  fi
  if [ -n "$replacement" ] && [ -f "$replacement" ]; then rm -f -- "$replacement"; fi
  exit "$result"
}
trap finish EXIT

# Preserve the installed file's ownership and mode, then replace within the same directory.
replacement=$(mktemp "$live/.sync-patch.XXXXXX.js")
cp -p "$live/sync.js" "$replacement"
cat "$backup/sync.js.new" > "$replacement"
runuser -u www -- "$node" --check "$replacement"
switched=1
mv -f "$replacement" "$live/sync.js"
systemctl restart "$service"
health
pid=$(systemctl show "$service" -p MainPID --value)
restarts=$(systemctl show "$service" -p NRestarts --value)
test "$pid" -gt 0
sleep 3
systemctl is-active --quiet "$service"
test "$(systemctl show "$service" -p MainPID --value)" = "$pid"
test "$(systemctl show "$service" -p NRestarts --value)" = "$restarts"
printf '%s  %s\n' \
  'B2D0DAB6519AD2324CC934A934A0EF7C209B94E12D0DEBAC968B4C28323C16C9' \
  "$live/sync.js" | sha256sum -c -
switched=0
echo 'PASS shared-storage patch installed; database and service configuration unchanged.'
systemctl show "$service" --no-pager -p ActiveState -p SubState -p MainPID -p NRestarts
