#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
stage=$(cd -- "$(dirname -- "$0")" && pwd -P)
live=/www/wwwroot/qingye.icynol.com
node=/www/server/nodejs/v22.23.1/bin/node
service=legado-account.service
exec 9>/root/qingye-cloud-files-deploy.lock
flock -n 9
(cd "$stage" && sha256sum -c SHA256SUMS)
test -x "$node"
test "$(systemctl show "$service" -p WorkingDirectory --value)" = "$live"
systemctl is-active --quiet "$service"
for name in index.js cloudFileService.js; do test -f "$live/$name" && test ! -L "$live/$name"; done
backup=$(mktemp -d /root/qingye-cloud-files-backup.XXXXXX)
mkdir "$backup/candidate"
for name in index.js cloudFileService.js; do cp -p "$live/$name" "$backup/$name"; done
"$node" "$stage/patch-cloud-files-20261022.mjs" "$live" "$backup/candidate"
for name in index.js cloudFileService.js; do "$node" --check "$backup/candidate/$name"; done
echo "Backup: $backup"
health() {
  local attempt
  for attempt in {1..20}; do
    if curl --fail --silent --max-time 3 http://127.0.0.1:8080/health | "$node" -e \
      'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}})'; then
      return 0
    fi
    sleep 1
  done
  return 1
}
switched=0
finish() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ] && [ "$switched" -eq 1 ]; then
    echo 'Deployment failed; restoring backed-up runtime.' >&2
    if systemctl stop "$service"; then
      for name in index.js cloudFileService.js; do cp -p "$backup/$name" "$live/$name"; done
      systemctl start "$service" && health || echo "Recovery needs attention: $backup" >&2
    else
      echo "Unable to stop service for recovery: $backup" >&2
    fi
  fi
  exit "$code"
}
trap finish EXIT
# No migrations, account data, quota adjustments or environment changes.
for name in index.js cloudFileService.js; do cmp "$backup/$name" "$live/$name"; done
systemctl stop "$service"
switched=1
test "$(systemctl show "$service" -p MainPID --value)" = 0
for name in index.js cloudFileService.js; do
  cp -p "$live/$name" "$backup/candidate/$name.permissions"
  cat "$backup/candidate/$name" > "$backup/candidate/$name.permissions"
  cp -p "$backup/candidate/$name.permissions" "$live/$name"
  cmp "$backup/candidate/$name" "$live/$name"
done
systemctl start "$service"
health
systemctl is-active --quiet "$service"
curl --fail --silent --max-time 10 https://qingye.icynol.com/health | "$node" -e \
  'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}})'
echo 'PASS: cloud-file patch deployed; no database or configuration changes'
systemctl show "$service" -p MainPID -p ActiveState -p SubState -p NRestarts
