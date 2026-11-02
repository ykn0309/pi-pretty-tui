// Exercise the whole extension's shutdown path, not only selection hooks.
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {initTheme,UserMessageComponent,AssistantMessageComponent,ToolExecutionComponent,CustomEditor} from '@earendil-works/pi-coding-agent';
import {TuiAltScreen,ProcessTerminal} from '@earendil-works/pi-tui';
assert.ok(global.gc,'Run with --expose-gc');
const dir=mkdtempSync(join(tmpdir(),'selection-reload-gc-'));process.env.PI_CODING_AGENT_DIR=dir;
writeFileSync(join(dir,'pretty-tui.json'),JSON.stringify({mode:'full'}));initTheme('dark',false);
const extension=await createJiti(import.meta.url).import(join(process.cwd(),'extensions/index.ts'),{default:true});
const originalCopy=TuiAltScreen.prototype.getActiveSelectionText,originalWrite=ProcessTerminal.prototype.write;
const gc=async()=>{for(let i=0;i<3;i++){await turn();global.gc()}await turn()};
async function cycle(index){
 const events=new Map(),commands=new Map(),resolvers=[];
 extension({on(name,fn){const a=events.get(name)??[];a.push(fn);events.set(name,a)},getAllTools(){return []},
  registerToolRenderer(fn){resolvers.push(fn)},registerCommand(name,command){commands.set(name,command)},registerEntryRenderer(){},appendEntry(){}});
 const ui={terminal:{columns:100,rows:30},requestRender(){}};
 const editor=new CustomEditor(ui,{borderColor:s=>s});editor.setText('temporary │ composer');editor.render(100);
 for(const fn of events.get('session_start')??[])await fn({}, {sessionManager:{buildContextEntries:()=>[],getBranch:()=>[]},ui:{getToolsExpanded:()=>false,notify(){},setWidget(){}}});
 const refs=[new WeakRef(editor),new WeakRef(ui)];
 const resolve=(name,i=0)=>i<resolvers.length?resolvers[i](name,()=>resolve(name,i+1)):undefined;
 for(let i=0;i<30;i++){
  const user=new UserMessageComponent(`user ${index}/${i} │ literal`);
  const assistant=new AssistantMessageComponent({role:'assistant',timestamp:index*100+i,content:[{type:'text',text:'```ts\nconst value = "│";\n```'}]});
  const tool=new ToolExecutionComponent('bash',`gc-${index}-${i}`,{command:'printf "│"'},undefined,resolve('bash'),ui,process.cwd());
  tool.updateResult({content:[{type:'text',text:'│ output '+i}],isError:false,durationMs:1});
  user.render(100);assistant.render(100);tool.render(100);
  refs.push(new WeakRef(user),new WeakRef(assistant),new WeakRef(tool));
 }
 for(const fn of events.get('session_shutdown')??[])await fn();
 assert.equal(TuiAltScreen.prototype.getActiveSelectionText,originalCopy);
 assert.equal(ProcessTerminal.prototype.write,originalWrite);
 return refs;
}
try{
 for(let i=0;i<3;i++){await cycle(i);await gc()}
 const baseline=process.memoryUsage().heapUsed;
 const samples=[],all=[];
 for(let i=0;i<30;i++){
  const refs=await cycle(i+10);all.push(...refs);await gc();
  // A chain of native/plugin WeakMap entries can need more than one major
  // collection. Yield between deref checks so WeakRef keep-alive jobs end.
  let alive=0;
  for(let retry=0;retry<5;retry++){
    await gc();alive=refs.filter(ref=>ref.deref()!==undefined).length;
    if(!alive)break;
  }
  assert.equal(alive,0,`whole-extension reload ${i}: components retained after repeated GC`);
  samples.push(process.memoryUsage().heapUsed);
 }
 await gc();assert.equal(all.filter(ref=>ref.deref()!==undefined).length,0);
 const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
 const growth=median(samples.slice(-5))-median(samples.slice(0,5));
 assert.ok(growth<4*1024*1024,`reload heap keeps growing: ${growth}`);
 console.log(JSON.stringify({cycles:30,weaklyObservedObjects:all.length,survivors:0,baselineHeap:baseline,
  endHeap:process.memoryUsage().heapUsed,firstFiveMedian:median(samples.slice(0,5)),lastFiveMedian:median(samples.slice(-5)),growthBytes:growth,samples},null,2));
}finally{rmSync(dir,{recursive:true,force:true})}
