// Reproducible microbenchmark; wall-clock numbers are not full-terminal FPS.
import {performance} from 'node:perf_hooks';
import {createJiti} from 'jiti';
import {join} from 'node:path';
import {TuiAltScreen} from '@earendil-works/pi-tui';
const jiti=createJiti(import.meta.url);
const {frameNativeRows}=await jiti.import(join(process.cwd(),'extensions/full-frame.ts'));
const {installSelectionCopy,removeSelectionMetadata}=await jiti.import(join(process.cwd(),'extensions/selection-ranges.ts'));
const theme={fg:(_r,s)=>s,bg:(_r,s)=>s,bold:s=>s};
const body=Array.from({length:20},(_,i)=>`  const value_${i} = "│ literal 中文";`);
const make=()=>Array.from({length:300},(_,i)=>frameNativeRows(`Tool ${i}`,body,100,theme).lines).flat();
const original=TuiAltScreen.prototype.getActiveSelectionText;
const copy=(lines,fn)=>{const screen=Object.assign(Object.create(TuiAltScreen.prototype),{previousScreen:lines,
 getSelectionBounds:()=>({start:{row:0,col:0},end:{row:lines.length-1,col:99}})});return fn.call(screen)};
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
const measure=fn=>{const values=[];let value;for(let i=0;i<7;i++){const t=performance.now();value=fn();values.push(performance.now()-t);}return {ms:+median(values).toFixed(2),value}};
const owners=Array.from({length:300},()=>({}));
const makeCached=()=>owners.map((owner,i)=>frameNativeRows(`Tool ${i}`,body,100,theme,undefined,owner).lines).flat();
const baseline=measure(make);
makeCached();
const cachedBefore=measure(makeCached);
const beforeCopy=measure(()=>copy(baseline.value,original));
const cleanup=installSelectionCopy();
try{
 const marked=measure(make);
 makeCached();
 const cachedAfter=measure(makeCached);
 const afterCopy=measure(()=>copy(marked.value,TuiAltScreen.prototype.getActiveSelectionText));
 const visible=marked.value.map(removeSelectionMetadata);
 if(JSON.stringify(visible)!==JSON.stringify(baseline.value))throw Error('Visible rendering changed');
 const repeated=body.join('\n');
 if(afterCopy.value!==Array(300).fill(repeated).join('\n'))throw Error('Copy integrity failed');
 console.log(JSON.stringify({cards:300,renderedRows:marked.value.length,samples:7,
  renderMedianMs:{before:baseline.ms,after:marked.ms},unchangedRenderMedianMs:{before:cachedBefore.ms,after:cachedAfter.ms},copyMedianMs:{before:beforeCopy.ms,after:afterCopy.ms},
  metadataBytes:Buffer.byteLength(marked.value.join('\n'))-Buffer.byteLength(baseline.value.join('\n')),
  visibleRowsIdentical:true,copyIntegrity:true},null,2));
}finally{cleanup()}
