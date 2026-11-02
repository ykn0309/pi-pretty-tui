import {writeFileSync} from 'node:fs';
import {CustomEditor} from '@earendil-works/pi-coding-agent';
import {TuiAltScreen,stripTerminalSequences} from '@earendil-works/pi-tui';
export default function(pi:any){
 let screen:any;
 const proto=CustomEditor.prototype as any;
 const original=proto.render;
 const render=function(this:any,width:number){screen=this.tui;return original.call(this,width)};
 proto.render=render;
 const tui=TuiAltScreen.prototype as any;
 const originalCopy=tui.copyTextToClipboard;
 tui.copyTextToClipboard=async function(text:string){writeFileSync(process.env.PRETTY_SELECTION_RESULT!,JSON.stringify({text}));return true};
 const timer=setInterval(()=>{
  if(!screen?.getScreenLines)return;
  writeFileSync(process.env.PRETTY_SELECTION_READY!,JSON.stringify({
   lines:screen.getScreenLines().map(stripTerminalSequences),columns:screen.terminal.columns,rows:screen.terminal.rows,
  }));
 },50);
 pi.on('session_start',(_event:any,ctx:any)=>ctx.ui.setEditorText('first\n  second\n│ third'));
 pi.on('session_shutdown',()=>{clearInterval(timer);if(proto.render===render)proto.render=original;tui.copyTextToClipboard=originalCopy});
}
