#!/usr/bin/env bash
# Avatar-only patch for the confirmed server-deploy-20261022 baseline.
# Upload animated-avatar-server.zip and this script to /root, then run this script.
# No migrations, membership changes or environment changes. Configure the website's
# client_max_body_size to at least 3m before uploading large animations.
set -euo pipefail
test "$(id -u)" -eq 0
live=/www/wwwroot/qingye.icynol.com
node=/www/server/nodejs/v22.23.1/bin/node
service=legado-account.service
env_file=/etc/legado-account.env
archive=/root/animated-avatar-server.zip
files=(index.js membershipPolicy.js imageSecurity.js profileRoutes.js)

test -x "$node"
test -f "$archive"
systemctl is-active --quiet "$service"
test -f "$env_file" && test ! -L "$env_file"
candidate=$(mktemp -d /tmp/qingye-avatar-candidate.XXXXXX)
chmod 755 "$candidate"
cp -p "$live"/*.js "$candidate/"
unzip -oq "$archive" -d "$candidate"
(cd "$candidate" && sha256sum -c SHA256SUMS)
# Refuse to overwrite a newer or unexpected server build.
(cd "$live" && sha256sum -c "$candidate/BASE_SHA256SUMS")
test ! -e "$live/profileRoutes.js"
for file in "${files[@]}"; do test ! -L "$live/$file"; "$node" --check "$candidate/$file"; done
ln -s "$live/node_modules" "$candidate/node_modules"
cp "$live/package.json" "$candidate/package.json"
if [ -e "$live/migrations" ]; then ln -s "$live/migrations" "$candidate/migrations"; fi

# Load against the actual installed dependencies and check index imports without starting the app.
systemd-run --quiet --wait --pipe -p EnvironmentFile="$env_file" -p WorkingDirectory="$candidate" \
  "$node" --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
for (const file of ['membershipPolicy.js', 'imageSecurity.js', 'profileRoutes.js']) await import('./' + file);
const source = readFileSync('index.js', 'utf8');
const pattern = /import\s*\{([^}]*)\}\s*from\s*[\x22\x27](\.\/[^\x22\x27]+)[\x22\x27]/g;
let match;
while ((match = pattern.exec(source))) {
  const target = await import(match[2]);
  for (const item of match[1].split(',')) {
    const name = item.trim().split(/\s+as\s+/)[0].trim();
    if (name && !(name in target)) throw new Error('Missing export: ' + match[2] + ':' + name);
  }
}
const { membershipBenefits } = await import('./membershipPolicy.js');
for (const sku of ['MONTHLY','ANNUAL','LIFETIME','SUPER_LIFETIME']) {
  const state = { sku, anchorAt: 0, expiresAt: sku.endsWith('LIFETIME') ? null : Date.now()+10000 };
  if (membershipBenefits(state, Date.now()).animatedAvatar !== sku.endsWith('LIFETIME')) throw new Error('Invalid benefits');
}
// Prove the production Sharp build can encode and preserve an animation.
const sharp = (await import('sharp')).default;
const { prepareAvatarBase64 } = await import('./imageSecurity.js');
const raw = Buffer.concat([Buffer.alloc(12, 0), Buffer.alloc(12, 255)]);
const gif = await sharp(raw, { raw: { width: 2, height: 4, pageHeight: 2, channels: 3 } })
  .gif({ loop: 0, delay: [70, 130] }).toBuffer();
const result = await prepareAvatarBase64(gif.toString('base64'), true);
const meta = await sharp(result.data).metadata();
if (result.mime !== 'image/gif' || meta.pages !== 2) throw new Error('Animated encoder unavailable');
console.log('PASS imports, entitlement rules and installed GIF encoder');
process.exit(0);
NODE

backup=$(mktemp -d /root/qingye-avatar-backup.XXXXXX)
for file in index.js membershipPolicy.js imageSecurity.js; do cp -p "$live/$file" "$backup/$file"; done
echo "Backup: $backup"
changed=0
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
}
console.log('PASS local and HTTPS health');
NODE
}
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$changed" -eq 1 ]; then
    for file in index.js membershipPolicy.js imageSecurity.js; do cp -p "$backup/$file" "$live/$file"; done
    rm -f -- "$live/profileRoutes.js"
    if systemctl restart "$service" && health; then echo 'Previous server restored' >&2;
    else echo "Rollback requires attention: $backup" >&2; fi
  fi
  exit "$result"
}
trap finish EXIT
changed=1
for file in "${files[@]}"; do
  install -o "$(stat -c %U "$backup/index.js")" -g "$(stat -c %G "$backup/index.js")" \
    -m "$(stat -c %a "$backup/index.js")" "$candidate/$file" "$live/$file"
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
echo 'PASS animated avatars deployed. Refresh the account in the app, then choose the animation again.'
systemctl show "$service" --no-pager -p MainPID -p NRestarts -p ActiveState -p SubState
