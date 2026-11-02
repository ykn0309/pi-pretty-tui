// Fixture sessions are newly generated; no existing user sessions are read.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
const dir=process.argv[2];mkdirSync(dir,{recursive:true});
writeFileSync(join(dir,'models.json'),JSON.stringify({providers:{'selection-fixture':{
 baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',apiKey:'offline-fixture',
 models:[{id:'offline',name:'Offline fixture',contextWindow:32000,maxTokens:1024}],
}}}));
const s=SessionManager.create(dir,join(dir,'sessions'));
s.appendModelChange('selection-fixture','offline');
s.appendMessage({role:'user',content:'  const divider = "│";\n\n├─ real tree\nx ─ y',timestamp:Date.now()});
s.appendMessage({role:'assistant',content:[{type:'text',text:'Fixture response. No model request was made.'}],
 api:'openai-completions',provider:'selection-fixture',model:'offline',timestamp:Date.now(),stopReason:'stop',
 usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
console.log(s.getSessionFile());
