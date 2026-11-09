// Match ReaderThemeBackground's proportional corner placement; this is a design review, not a device capture.
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('../server/node_modules/sharp');
const root = 'entry/src/main/resources/base/media/';
const output = 'output/obsidian-archive-v2';
mkdirSync(output, { recursive: true });
const svg = (w,h,body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
const text = (x,y,s,size,color,extra='') => `<text x="${x}" y="${y}" font-family="Microsoft YaHei, sans-serif" font-size="${size}" fill="${color}" ${extra}>${s}</text>`;
const registry = readFileSync('entry/src/main/ets/theme/BuiltinThemeRegistry.ets','utf8');
const tokens = mode => {
  const m=registry.match(new RegExp("reader\\('([^']+)', 'obsidian-archive-"+mode+"', '([^']+)', '([^']+)'"));
  if(!m)throw new Error('Missing reader palette: '+mode);
  return {background:m[1],foreground:m[2],secondary:m[3]};
};
const prose = [
  '风从窗边经过，轻轻翻动书页。',
  '那些尚未抵达的山河，已经在',
  '一行行文字里，露出了轮廓。',
  '',
  '我们把喜欢的句子折进书签，',
  '也把匆忙的日子慢慢放下来。',
  '窗外有叶子落下，屋内有故事',
  '生长。此刻，只需安心读下去。',
  '',
  '书页之间，始终留着一盏灯。'
];
async function reader(mode) {
  const t=tokens(mode),w=400,h=650;
  const size=Math.round(Math.max(112,Math.min(260,Math.min(w,h)*0.36)));
  const inset=Math.max(8,Math.min(22,Math.min(w,h)*0.025));
  const corner=await sharp(root+`reader_decor_obsidian_archive_${mode}.svg`).resize(size,size).png().toBuffer();
  const trailing=await sharp(root+`reader_decor_obsidian_archive_trailing_${mode}.svg`).resize(size,size).png().toBuffer();
  let type=text(28,55,'第一章  把日子读慢一点',17,t.secondary)+text(28,108,'书页之间',27,t.foreground);
  prose.forEach((line,i)=>{type+=text(28,165+i*37,line,21,t.foreground);});
  type+=text(28,620,'曜金藏书',12,t.secondary)+text(365,620,'12 / 86',12,t.secondary,'text-anchor="end"');
  return sharp({create:{width:w,height:h,channels:3,background:t.background}}).composite([
    {input:corner,left:inset,top:inset},
    {input:trailing,left:w-inset-size,top:h-inset-size},
    {input:svg(w,h,type),left:0,top:0}
  ]).png().toBuffer();
}
let body='<rect width="1340" height="990" fill="#111315"/>'+text(40,65,'曜金藏书 · 藏书与阅读',32,'#E8D5AD')+
  text(40,103,'横叠藏书，银杏作签；山河入页，留白给文字。',17,'#AEA492')+
  '<path d="M40 125H1300" stroke="#534632"/>'+
  text(40,162,'书架文件夹',18,'#DED6C8')+text(400,162,'象牙纸 · 浅色阅读',18,'#DED6C8')+text(860,162,'墨纸 · 深色阅读',18,'#DED6C8')+
  text(40,662,'我的珍藏',20,'#E8D5AD')+text(40,691,'共 12 本',14,'#AEA492')+
  text(40,752,'横向书册 / 织带书签',16,'#DED6C8')+text(40,782,'金箔银杏 / 象牙纸页',16,'#DED6C8')+
  text(400,872,'银杏扉页 · 山河页脚',17,'#DED6C8')+text(860,872,'低亮度金线 · 温和墨色',17,'#DED6C8')+
  text(40,944,'实际素材合成预览；角饰按页面短边等比放置，正文中央留白。',14,'#8C8B85');
await sharp({create:{width:1340,height:990,channels:3,background:'#111315'}}).composite([
  {input:svg(1340,990,body),left:0,top:0},
  {input:await sharp(root+'theme_folder_art_obsidian_archive.jpg').resize(300,440).toBuffer(),left:40,top:185},
  {input:await reader('light'),left:400,top:185},
  {input:await reader('dark'),left:860,top:185}
]).png().toFile(output+'/folder-reader-preview.png');
console.log(output+'/folder-reader-preview.png');
