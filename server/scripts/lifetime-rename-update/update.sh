#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
stage=$(cd -- "$(dirname -- "$0")" && pwd -P)
live=/www/wwwroot/qingye.icynol.com
node=/www/server/nodejs/v22.23.1/bin/node
service=legado-account.service
files=(cloudFileService.js imageSecurity.js membershipPolicy.js membershipService.js superThemeService.js)
exec 9>/root/qingye-lifetime-rename-update.lock
flock -n 9
(cd "$stage" && sha256sum -c SHA256SUMS)
test -x "$node"
test "$(systemctl show "$service" -p WorkingDirectory --value)" = "$live"
systemctl is-active --quiet "$service"
for file in "${files[@]}"; do test -f "$live/$file" && test ! -L "$live/$file"; done
backup=$(mktemp -d /root/qingye-lifetime-rename-backup.XXXXXX)
mkdir "$backup/candidate"
for file in "${files[@]}"; do cp -p "$live/$file" "$backup/$file"; cp -p "$live/$file" "$backup/candidate/$file"; done
"$node" "$stage/patch.mjs" "$backup" "$backup/candidate"
for file in "${files[@]}"; do "$node" --input-type=module --check < "$backup/candidate/$file"; done
"$node" "$stage/check.mjs" "$backup" "$backup/candidate"
pending=()
for file in "${files[@]}"; do cmp -s "$backup/$file" "$backup/candidate/$file" || pending+=("$file"); done
if [ "${#pending[@]}" -eq 0 ]; then
  echo 'Already installed; no restart needed.'
  exit 0
fi
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
changed=0
finish() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ] && [ "$changed" -eq 1 ]; then
    echo "Update failed; restoring files from $backup" >&2
    if systemctl stop "$service"; then
      for file in "${files[@]}"; do cp -p "$backup/$file" "$live/$file"; done
      systemctl start "$service" && health || echo "Recovery needs attention: $backup" >&2
    else
      echo "Unable to stop service for recovery: $backup" >&2
    fi
  fi
  exit "$code"
}
trap finish EXIT
for file in "${files[@]}"; do cmp "$backup/$file" "$live/$file"; done
changed=1
systemctl stop "$service"
test "$(systemctl show "$service" -p MainPID --value)" = 0
for file in "${files[@]}"; do cmp "$backup/$file" "$live/$file"; done
# Write through a copy of the original so ownership and mode stay the same.
for file in "${pending[@]}"; do
  cp -p "$backup/$file" "$backup/install-$file"
  cat "$backup/candidate/$file" > "$backup/install-$file"
  cp -p "$backup/install-$file" "$live/$file"
  cmp "$backup/candidate/$file" "$live/$file"
done
systemctl start "$service"
health
systemctl is-active --quiet "$service"
curl --fail --silent --max-time 10 https://qingye.icynol.com/health | "$node" -e \
  'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}})'
echo 'PASS: lifetime tiers renamed to 终身会员 / 终身超级会员; no database, configuration or other module changes'
echo "Manual rollback: bash $stage/rollback.sh $backup"
systemctl show "$service" -p MainPID -p ActiveState -p SubState -p NRestarts
