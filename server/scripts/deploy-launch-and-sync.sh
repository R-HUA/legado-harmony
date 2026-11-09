#!/usr/bin/env bash
# Completes the 2026-10-22 rollout on top of the calendar-allowance package already installed:
#   1. Launch data from migration 019: products open 2026-11-01 00:00 (UTC+8); permanent and permanent
#      super at half price through 2026-12-25. Production already has the 019/020 tables and columns
#      (from 000_schema_prerequisites.sql), so 019 only fills in data here; this script stops otherwise.
#   2. cloudFileRoutes.js: the removal-marker endpoint and delete reason used by font/book auto-sync.
# Upload qingye-launch-and-sync.zip and this script to /root, then choose explicitly:
#   bash /root/deploy-launch-and-sync.sh close   # close the manual opening; everyone can buy from 2026-11-01 00:00
#   bash /root/deploy-launch-and-sync.sh keep    # keep products that are already open by hand open now
set -euo pipefail
mode=${1:-}
if [ "$mode" != close ] && [ "$mode" != keep ]; then
  echo 'Usage: bash deploy-launch-and-sync.sh close|keep' >&2
  exit 2
fi
test "$(id -u)" -eq 0
live=/www/wwwroot/qingye.icynol.com
node=/www/server/nodejs/v22.23.1/bin/node
service=legado-account.service
archive=/root/qingye-launch-and-sync.zip
psql=(runuser -u postgres -- /www/server/pgsql/bin/psql -X -w -h /tmp -d legado_commerce -v ON_ERROR_STOP=1 -At)

printf '%s  %s\n' '1954AACDE0B4F4DDB18E3DAD81FA63D5D3A62BEC9FAFFF38981179C2C68625A8' "$archive" | sha256sum -c -
test -x "$node"
systemctl is-active --quiet "$service"
test -f "$live/cloudFileRoutes.js" && test ! -L "$live/cloudFileRoutes.js"

stage=$(mktemp -d /tmp/qingye-launch-sync.XXXXXX)
unzip -oq "$archive" -d "$stage"
(cd "$stage" && sha256sum -c SHA256SUMS)
"$node" --check "$stage/cloudFileRoutes.js"

# The installed service must already be the calendar-allowance build that knows about promotions and markers.
grep -q 'membership_promotions' "$live/membershipService.js"
grep -q 'cloud_file_tombstones' "$live/cloudFileService.js"

# Every object 019 would create must already exist, so running it only writes data (no new owners).
test "$("${psql[@]}" -c "SELECT
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='membership_products' AND column_name='sales_starts_at')
  AND to_regclass('public.membership_promotions') IS NOT NULL
  AND to_regclass('public.membership_promotions_window_idx') IS NOT NULL
  AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='membership_orders' AND column_name='promotion_id')")" = t
echo 'Before:'
"${psql[@]}" -c "SELECT sku, sales_enabled, sales_starts_at FROM membership_products ORDER BY sku"
"${psql[@]}" -c "SELECT count(*) || ' promotions' FROM membership_promotions"

backup=$(mktemp -d /root/qingye-launch-sync-backup.XXXXXX)
cp -p "$live/cloudFileRoutes.js" "$backup/cloudFileRoutes.js"
"${psql[@]}" -c "COPY (SELECT sku, sales_enabled, sales_starts_at FROM membership_products ORDER BY sku) TO STDOUT" \
  > "$backup/membership_products.before"
echo "Backup directory: $backup"

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
    echo "Deploy failed; restoring cloudFileRoutes.js from $backup" >&2
    cp -p "$backup/cloudFileRoutes.js" "$live/cloudFileRoutes.js"
    systemctl restart "$service" && health || echo "Rollback needs attention: $backup" >&2
    echo 'Launch data and the previous manual opening (see membership_products.before) are restored with:' >&2
    echo "  UPDATE membership_products SET sales_starts_at=NULL; DELETE FROM membership_promotions WHERE id LIKE 'launch-2026-%';" >&2
    if [ "$mode" = close ]; then echo "  UPDATE membership_products SET sales_enabled=true;" >&2; fi
  fi
  exit "$result"
}
trap finish EXIT
changed=1

# 1. Launch data (idempotent). Fed on stdin: the postgres user cannot read root's private temp directory.
"${psql[@]}" < "$stage/019_membership_launch_schedule.sql" >/dev/null
if [ "$mode" = close ]; then
  # Products opened by hand earlier would otherwise stay on sale before the launch time.
  "${psql[@]}" -c "UPDATE membership_products SET sales_enabled = false" >/dev/null
  echo 'Manual opening closed; sales open by schedule at 2026-11-01 00:00 (UTC+8).'
fi
test "$("${psql[@]}" -c "SELECT bool_and(sales_starts_at = TIMESTAMPTZ '2026-11-01 00:00:00+08') FROM membership_products")" = t
test "$("${psql[@]}" -c "SELECT string_agg(sku || ':' || price_points, ',' ORDER BY sku) FROM membership_promotions
  WHERE id IN ('launch-2026-lifetime','launch-2026-super')")" = 'LIFETIME:645,SUPER_LIFETIME:1245'

# 2. Routes.
install -o "$(stat -c %U "$backup/cloudFileRoutes.js")" -g "$(stat -c %G "$backup/cloudFileRoutes.js")" \
  -m "$(stat -c %a "$backup/cloudFileRoutes.js")" "$stage/cloudFileRoutes.js" "$live/cloudFileRoutes.js"
systemctl restart "$service"
health
LAUNCH_MODE="$mode" "$node" --input-type=module <<'NODE'
const catalog = await (await fetch('http://127.0.0.1:8080/v1/membership/catalog')).json();
const opening = Date.parse('2026-11-01T00:00:00+08:00');
for (const product of catalog.products) {
  if (product.salesStartsAt !== opening) throw new Error('Opening time missing for ' + product.sku);
}
const promo = Object.fromEntries(catalog.products.map(p => [p.sku, p.promotion?.pricePoints ?? null]));
if (promo.LIFETIME !== 645 || promo.SUPER_LIFETIME !== 1245 || promo.MONTHLY !== null || promo.ANNUAL !== null) {
  throw new Error('Promotion check failed: ' + JSON.stringify(promo));
}
const early = Date.now() < opening;
const anyOpen = catalog.products.some(p => p.salesEnabled);
if (early && process.env.LAUNCH_MODE === 'close' && anyOpen) throw new Error('Sales must stay closed before the opening');
console.log('PASS catalog: opens 2026-11-01 00:00 (UTC+8); half price for permanent tiers;',
  anyOpen ? 'on sale now' : 'closed until the opening');
const markers = await fetch('http://127.0.0.1:8080/v1/cloud-files/tombstones');
if (markers.status !== 401) throw new Error('Removal-marker endpoint should require login, got ' + markers.status);
console.log('PASS removal-marker endpoint present (requires login)');
NODE
pid=$(systemctl show "$service" -p MainPID --value)
restarts=$(systemctl show "$service" -p NRestarts --value)
sleep 5
systemctl is-active --quiet "$service"
test "$(systemctl show "$service" -p MainPID --value)" = "$pid"
test "$(systemctl show "$service" -p NRestarts --value)" = "$restarts"
changed=0
rm -rf -- "$stage"
echo 'PASS launch schedule and auto-sync routes deployed.'
systemctl show "$service" --no-pager -p MainPID -p NRestarts -p ActiveState -p SubState
