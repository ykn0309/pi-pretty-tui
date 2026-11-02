// Run with --expose-gc; retained-heap samples include live card rows and width
// caches, but exclude OS/GPU memory. Fresh processes avoid cross-mode cache bias.
import {execFileSync} from 'node:child_process';
import {createJiti} from 'jiti';import {join} from 'node:path';
if(!process.argv.includes('--child')){
 const run=mode=>JSON.parse(execFileSync(process.execPath,['--expose-gc',process.argv[1],'--child',mode],{encoding:'utf8'}));
 const before=[],after=[];
 for(let i=0;i<5;i++){before.push(run('before'));after.push(run('after'))}
 const median=values=>values.sort((a,b)=>a-b)[2];
 console.log(JSON.stringify({cards:300,rows:6600,samples:5,
  retainedHeapBytes:{before:median(before.map(v=>v.heap)),after:median(after.map(v=>v.heap))},
  serializedBytes:{before:before[0].bytes,after:after[0].bytes},
  note:'GC-based estimate; includes retained rows and caches, excludes OS terminal/GPU memory.'},null,2));
}else{
 if(!global.gc)throw Error('requires --expose-gc');
 const jiti=createJiti(import.meta.url);
 const {frameNativeRows}=await jiti.import(join(process.cwd(),'extensions/full-frame.ts'));
 const {installSelectionCopy}=await jiti.import(join(process.cwd(),'extensions/selection-ranges.ts'));
 const theme={fg:(_r,s)=>s,bg:(_r,s)=>s,bold:s=>s};
 global.gc();const start=process.memoryUsage().heapUsed;
 const cleanup=process.argv.at(-1)==='after'?installSelectionCopy():()=>{};
 const cards=Array.from({length:300},(_,i)=>{
  const body=Array.from({length:20},(_,row)=>`  const c${i}_v${row} = "│ real 中文";`);
  const owner={};return {owner,body,frame:frameNativeRows('Tool '+i,body,100,theme,undefined,owner)};
 });
 global.gc();const heap=process.memoryUsage().heapUsed-start;
 const bytes=cards.reduce((count,card)=>count+Buffer.byteLength(card.frame.lines.join('\n')),0);
 console.log(JSON.stringify({heap,bytes}));cleanup();
}
