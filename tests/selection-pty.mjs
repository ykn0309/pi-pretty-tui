// Native fullscreen harness for the Python PTY test (no model/API calls).
import {createJiti} from 'jiti';
import {writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {initTheme,UserMessageComponent,CustomEditor} from '@earendil-works/pi-coding-agent';
import {ProcessTerminal,TuiAltScreen,VStack,ScrollView,Container,stripTerminalSequences} from '@earendil-works/pi-tui';
const dir=mkdtempSync(join(tmpdir(),'selection-native-pty-'));process.env.PI_CODING_AGENT_DIR=dir;initTheme('dark',false);
const events=new Map();
(await createJiti(import.meta.url).import(join(process.cwd(),'extensions/index.ts'),{default:true}))({
 on(n,f){const a=events.get(n)??[];a.push(f);events.set(n,a)},registerToolRenderer(){},getAllTools(){return []},registerCommand(){},registerEntryRenderer(){},appendEntry(){}});
const terminal=new ProcessTerminal();
const screen=new TuiAltScreen(terminal,false,undefined,{copyOnSelect:true,copySelection:async text=>{
 writeFileSync(process.env.PRETTY_SELECTION_RESULT,JSON.stringify({text}));return true;
}});
const user=new UserMessageComponent('  const divider = "│";\n\n├─ real tree\nx ─ y');
const opaque=new Container();opaque.addChild(user);
const scroll=new ScrollView(new VStack([opaque]),{primary:true,scrollbar:'auto'});
const editor=new CustomEditor(screen,{borderColor:s=>s});editor.setText('first\n  second\n│ third');
screen.setLayoutRoot(new VStack([{component:scroll,grow:1},{component:editor,shrink:0}]));screen.setFocus(editor);
screen.addInputListener(data=>{if(data==='\x03'){screen.stop();process.exit(0)}});
screen.start();
const timer=setInterval(()=>{const lines=screen.getScreenLines().map(stripTerminalSequences);
 writeFileSync(process.env.PRETTY_SELECTION_READY,JSON.stringify({lines,columns:terminal.columns,rows:terminal.rows}));},50);
const shutdown=async()=>{clearInterval(timer);for(const fn of events.get('session_shutdown')??[])await fn();rmSync(dir,{recursive:true,force:true})};
process.on('exit',()=>{clearInterval(timer);rmSync(dir,{recursive:true,force:true})});
process.on('SIGTERM',()=>{screen.stop();shutdown().finally(()=>process.exit(0))});
