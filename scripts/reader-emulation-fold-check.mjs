import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {execFileSync} from 'node:child_process';

const file='entry/src/main/ets/components/ReaderEmulationFlipPainter.ets';
const source=process.argv.includes('--baseline')?execFileSync('git',['show',`HEAD:${file}`],{encoding:'utf8'}):fs.readFileSync(file,'utf8');
class Path {
  commands=[];
  moveTo(x,y){this.commands.push(['M',x,y]);}
  lineTo(x,y){this.commands.push(['L',x,y]);}
  quadraticCurveTo(x,y,a,b){this.commands.push(['Q',x,y,a,b]);}
  closePath(){this.commands.push(['Z']);}
}
const sandbox=vm.createContext({Path2D:Path});
vm.runInContext(stripTypeScriptTypes(source.replace(/^import.*$/gm,'').replaceAll('export ',''),{mode:'transform'})+
  ';globalThis.Painter=ReaderEmulationFlipPainter',sandbox);
const near=(a,b,message)=>assert.ok(Math.abs(a-b)<1e-6,`${message}: ${a} versus ${b}`);
let samples=0;
for(const [w,h] of [[420,616],[412,915],[960,640]]) {
  for(const region of [0,2]) {
    for(const progress of [.01,.1,.3,.5,.8,.96]) {
      for(const edge of [null,1,6,60,180]) {
        const p=new sandbox.Painter();
        if(edge!==null)p.dragCorner(w*.3,region===0?edge:h-edge);
        const g=p.buildGeometry(w,h,progress,region,true,false);
        assert.ok(g);
        const front=p.pathA(g,w,h),back=p.pathC(g,w,h);
        let previous,curve=0;
        for(const cmd of front.commands) {
          if(cmd[0]==='Q') {
            const mid={x:(previous[0]+2*cmd[1]+cmd[3])/4,y:(previous[1]+2*cmd[2]+cmd[4])/4};
            const expected=curve++===0?g.d:g.i;
            near(mid.x,expected.x,'Front crease midpoint X must meet the back');
            near(mid.y,expected.y,'Front crease midpoint Y must meet the back');
            const dx=cmd[3]-previous[0],dy=cmd[4]-previous[1],lx=g.i.x-g.d.x,ly=g.i.y-g.d.y;
            near((dx*ly-dy*lx)/(Math.hypot(dx,dy)*Math.hypot(lx,ly)),0,'Crease must be tangent');
            previous=[cmd[3],cmd[4]];
          } else if(cmd[0]!=='Z') previous=[cmd[1],cmd[2]];
          assert.ok(cmd.slice(1).every(Number.isFinite));
        }
        near(back.commands[0][1],g.i.x,'Back uses the same crease X');
        near(back.commands[0][2],g.i.y,'Back uses the same crease Y');
        // The visible crease DI must stay close to the reflection axis EH, otherwise the cut page swings far past the flap tips.
        const ehx=g.h.x-g.e.x,ehy=g.h.y-g.e.y,creaseGap=Math.abs(ehx*(g.d.y-g.e.y)-ehy*(g.d.x-g.e.x))/Math.hypot(ehx,ehy);
        assert.ok(creaseGap<=w*.04+1e-6,`Curl band must be capped: ${creaseGap} at ${w}x${h}`);
        samples++;
      }
    }
  }
}
// Capture the real paper-back transform. The original corner must map to the dragged corner in both directions.
function multiply(a,b){return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
for(const mirrored of [false,true]) for(const region of [0,2]) {
  const p=new sandbox.Painter(),w=420,h=616;
  p.dragCorner(mirrored?240:180,region===0?180:h-180);
  const g=p.buildGeometry(w,h,.5,region,true,mirrored);
  p.drawPathCShadow=()=>{};p.strokePaperEdge=()=>{};
  let matrix=mirrored?[-1,0,0,1,w,0]:[1,0,0,1,0,0],drawn;const stack=[];
  const ctx={save(){stack.push([...matrix]);},restore(){matrix=stack.pop();},fill(){},clip(){},
    transform(...m){matrix=multiply(matrix,m);},translate(x,y){this.transform(1,0,0,1,x,y);},scale(x,y){this.transform(x,0,0,y,0,0);},
    drawImage(){drawn=[...matrix];}};
  p.drawPathC(ctx,{},g,w,h,mirrored);
  const sourceX=mirrored?0:w,sourceY=region===0?0:h;
  near(drawn[0]*sourceX+drawn[2]*sourceY+drawn[4],mirrored?w-g.a.x:g.a.x,'Paper back corner X');
  near(drawn[1]*sourceX+drawn[3]*sourceY+drawn[5],g.a.y,'Paper back corner Y');
}
console.log(`PASS: ${samples} top/bottom crease joins, near-edge drags, aspect ratios and forward/back texture registration.`);
