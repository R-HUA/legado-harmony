import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Extend the existing vector theme identities into full-bleed launcher assets.
// Keep foreground and background separate so the launcher controls the final mask.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'entry/src/main/resources/base/media');
const output = path.join(root, 'AppScope/resources/base/media');
const backgrounds = {
  strawberry_cream: '#F7CDD0',
  crimson_archive: '#E9E7E1',
  plum_tea: '#E9E8DE',
  rose_letter: '#F2DDD7',
  moon_crane: '#0D1624',
  sword_frost: '#26332F',
  qingluan_water: '#E3E9E6',
  cat_pipi: '#FFF7ED',
  azure_mecha: '#EEF2F6',
  starwish_magic: '#F8F4FC',
  letterpress_page: '#F3EFE6',
  custom: '#EEE9FA'
};
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 64 64">${body}</svg>\n`;
for (const [id, background] of Object.entries(backgrounds)) {
  // Hand-reviewed Dreamina artwork takes precedence over the vector fallback.
  if (fs.existsSync(path.join(output, `ic_app_theme_${id}.png`))) {
    continue;
  }
  const logo = fs.readFileSync(path.join(source, `theme_logo_${id}.svg`), 'utf8');
  let motif = logo.replace(/<svg\b[^>]*>/, '').replace(/<\/svg>/, '').trim();
  // Remove the original small rounded tile; the desktop supplies its own mask.
  motif = motif.replace(/^<rect\b[^>]*\/>/, '');
  // Text inside SVG is not reliably supported by HarmonyOS image decoding.
  motif = motif.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, '');
  if (id === 'sword_frost') {
    motif += '<path d="M16 22h12v17H16zM19 26h6M19 30h6" fill="none" stroke="#F4ECD9" stroke-width="1.8"/>';
  }
  const foreground = `<g transform="translate(5.12 5.12) scale(.84)">${motif}</g>`;
  const base = `ic_app_theme_${id}`;
  fs.writeFileSync(path.join(output, `${base}_background.svg`),
    svg(`<path d="M0 0h64v64H0z" fill="${background}"/>`));
  fs.writeFileSync(path.join(output, `${base}_foreground.svg`), svg(foreground));
  fs.writeFileSync(path.join(output, `${base}.svg`),
    svg(`<path d="M0 0h64v64H0z" fill="${background}"/>${foreground}`));
  fs.writeFileSync(path.join(output, `${base}_layered.json`), JSON.stringify({
    'layered-image': {
      background: `$media:${base}_background`,
      foreground: `$media:${base}_foreground`
    }
  }, null, 2) + '\n');
}
console.log('Generated vector fallback icons; preserved existing PNG theme artwork.');
