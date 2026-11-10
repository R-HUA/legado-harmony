import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../server/package.json', import.meta.url))('sharp');
import { readdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('output/membership-icons');
const sets = ['A · 轻页书叶', 'B · 克制宝石', 'C · 星轨羽翼'];
const tiers = ['月度会员 · 60 点', '年度会员 · 480 点', '终身会员 · 1290 点', '终身超级会员 · 2490 点'];
const layers = [];
const width = 1560;
const height = 1340;
let labels = `<rect width="${width}" height="${height}" fill="#f4f3ef"/>
<text x="50" y="60" font-size="34" fill="#202c28" font-weight="700">轻页会员 · 12 枚图标候选</text>
<text x="50" y="94" font-size="17" fill="#65736e">每行一套风格，每列一个档位。图标下方展示 24 / 32 / 48 px 缩略效果。</text>`;
for (let col = 0; col < 4; col++) {
  labels += `<text x="${235 + col * 365}" y="143" text-anchor="middle" font-size="18" fill="#3c4b45">${tiers[col]}</text>`;
}
const html = ['<!doctype html><meta charset="utf-8"><title>轻页会员图标候选</title><style>body{font-family:system-ui,"Microsoft YaHei";background:#f4f3ef;color:#24332c;margin:32px}h1{font-size:28px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}article{background:white;border-radius:24px;padding:20px;text-align:center}img{width:100%;aspect-ratio:1;object-fit:contain}.sizes img{width:auto;aspect-ratio:1;margin:8px}small{color:#65736e}</style><h1>轻页会员 · 三套四档候选</h1><p>图标为即梦生成的设计候选。选定后再制作正式透明资源。</p>'];
for (let row = 0; row < 3; row++) {
  const top = 176 + row * 380;
  labels += `<text x="50" y="${top + 25}" font-size="22" font-weight="700" fill="#24332c">${sets[row]}</text>`;
  html.push(`<h2>${sets[row]}</h2><div class="grid">`);
  for (let col = 0; col < 4; col++) {
    const key = `${'ABC'[row]}${col + 1}`;
    const file = (await readdir(resolve(root, key))).find(name => name.endsWith('.png'));
    if (!file) throw new Error(`Missing ${key}`);
    const path = resolve(root, key, file);
    const left = 70 + col * 365;
    labels += `<rect x="${left}" y="${top + 45}" width="330" height="300" rx="22" fill="white"/>
      <text x="${left + 20}" y="${top + 75}" font-size="18" fill="#51615a">${key}</text>`;
    layers.push({ input: await sharp(path).resize(236, 236).png().toBuffer(), left: left + 47, top: top + 65 });
    for (const [i, size] of [24, 32, 48].entries()) {
      layers.push({ input: await sharp(path).resize(size, size).png().toBuffer(), left: left + 85 + i * 60, top: top + 298 });
    }
    const relative = `${key}/${file}`;
    html.push(`<article><strong>${key} · ${tiers[col]}</strong><img src="${relative}"><div class="sizes">${[24,32,48].map(s=>`<img src="${relative}" style="height:${s}px">`).join('')}</div></article>`);
    // Validation also records real dimensions of each generated image.
    const metadata = await sharp(await readFile(path)).metadata();
    console.log(JSON.stringify({ key, width: metadata.width, height: metadata.height, format: metadata.format }));
  }
  html.push('</div>');
}
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Microsoft YaHei, sans-serif">${labels}</svg>`);
await sharp(svg).composite(layers).png().toFile(resolve(root, 'comparison.png'));
await writeFile(resolve(root, 'index.html'), html.join('\n'));
