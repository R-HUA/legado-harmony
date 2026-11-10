// Design review, not a device screenshot. Styles and comment paths come from production code.
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {loadObsidianReader} from './lib/obsidian-reader-fixture.mjs';
const require=createRequire(import.meta.url);
const sharp=require('../server/node_modules/sharp');
const init=require('../output/obsidian-vector-tools/node_modules/pathkit-wasm/bin/pathkit.js');
const pk=await init({wasmBinary:fs.readFileSync('output/obsidian-vector-tools/node_modules/pathkit-wasm/bin/pathkit.wasm')});
const {ThemeRuntime:runtime,ReaderHarness,ReaderCommentBubblePainter:painter,Canvas,store}=loadObsidianReader(pk);
const reader=new ReaderHarness();runtime.applyTheme('obsidian-archive');
const hex=n=>'#'+(n>>>0).toString(16).padStart(8,'0').slice(2);
const rgba=c=>c?`rgba(${c.red},${c.green},${c.blue},${c.alpha/255})`:'none';
const text=(x,y,s,size,color,extra='')=>`<text x="${x}" y="${y}" font-family="Microsoft YaHei" font-size="${size}" fill="${color}" ${extra}>${s}</text>`;
const cap=fs.readFileSync('entry/src/main/resources/base/media/regex_cap_gilded_orbit.svg').toString('base64');
function comment(x,y,label,font,style) {
  const h=painter.heightFor(font),w=Math.max(h,[...label].reduce((n,c)=>n+(/[\u4e00-\u9fff]/.test(c)?font:font*.59),0)+font*.84);
  const c=new Canvas();painter.paint(c,x,y,x+w,y+h,style,true);
  return c.commands.map(p=>`<path d="${p.d}" fill="${rgba(p.fill)}" stroke="${rgba(p.stroke)}" stroke-width="${p.width||0}" stroke-linejoin="round" stroke-linecap="round"/>`).join('')+
    text(x+w/2,y+h/2,label,font,hex(style.text),'text-anchor="middle" dominant-baseline="central"');
}
function emphasis(x,y,label,s) {
  const size=s.decorationSizePx,h=32,w=label.length*21+size*2+10;
  const [a,b,c,d]=[s.radiusTopLeftPx,s.radiusTopRightPx,s.radiusBottomRightPx,s.radiusBottomLeftPx];
  return `<path d="M${x+a} ${y}H${x+w-b}Q${x+w} ${y} ${x+w} ${y+b}V${y+h-c}Q${x+w} ${y+h} ${x+w-c} ${y+h}H${x+d}Q${x} ${y+h} ${x} ${y+h-d}V${y+a}Q${x} ${y} ${x+a} ${y}Z" fill="${hex(s.backgroundColor)}"/>`+
    `<image href="data:image/svg+xml;base64,${cap}" x="${x+3}" y="${y+(h-size)/2}" width="${size}" height="${size}"/>`+
    `<g transform="translate(${x+w-3} ${y+(h+size)/2}) rotate(180)"><image href="data:image/svg+xml;base64,${cap}" width="${size}" height="${size}"/></g>`+
    text(x+size+5,y+23,label,21,hex(s.color));
}
let body='<rect width="1240" height="880" fill="#111315"/>'+text(40,60,'曜金藏书 · 阅读气泡',30,'#E8D5AD')+
  text(40,94,'强调藏签 / 段评书签 / 本章说',15,'#ABA18E');
for(const [i,dark] of [false,true].entries()) {
  reader.appDarkMode=dark;store.set('appDarkMode',dark);
  const v=runtime.currentPack()[dark?'dark':'light'],s=reader.buildReaderV2RegexStyleTemplate({}),cs=reader.readerCommentBubbleStyle();
  const x=40+i*600,fg=v.reader.textColor,muted=dark?'#B6AA94':'#867760';
  body+=`<rect x="${x}" y="126" width="560" height="674" rx="22" fill="${v.reader.backgroundColor}"/>`+
    text(x+30,171,dark?'曜黑 · 香槟纸签':'象牙 · 墨金藏签',21,fg)+
    text(x+30,221,'01  对话强调',13,muted)+
    emphasis(x+30,243,'每一页，都值得珍藏。',s)+
    text(x+30,317,'让心动的句子，在书页之间停留。',23,fg)+
    `<path d="M${x+30} 351H${x+530}" stroke="${muted}" opacity=".22"/>`+
    text(x+30,391,'02  段评 · 折角与书签尾',13,muted)+
    text(x+30,442,'读到这里，恰好与你共鸣。',23,fg)+comment(x+344,418,'128',17,cs)+
    comment(x+40,492,'1',17,cs)+comment(x+112,492,'28',17,cs)+comment(x+200,492,'999+',17,cs)+
    `<path d="M${x+30} 555H${x+530}" stroke="${muted}" opacity=".22"/>`+
    text(x+30,596,'03  本章说 · 章末藏书签',13,muted)+
    text(x+280,646,'这一章的故事，留给我们慢慢说。',21,fg,'text-anchor="middle"')+
    comment(x+234,682,'本章说',23,cs)+
    text(x+280,768,'细金边 · 非对称折角 · 右上角金箔书签',13,muted,'text-anchor="middle"');
}
body+=text(40,844,'从主题应用、阅读页样式与原生气泡绘制代码生成；文字排版为设计预览，真机以安装后显示为准。',13,'#ABA18E');
const out='output/obsidian-archive-v2/reader-bubbles-preview.png';
fs.mkdirSync('output/obsidian-archive-v2',{recursive:true});
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="880">${body}</svg>`)).png().toFile(out);
console.log(out);
