#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
mode=${1:---check}
case "$mode" in --check|--apply) ;; *) echo 'Usage: bash update.sh [--check|--apply]' >&2; exit 2;; esac
test "$(id -u)" -eq 0
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
live=/www/wwwroot/qingye.icynol.com
node=/www/server/nodejs/v22.23.1/bin/node
service=legado-account.service
env_file=/etc/legado-account.env
pgbin=/www/server/pgsql/bin
files=(index.js membershipRoutes.js themeCatalog.js superThemeService.js)
exec 9>/root/qingye-super-theme-update.lock
flock -n 9
test -x "$node"
test -f "$env_file" && test ! -L "$env_file"
test -d "$live/node_modules"
test "$(systemctl show "$service" -p WorkingDirectory --value)" = "$live"
systemctl is-active --quiet "$service"
(cd "$package_dir" && sha256sum -c SHA256SUMS)
for file in "${files[@]}"; do test ! -L "$live/$file"; done
"$node" "$package_dir/check.mjs" baseline "$live" "$package_dir" "$live"

stage=$(mktemp -d /root/qingye-super-theme-stage.XXXXXX)
mkdir "$stage/runtime"
cp -p "$live"/*.js "$live/package.json" "$stage/runtime/"
ln -s "$live/node_modules" "$stage/runtime/node_modules"
for file in "${files[@]}"; do
  cp "$package_dir/server/$file" "$stage/runtime/$file"
  "$node" --check "$stage/runtime/$file"
done
exec > >(tee -a "$stage/update.log") 2>&1
run_check() {
  systemd-run --quiet --wait --pipe -p EnvironmentFile="$env_file" -p WorkingDirectory="$stage/runtime" \
    "$node" "$package_dir/check.mjs" "$1" "$stage/runtime" "$package_dir" "$live"
}
run_admin() {
  # Root opens the package file; postgres reads stdin and needs no access to /root.
  runuser -u postgres -- "$pgbin/psql" -X -w -h /tmp -d legado_commerce -v ON_ERROR_STOP=1 -P pager=off < "$package_dir/$1"
}
run_check check
run_admin admin-check.sql
echo "STAGE_DIR=$stage"
if [ "$mode" = --check ]; then
  echo 'PASS: preflight only. The running service and database were not changed.'
  exit 0
fi

backup=$(mktemp -d /root/qingye-super-theme-backup.XXXXXX)
mkdir "$backup/server"
echo "BACKUP_DIR=$backup"
cp -p "$env_file" "$backup/environment.before"
systemctl cat "$service" > "$backup/service.before.txt"
for file in "${files[@]}"; do
  if [ -f "$live/$file" ]; then cp -p "$live/$file" "$backup/server/$file";
  else touch "$backup/$file.absent"; fi
done
echo 'Backing up the database...'
runuser -u postgres -- "$pgbin/pg_dump" -w -h /tmp -d legado_commerce -Fc > "$backup/legado_commerce.dump"
test -s "$backup/legado_commerce.dump"
"$pgbin/pg_restore" --list "$backup/legado_commerce.dump" > "$backup/database-contents.txt"
echo 'PASS: database archive directory readable (not a restore rehearsal)'
# Recheck the live baseline in case another update ran while preflight/backup was in progress.
"$node" "$package_dir/check.mjs" baseline "$live" "$package_dir" "$live"
stopped=0
activated=0
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$stopped" -eq 1 ]; then
    echo "UPDATE FAILED. Backup: $backup; log: $stage/update.log" >&2
    if [ "$activated" -eq 0 ]; then
      # The old point endpoint must never see an enabled zero-price exclusive theme.
      if systemctl stop "$service" && [ "$(systemctl show "$service" -p MainPID --value)" = 0 ] && run_admin admin-disable.sql; then
        restored=1
        for file in "${files[@]}"; do
          if [ -f "$backup/$file.absent" ]; then rm -f -- "$live/$file" || restored=0;
          else cp -p "$backup/server/$file" "$live/$file" || restored=0; fi
        done
        if [ "$restored" -eq 1 ] && systemctl start "$service"; then
          echo 'Old files restored and start requested; additive schema/grants retained. Inspect service status before retrying.' >&2
        else echo 'Recovery incomplete; service needs inspection before retrying.' >&2; fi
      else echo 'Recovery needs inspection; service left stopped.' >&2; fi
    else
      systemctl stop "$service" || true
      echo 'Activation was attempted. Service stopped; do not restore the database dump automatically.' >&2
    fi
    systemctl show "$service" -p ActiveState -p SubState -p MainPID || true
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stopped=1
systemctl stop "$service"
test "$(systemctl show "$service" -p MainPID --value)" = 0
run_admin admin-migrate.sql
run_check verify
for file in "${files[@]}"; do
  reference="$backup/server/$file"
  if [ ! -f "$reference" ]; then reference="$backup/server/index.js"; fi
  install -o "$(stat -c %U "$reference")" -g "$(stat -c %G "$reference")" -m "$(stat -c %a "$reference")" \
    "$stage/runtime/$file" "$live/$file"
  cmp "$stage/runtime/$file" "$live/$file"
done
activated=1
systemctl start "$service"
run_check health
pid=$(systemctl show "$service" -p MainPID --value)
restarts=$(systemctl show "$service" -p NRestarts --value)
sleep 5
test "$pid" -gt 0
systemctl is-active --quiet "$service"
test "$(systemctl show "$service" -p MainPID --value)" = "$pid"
test "$(systemctl show "$service" -p NRestarts --value)" = "$restarts"
stopped=0
echo 'PASS: exclusive theme deployed and verified. No theme was claimed by this script.'
echo "BACKUP_DIR=$backup"
echo "LOG=$stage/update.log"
systemctl show "$service" -p ActiveState -p SubState -p MainPID -p NRestarts
