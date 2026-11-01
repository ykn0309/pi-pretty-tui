import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {UserMessageComponent,AssistantMessageComponent,CustomEditor,initTheme} from '@earendil-works/pi-coding-agent';
import {TuiAltScreen,ScrollView,VStack,Container,ProcessTerminal,stripTerminalSequences,visibleWidth} from '@earendil-works/pi-tui';
import {renderLayoutFrame} from '@earendil-works/pi-tui/dist/layout.js';
const dir=mkdtempSync(join(tmpdir(),'pretty-selection-'));process.env.PI_CODING_AGENT_DIR=dir;initTheme('dark',false);
const originalCopy=TuiAltScreen.prototype.getActiveSelectionText, originalWrite=ProcessTerminal.prototype.write;
const events=new Map(),commands=new Map();const jiti=createJiti(import.meta.url);
(await jiti.import(join(process.cwd(),'extensions/index.ts'),{default:true}))({on(n,f){const a=events.get(n)??[];a.push(f);events.set(n,a)},registerToolRenderer(){},getAllTools(){return []},registerCommand(n,c){commands.set(n,c)},registerEntryRenderer(){},appendEntry(){}});
const {frameNativeRows}=await jiti.import(join(process.cwd(),'extensions/full-frame.ts'));
const {removeSelectionMetadata,selectableRow}=await jiti.import(join(process.cwd(),'extensions/selection-ranges.ts'));
const theme={fg:(_r,s)=>s,bg:(_r,s)=>s,bold:s=>s};
const ctx={sessionManager:{buildContextEntries:()=>[],getBranch:()=>[]},ui:{getToolsExpanded:()=>false,notify(){},setWidget(){}}};
for(const fn of events.get('session_start')??[])await fn({},ctx);
const copy=(lines,start={row:0,col:0},end={row:lines.length-1,col:10000})=>{
 const screen=Object.assign(Object.create(TuiAltScreen.prototype),{previousScreen:lines,getSelectionBounds:()=>({start,end})});
 return screen.getActiveSelectionText();
};
try{
 const content=['  const divider = "│";','','├─ real tree','x ─ y','中文🙂combining é'];
 for(const mode of ['clean','compact','full']){
  await commands.get('pretty-tui').handler(mode,{hasUI:true,ui:{notify(){}}});
  for(const width of [40,80,140]){
   const user=new UserMessageComponent(content.join('\n'));
   // Opaque wrapping matches the actual transcript layout, rather than relying
   // on UserMessageComponent being visible to the layout engine.
   const wrapper=new Container();wrapper.addChild(user);
   const scroll=new ScrollView(new VStack([wrapper]),{primary:true,scrollbar:'auto'});
   const frame=renderLayoutFrame(new VStack([scroll]),width,12,()=>{});
   const box=frame.root.children[0];const lines=box.scrollContentLines;
   const screen=Object.assign(Object.create(TuiAltScreen.prototype),{currentLayout:frame,
    getSelectionBounds:()=>({start:{row:0,col:0,scrollView:scroll},end:{row:lines.length-1,col:width-1,scrollView:scroll}})});
   const text=screen.getActiveSelectionText();
   assert.equal(text,content.join('\n'),`${mode}/${width}: native layout copied content exactly`);
   scroll.scrollTo(2);
   const scrolled=renderLayoutFrame(new VStack([scroll]),width,4,()=>{});screen.currentLayout=scrolled;
   assert.equal(screen.getActiveSelectionText(),content.join('\n'),`${mode}/${width}: scroll content coordinates stay correct`);
  }
 }
 const card=frameNativeRows('Tool',['alpha beta','second line','  indented',''],40,theme);
 assert.equal(copy(card.lines),'alpha beta\nsecond line\n  indented\n');
 assert.equal(copy(card.lines,{row:1,col:card.inset+2},{row:2,col:card.inset+5}),'pha beta\nsecond');
 assert.equal(copy(card.lines,{row:0,col:0},{row:0,col:39}),undefined);
 const utf=frameNativeRows('Unicode',['甲🙂乙 é'],40,theme);
 assert.equal(copy(utf.lines,{row:1,col:utf.inset+1},{row:1,col:utf.inset+3}),'甲🙂','wide grapheme boundaries stay native');
 const literalCard=new UserMessageComponent('╭─ literal ─╮\n│ inner art │\n╰───────────╯');
 assert.equal(copy(literalCard.render(80)),'╭─ literal ─╮\n│ inner art │\n╰───────────╯','literal rounded boxes inside content survive');
 const diagram=['╭─ User ───╮','│ literal  │','╰──────────╯'];
 assert.equal(copy(diagram),diagram.join('\n'),'unmarked art is never touched');
 const nested=frameNativeRows('Inner',['  code = "│";','x ─ y'],30,theme);
 const outer=frameNativeRows('Outer',nested.lines,40,theme);
 assert.equal(copy(outer.lines),'  code = "│";\nx ─ y','nested decorations compose');
 assert.equal(copy([...card.lines,'between',...frameNativeRows('Other',['tail'],40,theme).lines]),'alpha beta\nsecond line\n  indented\n\nbetween\ntail');
 const terminal={columns:60,rows:15,write(){},hideCursor(){},showCursor(){}};
 const live=new TuiAltScreen(terminal,false,undefined,{copyOnSelect:false});
 live.requestRender=()=>{};
 live.stopped=false;live.altScreenActive=true;
 const liveEditor=new CustomEditor(live,{borderColor:s=>s});
 liveEditor.setText('first\n  second\n│ third');
 const opaque=new Container();opaque.addChild(liveEditor);
 live.setLayoutRoot(new VStack([opaque]));
 live.doRender();
 const plainScreen=live.previousScreen.map(stripTerminalSequences);
 const firstRow=plainScreen.findIndex(line=>line.startsWith('╭'));
 live.selectionAnchor={row:firstRow,col:0};
 live.selectionFocus={row:firstRow+4,col:59};
 assert.equal(live.getActiveSelectionText(),'first\n  second\n│ third','actual viewport paint retains selection metadata through opaque editor layout');
 live.doRender();
 assert.equal(live.getActiveSelectionText(),'first\n  second\n│ third','selection highlighting does not lose metadata');
 live.selectionAnchor={row:firstRow+1,col:3};live.selectionFocus={row:firstRow+2,col:5};
 assert.equal(live.getActiveSelectionText(),'rst\n  sec','actual viewport partial selection');
 live.resetTextSelection();
 const gesture=(from,to)=>{
  live.handleSelectionMouseEvent({button:0,release:false,x:from.col,y:from.row});
  live.handleSelectionMouseEvent({button:32,release:false,x:to.col,y:to.row});
  live.handleSelectionMouseEvent({button:0,release:true,x:to.col,y:to.row});
 };
 gesture({row:firstRow+1,col:3},{row:firstRow+2,col:5});
 assert.equal(live.getActiveSelectionText(),'rst\n  sec','native mouse press/drag/release copies clean text');
 live.resetTextSelection();
 gesture({row:firstRow+2,col:5},{row:firstRow+1,col:3});
 assert.equal(live.getActiveSelectionText(),'rst\n  sec','reverse native mouse selection');
 terminal.columns=40;live.doRender();
 const resizedTop=live.previousScreen.map(stripTerminalSequences).findIndex(line=>line.startsWith('╭'));
 live.resetTextSelection();
 gesture({row:resizedTop,col:0},{row:resizedTop+4,col:39});
 assert.equal(live.getActiveSelectionText(),'first\n  second\n│ third','real viewport resize recomputes ranges without stale geometry');
 live.stopped=true;
 const editor=new CustomEditor({terminal:{columns:60,rows:30},requestRender(){}},{borderColor:s=>s});
 editor.setText('first\n  second\n│ third');
 const editorLines=editor.render(60);
 assert.equal(copy(editorLines),'first\n  second\n│ third','composer retains content and indent');
 const assistant=new AssistantMessageComponent({role:'assistant',timestamp:1,content:[{type:'text',text:'```ts\nconst divider = "│";\n\n// x ─ y\n```'}]});
 const assistantCopy=copy(assistant.render(80));
 assert.ok(assistantCopy.includes('const divider = "│";\n\n// x ─ y'),'real Markdown code block retains literal glyphs and blank lines');
 assert.ok(!assistantCopy.includes('╭─')&&!assistantCopy.includes('╰─'),'assistant and code frame decorations are excluded');
 const marked=selectableRow('│ body │',8,[[2,6]]);
 assert.equal(visibleWidth(marked),8);
 assert.equal(removeSelectionMetadata(marked),'│ body │');
 assert.equal(stripTerminalSequences(marked),'│ body │');
 let terminalOutput=''; const write=process.stdout.write;process.stdout.write=function(data){terminalOutput+=data;return true};
 try{ProcessTerminal.prototype.write.call({},marked);}finally{process.stdout.write=write;}
 assert.equal(terminalOutput,'│ body │','private metadata never reaches terminal');
 console.log('Selection ranges: real layout, opaque wrappers, 3 modes, 3 widths, scroll, partial and cross-card selection, literal art, nested cards, composer, terminal hygiene passed.');
}finally{
 for(const fn of events.get('session_shutdown')??[])await fn();
 assert.equal(TuiAltScreen.prototype.getActiveSelectionText,originalCopy);
 assert.equal(ProcessTerminal.prototype.write,originalWrite);
 rmSync(dir,{recursive:true,force:true});
}
