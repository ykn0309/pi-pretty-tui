import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createJiti} from 'jiti';import {initTheme} from '@earendil-works/pi-coding-agent';
import {TuiAltScreen,ProcessTerminal} from '@earendil-works/pi-tui';
const dir=mkdtempSync(join(tmpdir(),'selection-options-'));process.env.PI_CODING_AGENT_DIR=dir;initTheme('dark',false);
const path=join(dir,'pretty-tui.json');writeFileSync(path,JSON.stringify({mode:'compact',preserveMe:7}));
const original={copy:TuiAltScreen.prototype.getActiveSelectionText,write:ProcessTerminal.prototype.write,
 overlays:TuiAltScreen.prototype.compositeOverlays,flashes:TuiAltScreen.prototype.compositeFlashes};
const jiti=createJiti(import.meta.url),extension=await jiti.import(join(process.cwd(),'extensions/index.ts'),{default:true});
const {frameNativeRows}=await jiti.import(join(process.cwd(),'extensions/full-frame.ts'));
const {removeSelectionMetadata}=await jiti.import(join(process.cwd(),'extensions/selection-ranges.ts'));
const theme={fg:(_role,s)=>s,bg:(_role,s)=>s,bold:s=>s};
let events,commands,reloads=0;const notices=[];
const stop=async()=>{for(const fn of [...events.get('session_shutdown')??[]])await fn()};
function boot(){events=new Map();commands=new Map();extension({on(n,f){const a=events.get(n)??[];a.push(f);events.set(n,a)},
 registerCommand(n,c){commands.set(n,c)},registerToolRenderer(){},getAllTools(){return []},registerEntryRenderer(){},appendEntry(){}})}
const ctx={hasUI:true,ui:{notify(message,type){notices.push({message,type})}},async reload(){reloads++;await stop();boot()}};
const config=()=>JSON.parse(readFileSync(path,'utf8'));
const rows=()=>frameNativeRows('Test',['literal │ text'],40,theme).lines;
const native=()=>{
 assert.equal(TuiAltScreen.prototype.getActiveSelectionText,original.copy);
 assert.equal(ProcessTerminal.prototype.write,original.write);
 assert.equal(TuiAltScreen.prototype.compositeOverlays,original.overlays);
 assert.equal(TuiAltScreen.prototype.compositeFlashes,original.flashes);
 assert.ok(rows().every(line=>removeSelectionMetadata(line)===line),'off renders no private metadata');
};
const enabled=()=>{assert.notEqual(TuiAltScreen.prototype.getActiveSelectionText,original.copy);assert.ok(rows().some(line=>removeSelectionMetadata(line)!==line))};
try{
 boot();native();
 await commands.get('pretty-tui').handler('status',ctx);assert.ok(notices.at(-1).message.includes('selection copy: off'));
 assert.deepEqual(commands.get('pretty-tui').getArgumentCompletions('selection-copy').map(x=>x.value),['selection-copy on','selection-copy off']);
 await commands.get('pretty-tui').handler('selection-copy on',ctx);
 enabled();assert.equal(config().selectionCopy,true);assert.equal(config().mode,'compact');assert.equal(config().preserveMe,7);assert.equal(reloads,1);
 await commands.get('pretty-tui').handler('status',ctx);assert.ok(notices.at(-1).message.includes('selection copy: on'));
 await commands.get('pretty-tui').handler('selection-copy off',ctx);
 native();assert.equal(config().selectionCopy,false);assert.equal(reloads,2);
 const menuCtx={...ctx,ui:{...ctx.ui,async select(_title,items){return items.find(item=>item.startsWith('Selection copy'))}}};
 await commands.get('pretty-tui').handler('',menuCtx);enabled();assert.equal(config().selectionCopy,true);
 await commands.get('pretty-tui').handler('',menuCtx);native();assert.equal(config().selectionCopy,false);
 for(let i=0;i<5;i++){
  await commands.get('pretty-tui').handler('selection-copy on',ctx);enabled();
  await commands.get('pretty-tui').handler('selection-copy off',ctx);native();
 }
 await commands.get('pretty-tui').handler('selection-copy on',{...ctx,async reload(){throw Error('fixture reload failure')}});
 assert.equal(config().selectionCopy,true);assert.equal(notices.at(-1).type,'warning');native();
 await stop();boot();enabled();
 await commands.get('pretty-tui').handler('disable',ctx);native();assert.equal(config().enabled,false);
 // Configuring this option while the extension is disabled must not activate it.
 await commands.get('pretty-tui').handler('selection-copy on',ctx);native();
 await commands.get('pretty-tui').handler('enable',ctx);enabled();
 await stop();writeFileSync(path,JSON.stringify({selectionCopy:'true'}));boot();native();
 const count=reloads;await commands.get('pretty-tui').handler('selection-copy maybe',ctx);
 assert.equal(notices.at(-1).type,'error');assert.equal(reloads,count);
 console.log('Selection option passed: default off, persistent on/off, menu, completions, native restoration, repeated toggles, reload failure, disabled extension and malformed config.');
}finally{await stop();native();rmSync(dir,{recursive:true,force:true})}
