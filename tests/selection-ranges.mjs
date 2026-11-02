import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {UserMessageComponent,AssistantMessageComponent,CustomEditor,initTheme} from '@earendil-works/pi-coding-agent';
import {TuiAltScreen,ScrollView,VStack,HStack,Container,ProcessTerminal,stripTerminalSequences,visibleWidth} from '@earendil-works/pi-tui';
import {renderLayoutFrame} from '@earendil-works/pi-tui/dist/layout.js';
const dir=mkdtempSync(join(tmpdir(),'pretty-selection-'));process.env.PI_CODING_AGENT_DIR=dir;writeFileSync(join(dir,'pretty-tui.json'),JSON.stringify({selectionCopy:true}));initTheme('dark',false);
const originalCopy=TuiAltScreen.prototype.getActiveSelectionText, originalWrite=ProcessTerminal.prototype.write;
const originalOverlays=TuiAltScreen.prototype.compositeOverlays,originalFlashes=TuiAltScreen.prototype.compositeFlashes;
const events=new Map(),commands=new Map();const jiti=createJiti(import.meta.url);
const extension=await jiti.import(join(process.cwd(),'extensions/index.ts'),{default:true});
const api={on(n,f){const a=events.get(n)??[];a.push(f);events.set(n,a)},registerToolRenderer(){},getAllTools(){return []},registerCommand(n,c){commands.set(n,c)},registerEntryRenderer(){},appendEntry(){}};
extension(api);
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
 const panes=new HStack([
  {component:{render:width=>frameNativeRows('Left',['left │'],width,theme).lines,invalidate(){}},basis:20,shrink:0},
  {component:{render:width=>frameNativeRows('Right',['right ─'],width,theme).lines,invalidate(){}},basis:20,shrink:0},
 ]);
 const paneScroll=new ScrollView(panes,{primary:true,scrollbar:'hidden'});
 const paneFrame=renderLayoutFrame(new VStack([paneScroll]),40,2,()=>{});
 const paneScreen=Object.assign(Object.create(TuiAltScreen.prototype),{currentLayout:paneFrame,
  getSelectionBounds:()=>({start:{row:1,col:0,scrollView:paneScroll},end:{row:1,col:19,scrollView:paneScroll}})});
 assert.equal(paneScreen.getActiveSelectionText(),'left │','horizontally composited scroll content recovers original leaf metadata');
 paneScroll.scrollTo(1);
 paneScreen.currentLayout=renderLayoutFrame(new VStack([paneScroll]),40,2,()=>{});
 assert.equal(paneScreen.getActiveSelectionText(),'left │','offscreen scroll offsets do not change horizontal copy ranges');
 paneScreen.getSelectionBounds=()=>({start:{row:1,col:20,scrollView:paneScroll},end:{row:1,col:39,scrollView:paneScroll}});
 assert.equal(paneScreen.getActiveSelectionText(),'right ─','right-hand pane uses its own source origin');
 const opaquePanes=new Container();opaquePanes.addChild(panes);
 const opaqueScroll=new ScrollView(opaquePanes,{primary:true,scrollbar:'hidden'});
 const opaqueFrame=renderLayoutFrame(new VStack([opaqueScroll]),40,2,()=>{});
 const opaqueScreen=Object.assign(Object.create(TuiAltScreen.prototype),{currentLayout:opaqueFrame,
  getSelectionBounds:()=>({start:{row:1,col:0,scrollView:opaqueScroll},end:{row:1,col:19,scrollView:opaqueScroll}})});
 assert.equal(opaqueScreen.getActiveSelectionText(),'left │','opaque horizontal wrappers must retain provenance too');
 const clippedLines=['prefix',...frameNativeRows('Clip',['first','second'],40,theme).lines];
 const clippedLeaf={render:()=>clippedLines,invalidate(){}};
 const clippedFrame=renderLayoutFrame(new VStack([{component:clippedLeaf,basis:3,shrink:0}]),40,3,()=>{});
 const clipScreen=Object.assign(Object.create(TuiAltScreen.prototype),{currentLayout:clippedFrame,
  previousScreen:clippedFrame.lines,getSelectionBounds:()=>({start:{row:0,col:0},end:{row:2,col:39}})});
 assert.equal(clipScreen.getActiveSelectionText(),'prefix\nfirst','vertical layout allocation crops without requiring a bottom border');
 const card=frameNativeRows('Tool',['alpha beta','second line','  indented',''],40,theme);
 assert.equal(copy(card.lines),'alpha beta\nsecond line\n  indented\n');
 assert.equal(copy(card.lines,{row:1,col:card.inset+2},{row:2,col:card.inset+5}),'pha beta\nsecond');
 assert.equal(copy(card.lines,{row:0,col:0},{row:0,col:39}),undefined);
 // Deterministic partial-selection sweep against independently known payload
 // coordinates, including literal box drawings and wide graphemes.
 let seed=0x2c7a4106;
 const random=limit=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%limit};
 const {sliceByColumn}=await import('@earendil-works/pi-tui');
 for(let sample=0;sample<350;sample++){
  const payload=['  value = "│";','',sample%2?'甲🙂乙 é':'├─ literal tree','  trailing row'];
  const width=40+random(60);
  const framed=frameNativeRows('Sweep',payload,width,theme);
  let start={row:random(framed.lines.length),col:random(width)},end={row:random(framed.lines.length),col:random(width)};
  if(start.row>end.row||start.row===end.row&&start.col>end.col)[start,end]=[end,start];
  const bounds={start,end};const expected=[];
  const nativeScreen=Object.create(TuiAltScreen.prototype);
  for(let row=start.row;row<=end.row;row++){
   const index=framed.sourceRows.get(row);
   if(index===undefined)continue;
   const selected=nativeScreen.getSelectionColumns(framed.lines[row],row,bounds);
   const a=Math.max(framed.inset,selected.start),b=Math.min(framed.inset+Math.max(1,visibleWidth(payload[index])),selected.end);
   if(b>a)expected.push(stripTerminalSequences(sliceByColumn(payload[index],a-framed.inset,b-a,true)).trimEnd());
  }
  const joined=expected.join('\n')||undefined;
  assert.equal(copy(framed.lines,start,end),joined,`partial-selection sweep ${sample}`);
 }
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
 live.resetTextSelection();
 const overlay=live.showOverlay({render:()=>['OVERLAY │ real'],invalidate(){}}, {row:resizedTop,col:0,width:20,nonCapturing:true});
 live.doRender();
 live.selectionAnchor={row:resizedTop,col:0};live.selectionFocus={row:resizedTop,col:19};
 assert.equal(live.getActiveSelectionText(),'OVERLAY │ real','overlay content must not inherit hidden frame exclusions');
 overlay.hide();live.doRender();
 let overlayRenders=0;
 const panelOverlay=live.showOverlay({render(width){overlayRenders++;return frameNativeRows('Overlay',['overlay │ text','  extra'],width,theme).lines},invalidate(){}},
  {row:resizedTop,col:0,width:40,nonCapturing:true});
 live.resetTextSelection();live.doRender();
 const beforeCopyRenders=overlayRenders;
 live.selectionAnchor={row:resizedTop,col:0};live.selectionFocus={row:resizedTop+3,col:39};
 assert.equal(live.getActiveSelectionText(),'overlay │ text\n  extra','marked overlay excludes only its own chrome');
 assert.equal(overlayRenders,beforeCopyRenders,'copy never renders an overlay again');
 const front=live.showOverlay({render:()=>['│ REAL'],invalidate(){}},{row:resizedTop+1,col:0,width:6,nonCapturing:true});
 live.doRender();
 live.selectionAnchor={row:resizedTop+1,col:0};live.selectionFocus={row:resizedTop+1,col:5};
 assert.equal(live.getActiveSelectionText(),'│ REAL','topmost unmarked surface restores literal glyphs over marked borders');
 front.hide();panelOverlay.hide();live.doRender();
 const clipped=live.showOverlay({render:width=>frameNativeRows('Clipped',['body │ stays','hidden'],width,theme).lines,invalidate(){}},
  {row:resizedTop,col:0,width:40,maxHeight:2,nonCapturing:true});
 live.doRender();
 live.selectionAnchor={row:resizedTop,col:0};live.selectionFocus={row:resizedTop+1,col:39};
 assert.equal(live.getActiveSelectionText(),'body │ stays','clipped overlay uses current raw rows without needing complete borders');
 clipped.hide();live.flash('FLASH │ real');live.doRender();
 const flashLine=live.previousScreen[0];
 const flashAt=stripTerminalSequences(flashLine).indexOf('FLASH');
 live.selectionAnchor={row:0,col:flashAt};live.selectionFocus={row:0,col:flashAt+11};
 assert.equal(live.getActiveSelectionText(),'FLASH │ real','native flash replaces lower border exclusions');
 live.flashes.dispose();live.resetTextSelection();live.doRender();
 const searchScroll=new ScrollView(new VStack([{render:width=>frameNativeRows('Search',['search │ needle','second'],width,theme).lines,invalidate(){}}]),
  {primary:true,scrollbar:'hidden'});
 live.setLayoutRoot(new VStack([searchScroll]));live.doRender();
 live.toggleSearch();live.updateSearchQuery('needle');live.doRender();
 live.selectionAnchor={row:1,col:0,scrollView:searchScroll};live.selectionFocus={row:1,col:39,scrollView:searchScroll};
 assert.equal(live.getActiveSelectionText(),'search │ needle','native search highlights do not change scroll-source content');
 live.closeSearch();live.resetTextSelection();
 const jumpScroll=new ScrollView(new VStack([{render:width=>frameNativeRows('Jump',Array.from({length:30},(_,i)=>`row ${i} │`),width,theme).lines,invalidate(){}}]),
  {primary:true,scrollbar:'hidden',follow:'end'});
 live.scrollToEndIndicator=()=> 'JUMP │ real';
 live.setLayoutRoot(new VStack([jumpScroll]));live.doRender();jumpScroll.scrollToStart();live.doRender();
 const jump=live.scrollToEndIndicatorRect;
 assert.ok(jump,'fixture displays native jump-to-end indicator');
 live.selectionAnchor={row:jump.row,col:jump.column};live.selectionFocus={row:jump.row,col:jump.column+jump.width-1};
 assert.equal(live.getActiveSelectionText(),'JUMP │ real','native jump indicator overrides underlying decoration');
 live.resetTextSelection();
 const stream=new AssistantMessageComponent({role:'assistant',timestamp:5,content:[{type:'text',text:'Initial'}]});
 const streamRoot=new Container();streamRoot.addChild(stream);
 live.setLayoutRoot(new VStack([streamRoot]));
 for(let i=0;i<250;i++){
  const line=`let f${i} = "│ ─";`;
  stream.updateContent({role:'assistant',timestamp:5,content:[{type:'text',text:'```ts\n'+line+'\n```'}]},true);
  terminal.columns=i%2?40:60;live.doRender();
  live.selectionAnchor={row:0,col:0};live.selectionFocus={row:14,col:terminal.columns-1};
  const copied=live.getActiveSelectionText();
  assert.ok(copied.includes(line),`stream ${i}: current source survives reflow`);
  assert.ok(!copied.includes('╭─')&&!copied.includes('╰─'),`stream ${i}: no stale frame chrome`);
 }
 live.stopped=true;
 const editor=new CustomEditor({terminal:{columns:60,rows:30},requestRender(){}},{borderColor:s=>s});
 editor.setText('first\n  second\n│ third');
 const editorLines=editor.render(60);
 assert.equal(copy(editorLines),'first\n  second\n│ third','composer retains content and indent');
 const assistant=new AssistantMessageComponent({role:'assistant',timestamp:1,content:[{type:'text',text:'```ts\nconst divider = "│";\n\n// x ─ y\n```'}]});
 const assistantCopy=copy(assistant.render(80));
 assert.ok(assistantCopy.includes('const divider = "│";\n\n// x ─ y'),'real Markdown code block retains literal glyphs and blank lines');
 assert.ok(!assistantCopy.includes('╭─')&&!assistantCopy.includes('╰─'),'assistant and code frame decorations are excluded');
 const link='\x1b]8;;https://example.test\x07link │ text\x1b]8;;\x07';
 assert.equal(copy(frameNativeRows('Hyperlink',[link],40,theme).lines),'link │ text','hyperlink label remains selectable verbatim');
 const marked=selectableRow('│ body │',8,[[2,6]]);
 assert.equal(visibleWidth(marked),8);
 assert.equal(removeSelectionMetadata(marked),'│ body │');
 assert.equal(stripTerminalSequences(marked),'│ body │');
 let terminalOutput=''; const write=process.stdout.write;process.stdout.write=function(data){terminalOutput+=data;return true};
 try{ProcessTerminal.prototype.write.call({},marked);}finally{process.stdout.write=write;}
 assert.equal(terminalOutput,'│ body │','private metadata never reaches terminal');
 for(let reload=0;reload<5;reload++){
  for(const fn of events.get('session_shutdown')??[])await fn();
  assert.equal(TuiAltScreen.prototype.getActiveSelectionText,originalCopy);
  assert.equal(TuiAltScreen.prototype.compositeOverlays,originalOverlays);
  assert.equal(TuiAltScreen.prototype.compositeFlashes,originalFlashes);
  assert.equal(ProcessTerminal.prototype.write,originalWrite);
  events.clear();commands.clear();extension(api);
  assert.equal(copy(frameNativeRows('Reload',['  content │ stays'],40,theme).lines),'  content │ stays',`reload ${reload}: metadata and copy hooks agree`);
 }
 console.log('Selection ranges passed: real layout, opaque wrappers, scroll/viewport/horizontal clipping, 350 partial-selection cases, literal art and graphemes, overlays/flashes/search, 250 streaming reflows, native mouse gestures, terminal hygiene.');
}finally{
 for(const fn of events.get('session_shutdown')??[])await fn();
 assert.equal(TuiAltScreen.prototype.getActiveSelectionText,originalCopy);
 assert.equal(ProcessTerminal.prototype.write,originalWrite);
 assert.equal(TuiAltScreen.prototype.compositeOverlays,originalOverlays);
 assert.equal(TuiAltScreen.prototype.compositeFlashes,originalFlashes);
 rmSync(dir,{recursive:true,force:true});
}
