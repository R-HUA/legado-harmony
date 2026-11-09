import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const old=path.join(root,'output/releases/qingye-super-theme-20261022-v2');
const name='qingye-super-theme-20261022-v3';
const out=path.join(root,'output/releases',name);
const helper=path.join(root,'server/scripts/super-theme-update');
const read=p=>fs.readFileSync(p,'utf8');
const hash=b=>createHash('sha256').update(b).digest('hex');
assert(!fs.existsSync(out));
fs.cpSync(old,out,{recursive:true});
const manifest=JSON.parse(read(path.join(old,'manifest.json')));
for(const name of ['index','membershipRoutes','themeCatalog']) {
  assert.deepEqual(fs.readFileSync(path.join(old,'server',name+'.js')),fs.readFileSync(path.join(root,'server/dist',name+'.js')),
    `Unexpected unrelated runtime change: ${name}`);
}
fs.copyFileSync(path.join(root,'server/dist/superThemeService.js'),path.join(out,'server/superThemeService.js'));
fs.copyFileSync(path.join(root,'server/src/superThemeService.ts'),path.join(out,'source/superThemeService.ts'));
for(const file of ['update.sh','check.mjs','admin-check.sql','admin-disable.sql']) {
  fs.writeFileSync(path.join(out,file),read(path.join(helper,file)).replace(/\r\n/g,'\n'));
}
const migration=read(path.join(out,'migrations/023_super_exclusive_theme.sql')).trim();
assert(migration.startsWith('BEGIN;')&&migration.endsWith('COMMIT;'));
fs.writeFileSync(path.join(out,'admin-migrate.sql'),read(path.join(helper,'admin-prefix.sql'))+'\n'+
  migration.slice(6,-7)+'\n'+read(path.join(helper,'admin-suffix.sql')));
fs.writeFileSync(path.join(out,'UPDATE.md'),read(path.join(helper,'UPDATE.md')).replaceAll('qingye-super-theme-20261022',name));
fs.appendFileSync(path.join(out,'BASELINE-REVIEW.md'), '\n## v3 权限适配\n\n'+
  '线上确认主题目录属于 postgres，qingye 只有 SELECT。迁移和故障前的目录禁用改由 postgres 执行；现有表所有者和 ACL 不变。'+
  '新领取记录表只授予 qingye SELECT、INSERT。领取服务移除需要 UPDATE 权限的目录 FOR SHARE 查询，仍使用用户事务锁和领取记录行锁保证幂等。\n');
manifest.name=name;
manifest.acceptedBaselines['superThemeService.js'].push(hash(fs.readFileSync(path.join(out,'server/superThemeService.js'))));
manifest.validation.serverTests=94;
manifest.migrationExecution='Local postgres via psql, atomic migration and minimal claim ledger grants; application verifies runtime permissions';
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
function files(dir,prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);}
fs.writeFileSync(path.join(out,'SHA256SUMS'),files(out).filter(f=>f!=='SHA256SUMS').sort().map(f=>hash(fs.readFileSync(path.join(out,f)))+'  '+f).join('\n')+'\n');
const base=path.join(root,'output/super-theme-live-baseline');
execFileSync(process.execPath,[path.join(out,'check.mjs'),'baseline',base,out,base],{stdio:'inherit'});
execFileSync(process.execPath,[path.join(out,'check.mjs'),'baseline',path.join(out,'server'),out,path.join(out,'server')],{stdio:'inherit'});
for(const file of ['check.mjs',...manifest.runtimeFiles.map(n=>'server/'+n)])execFileSync(process.execPath,['--check',path.join(out,file)]);
console.log('PASS: v3 source syntax and exact live/installed baselines; unrelated modules unchanged');
console.log(out);
