// Measures native TuiAltScreen layout, painting, row diffing and write filtering.
// It excludes OS terminal I/O/GPU work and model/network activity.
import {performance} from 'node:perf_hooks';
import {createJiti} from 'jiti';import {join} from 'node:path';
import {TuiAltScreen,VStack,ScrollView} from '@earendil-works/pi-tui';
const jiti=createJiti(import.meta.url);
const {frameNativeRows}=await jiti.import(join(process.cwd(),'extensions/full-frame.ts'));
const {installSelectionCopy,removeSelectionMetadata}=await jiti.import(join(process.cwd(),'extensions/selection-ranges.ts'));
const theme={fg:(_r,s)=>s,bg:(_r,s)=>s,bold:s=>s};
const measure=fn=>{const samples=[];for(let i=0;i<9;i++){const start=performance.now();fn();samples.push(performance.now()-start);}return +samples.sort((a,b)=>a-b)[4].toFixed(3)};
function fixture(){
 let tick=0,bytes=0;
 const bodies=Array.from({length:300},(_,card)=>Array.from({length:20},(_,row)=>`  const c${card}_v${row} = "│ real 中文";`));
 const cards=bodies.map((body,i)=>{const owner={};return {render:width=>frameNativeRows('Tool '+i,body,width,theme,undefined,owner).lines,invalidate(){}}});
 const terminal={columns:100,rows:40,write(data){bytes+=Buffer.byteLength(removeSelectionMetadata(data))}};
 const screen=new TuiAltScreen(terminal,false,undefined,{copyOnSelect:false});screen.requestRender=()=>{};
 const scroll=new ScrollView(new VStack(cards),{primary:true,scrollbar:'hidden',follow:'end'});
 screen.setLayoutRoot(new VStack([scroll]));screen.stopped=false;screen.altScreenActive=true;
 return {screen,scroll,render(){screen.doRender()},stream(){bodies[299][0]=`  const tick = ${++tick};`;screen.doRender()},
  copy(){screen.selectionAnchor={row:0,col:0,scrollView:scroll};screen.selectionFocus={row:6599,col:99,scrollView:scroll};return screen.getActiveSelectionText()},
  dispose(){screen.stopped=true;screen.flashes.dispose()},bytes:()=>bytes};
}
function run(){
 const cold=measure(()=>{const f=fixture();try{f.render()}finally{f.dispose()}});
 const f=fixture();try{
  f.render();const cached=measure(()=>f.render());
  const streaming=measure(()=>f.stream());
  const copy=measure(()=>f.copy());
  return {coldFirstPaintMedianMs:cold,unchangedFrameMedianMs:cached,streamingOneCardMedianMs:streaming,copy6600RowsMedianMs:copy};
 }finally{f.dispose()}
}
const before=run();const cleanup=installSelectionCopy();
try{const after=run();console.log(JSON.stringify({cards:300,rows:6600,viewport:[100,40],samples:9,before,after},null,2))}finally{cleanup()}
