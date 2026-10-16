// 从 scripts/lib/linovelib-source.mjs 重新生成本地个人书源 JSON（只有一个文件）。
// 规则改动后必须先通过 `node scripts/linovelib-source-check.mjs`，再运行本脚本。
//
// 输出目录是 docs/book-sources/local/（已被 .gitignore 忽略）：docs/book-sources/README.md 明确
// 说明本仓库不发布指向真实第三方内容站点的书源，所以这个文件只留在本地供导入应用使用。
import fs from 'node:fs';
import path from 'node:path';
import { buildSource } from './lib/linovelib-source.mjs';

const outDir = path.join(process.cwd(), 'docs', 'book-sources', 'local');
fs.mkdirSync(outDir, { recursive: true });

const sources = buildSource();
if (sources.length !== 1) throw new Error(`书源必须是单文件单源，实际 ${sources.length} 个`);

const target = path.join(outDir, 'bilinovel.json');
fs.writeFileSync(target, JSON.stringify(sources, null, 2) + '\n', 'utf8');
console.log('wrote', path.relative(process.cwd(), target));
