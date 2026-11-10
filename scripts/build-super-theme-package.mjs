import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const ts = require('../server/node_modules/typescript');
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'output/releases/qingye-super-theme-20261022');
assert(!fs.existsSync(out), 'Package directory already exists; inspect it before rebuilding');
fs.mkdirSync(out, { recursive: true });
for (const dir of ['server','source','migrations']) fs.mkdirSync(path.join(out,dir));
const hash = data => createHash('sha256').update(data).digest('hex');
const head = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const compilerOptions = {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,esModuleInterop:true};
const acceptedBaselines = {};
const fixture = path.join(root,'output/super-theme-package-baseline');
fs.mkdirSync(fixture,{recursive:true});
for(const name of ['index','membershipRoutes','themeCatalog','superThemeService']) {
  const source = fs.readFileSync(path.join(root,`server/src/${name}.ts`),'utf8');
  const compiled = fs.readFileSync(path.join(root,`server/dist/${name}.js`));
  assert.equal(ts.transpileModule(source,{compilerOptions}).outputText,compiled.toString(),`Build out of date: ${name}`);
  fs.writeFileSync(path.join(out,`server/${name}.js`),compiled);
  fs.writeFileSync(path.join(out,`source/${name}.ts`),source.replace(/\r\n/g,'\n'));
  const accepted = [hash(compiled)];
  if(name==='superThemeService') accepted.push(null);
  else {
    const previous = execFileSync('git',['show',`${head}:server/src/${name}.ts`],{cwd:root,encoding:'utf8'});
    const baseline = ts.transpileModule(previous,{compilerOptions}).outputText;
    accepted.push(hash(baseline));
    fs.writeFileSync(path.join(fixture,`${name}.js`),baseline);
  }
  acceptedBaselines[`${name}.js`] = accepted;
}
for(const name of ['update.sh','check.mjs','UPDATE.md']) {
  const source=fs.readFileSync(path.join(root,'server/scripts/super-theme-update',name),'utf8');
  fs.writeFileSync(path.join(out,name),source.replace(/\r\n/g,'\n'));
}
fs.copyFileSync(path.join(root,'server/migrations/023_super_exclusive_theme.sql'),path.join(out,'migrations/023_super_exclusive_theme.sql'));
const manifest={name:'qingye-super-theme-20261022',date:'2026-10-22',baseCommit:head,
  feature:'obsidian-archive manual annual SUPER_LIFETIME claim; no point redemption',
  runtimeFiles:Object.keys(acceptedBaselines),migration:'023_super_exclusive_theme.sql',acceptedBaselines,
  validation:{serverTests:92,productionDeployment:false},dependencies:'Uses existing server node_modules and environment; no dependency changes'};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
function entries(dir,prefix='') {
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?entries(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);
}
const list=entries(out).sort();
fs.writeFileSync(path.join(out,'SHA256SUMS'),list.map(file=>hash(fs.readFileSync(path.join(out,file)))+'  '+file).join('\n')+'\n');
execFileSync(process.execPath,[path.join(out,'check.mjs'),'baseline',fixture,out,fixture],{stdio:'inherit'});
execFileSync(process.execPath,[path.join(out,'check.mjs'),'baseline',path.join(out,'server'),out,path.join(out,'server')],{stdio:'inherit'});
// Reject an unrecognized live module rather than silently replacing unrelated production changes.
fs.appendFileSync(path.join(fixture,'index.js'),'\n// unknown version\n');
let refused=false;
try {execFileSync(process.execPath,[path.join(out,'check.mjs'),'baseline',fixture,out,fixture],{stdio:'pipe'});}
catch {refused=true;}
assert(refused,'Unknown baseline must be refused');
console.log('PASS: compiled source consistency, supported old/new baselines, unknown-baseline refusal');
console.log(out);
