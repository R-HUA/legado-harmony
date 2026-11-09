// Resize approved transparent cutouts; preserve genuine alpha.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const sharp = createRequire(new URL('../server/package.json', import.meta.url))('sharp');
for (const name of ['monthly', 'annual', 'lifetime', 'super_lifetime']) {
  const input = resolve('output/membership-icons/approved', `${name}.png`);
  if (!(await sharp(input).metadata()).hasAlpha) throw new Error(`${name} requires alpha`);
  await sharp(input).resize(256, 256, { fit: 'contain', background: '#00000000' })
    .png().toFile(resolve('entry/src/main/resources/base/media', `membership_${name}.png`));
}
console.log('Prepared four approved transparent membership icons.');
