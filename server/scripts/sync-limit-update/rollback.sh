#!/usr/bin/env bash
set -Eeuo pipefail
test "$(id -u)" -eq 0
backup=$(realpath -e -- "${1:?Pass the backup directory printed by update.sh}")
case "$backup" in /root/qingye-sync-limit-backup.*) ;; *) echo 'Unexpected backup directory' >&2; exit 1;; esac
live=/www/wwwroot/qingye.icynol.com
node=/www/server/nodejs/v22.23.1/bin/node
service=legado-account.service
exec 9>/root/qingye-sync-limit-update.lock
flock -n 9
test "$(systemctl show "$service" -p WorkingDirectory --value)" = "$live"
test -f "$backup/sync.js" && test ! -L "$backup/sync.js"
test -f "$live/sync.js" && test ! -L "$live/sync.js"
# Refuse to overwrite a newer update made after this package was deployed.
cmp "$backup/candidate.js" "$live/sync.js"
"$node" --input-type=module --check < "$backup/sync.js"
systemctl stop "$service"
cp -p "$backup/sync.js" "$live/sync.js"
systemctl start "$service"
for attempt in {1..20}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:8080/health | "$node" -e \
    'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}})'; then
    systemctl is-active --quiet "$service"
    echo 'PASS: previous sync.js restored'
    exit 0
  fi
  sleep 1
done
echo 'Rollback restored the file but service health needs attention' >&2
exit 1
