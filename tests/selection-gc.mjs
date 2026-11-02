// Explicit-GC lifecycle stress. Each mode runs in a fresh process; WeakRefs
// check object reachability independently of noisy heap/RSS accounting.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setImmediate as turn} from 'node:timers/promises';
import {createJiti} from 'jiti';
import {join} from 'node:path';
import {TuiAltScreen,VStack,ProcessTerminal} from '@earendil-works/pi-tui';
if(!process.argv.includes('--child')){
 const results=[];
 for(const mode of ['native','prototype']){
  const runs=[];
  for(let sample=0;sample<3;sample++)runs.push(JSON.parse(execFileSync(process.execPath,
   ['--expose-gc',process.argv[1],'--child',mode],{encoding:'utf8',maxBuffer:2e6})));
  results.push({mode,runs});
 }
 console.log(JSON.stringify({node:process.version,results,note:'Forced-GC reachability and bounded-growth checks, not proof for every extension or a days-long session. RSS is reported but not used as a leak assertion.'},null,2));
}else{
 if(!global.gc)throw Error('Run with --expose-gc');
 const active=process.argv.at(-1)==='prototype';
 const jiti=createJiti(import.meta.url);
 const {frameNativeRows}=await jiti.import(join(process.cwd(),'extensions/full-frame.ts'));
 const {installSelectionCopy}=await jiti.import(join(process.cwd(),'extensions/selection-ranges.ts'));
 const theme={fg:(_r,s)=>s,bg:(_r,s)=>s,bold:s=>s};
 const originalCopy=TuiAltScreen.prototype.getActiveSelectionText;
 const originalWrite=ProcessTerminal.prototype.write;
 const originalOverlays=TuiAltScreen.prototype.compositeOverlays;
 const originalFlashes=TuiAltScreen.prototype.compositeFlashes;
 const cleanup=active?installSelectionCopy():()=>{};
 const gc=async()=>{for(let i=0;i<3;i++){await turn();global.gc()}await turn()};
 const memory=()=>{const {heapUsed,rss,external,arrayBuffers}=process.memoryUsage();return {heapUsed,rss,external,arrayBuffers}};
 let serial=0;
 const buildCards=(count=300)=>Array.from({length:count},(_,card)=>{
  const owner={};const body=Array.from({length:20},(_,row)=>`  const c${card}_v${row} = "│ real 中文 ${++serial}";`);
  return {owner,body,frame:frameNativeRows('Tool '+card,body,100,theme,undefined,owner)};
 });
 const buildWeak=()=>{
  const cards=buildCards();
  const refs=cards.flatMap(card=>[new WeakRef(card.owner),new WeakRef(card.frame)]);
  return {cards,refs};
 };
 const alive=refs=>refs.reduce((count,ref)=>count+(ref.deref()!==undefined?1:0),0);
 const collect=async(refs,expected,label)=>{
  let count;
  for(let retry=0;retry<5;retry++){await gc();count=alive(refs);if(count===expected)return count}
  assert.equal(count,expected,label);return count;
 };
 // Warm imports/JIT and native bounded width caches before a baseline.
 for(let i=0;i<3;i++){buildCards();await gc()}
 const start=memory();
 let batch=buildWeak();await gc();
 const held=memory();const weak=batch.refs;
 assert.equal(alive(weak),600,'live session correctly retains its owners and frames');
 batch=null;await gc();
 const released=memory();
 const releasedAlive=await collect(weak,0,'all dropped owners and frames are collectable');
 const cardCycles=[];
 for(let round=0;round<12;round++){
  const record=buildWeak();const refs=record.refs;
  record.cards=null;await gc();
  await collect(refs,0,`cycle ${round}: unreachable cards retained`);
  cardCycles.push(memory().heapUsed);
 }
 // One owner remains live throughout streaming. Old frames must disappear;
 // retaining only the current cached frame is intentional, not a leak.
 let streamOwner={},streamBody=Array.from({length:20},(_,i)=>`let n${i}=0;`);
 const streamFrames=[];const streamHeap=[];
 // Keep temporary strong references in a returned call frame, not a lexical
 // binding in an async module suspended at the next GC checkpoint.
 const streamTick=(owner,body,tick)=>{
  body[0]=`let tick=${tick}; // │ literal 中文`;
  return new WeakRef(frameNativeRows('Stream',body,100,theme,undefined,owner));
 };
 for(let round=0;round<12;round++){
  for(let update=0;update<300;update++){
   const ref=streamTick(streamOwner,streamBody,round*300+update);
   if(update===299)streamFrames.push(ref);
  }
  await gc();streamHeap.push(memory().heapUsed);
 }
 await collect(streamFrames,1,'only current frame stays cached for a live owner');
 streamOwner=null;streamBody=null;await gc();
 await collect(streamFrames,0,'last streaming frame releases with owner');
 // A screen is held while many overlays are replaced, then the screen itself
 // is dropped. Weak surface records must not keep components/screens alive.
 function newScreen(){
  const terminal={columns:100,rows:30,write(){},hideCursor(){},showCursor(){}};
  const screen=new TuiAltScreen(terminal,false,undefined,{copyOnSelect:false});
  screen.requestRender=()=>{};screen.stopped=false;screen.altScreenActive=true;
  const root={render:width=>frameNativeRows('Root',['body │ retained'],width,theme).lines,invalidate(){}};
  screen.setLayoutRoot(new VStack([root]));screen.doRender();return screen;
 }
 const overlayObjects=[],overlayHeap=[];
 const replaceOverlay=(screen,round,i)=>{
  const text=`overlay ${round}/${i} ${'text '.repeat(500)}`;
  const component={render:width=>frameNativeRows('Overlay',[text],width,theme).lines,invalidate(){}};
  const ref=new WeakRef(component);
  const handle=screen.showOverlay(component,{row:0,col:0,width:80,nonCapturing:true});
  screen.doRender();handle.hide();screen.doRender();return ref;
 };
 let screen=newScreen();const screenRef=new WeakRef(screen);
 for(let round=0;round<12;round++){
  for(let i=0;i<60;i++){
   overlayObjects.push(replaceOverlay(screen,round,i));
  }
  screen.flashes.dispose();await gc();overlayHeap.push(memory().heapUsed);
 }
 await gc();
 await collect(overlayObjects,0,'hidden overlays do not accumulate');
 screen.stopped=true;screen.flashes.dispose();screen=null;await gc();
 await collect([screenRef],0,'surface records do not keep a dropped screen alive');
 cleanup();
 assert.equal(TuiAltScreen.prototype.getActiveSelectionText,originalCopy);
 assert.equal(ProcessTerminal.prototype.write,originalWrite);
 assert.equal(TuiAltScreen.prototype.compositeOverlays,originalOverlays);
 assert.equal(TuiAltScreen.prototype.compositeFlashes,originalFlashes);
 const reloadHeap=[];
 for(let reload=0;reload<30;reload++){
  const stop=active?installSelectionCopy():()=>{};
  assert.equal(buildCards(40).length,40);
  stop();await gc();reloadHeap.push(memory().heapUsed);
  assert.equal(TuiAltScreen.prototype.getActiveSelectionText,originalCopy);
  assert.equal(ProcessTerminal.prototype.write,originalWrite);
 }
 const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
 const growth=xs=>median(xs.slice(-3))-median(xs.slice(0,3));
 const slopes={cardCycles:growth(cardCycles),streaming:growth(streamHeap),overlayReplacement:growth(overlayHeap),reloads:growth(reloadHeap)};
 for(const [name,bytes] of Object.entries(slopes))assert.ok(bytes<4*1024*1024,`${name}: sustained retained-heap growth exceeds 4 MiB guard: ${bytes}`);
 console.log(JSON.stringify({active,start,held,released,end:memory(),releasedCardObjectsAlive:releasedAlive,
  streamUpdates:3600,droppedStreamFramesAlive:alive(streamFrames),replacedOverlays:720,droppedOverlayObjectsAlive:alive(overlayObjects),
  droppedScreenAlive:screenRef.deref()!==undefined,cardCycles:12,reloads:30,
  heapGrowthBytes:slopes,heapSamples:{cardCycles,streaming:streamHeap,overlayReplacement:overlayHeap,reloads:reloadHeap}}));
}
