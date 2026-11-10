import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {application} from '../server.ts';import {teamBoard} from '../teams.ts';
test('workflow off persists per team, rejects new registration, preserves retries and existing work, and allows one-request bypass',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workflow-mode-'));const config={port:0,database:join(dir,'db'),tokenFile:join(dir,'token'),enabled:false,concurrency:1,workers:[],teams:[{key:'a',name:'A',projects:['demo'],entries:[{source:'codex',conversationId:'a'}]},{key:'b',name:'B',projects:['demo'],entries:[{source:'codex',conversationId:'b'}]}]};
 const app=application(config);await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));const port=(app.server.address() as {port:number}).port;
 const post=async(path:string,value:unknown)=>{const r=await fetch(`http://127.0.0.1:${port}/api/`+path,{method:'POST',headers:{authorization:'Bearer '+app.token,'content-type':'application/json'},body:JSON.stringify(value)});return {status:r.status,body:await r.json() as any};};
 const msg={source:'codex',source_message_id:'original',conversation_id:'a',sender_id:'user',project_key:'demo',content:'Implement feature'};
 try{
  const original=await post('messages',msg);assert.equal(original.status,200);const id=original.body.message.requirement_id;
  assert.equal((await post('teams/a/workflow',{enabled:false})).status,200);
  assert.equal(app.store.canSchedule(id),false);assert.equal(app.store.canRoute({source:'codex',conversation_id:'a',metadata_json:'{"_project_key":"demo"}'}),false);
  assert.equal((await post('messages',{...msg,source_message_id:'new'})).status,409);
  const replay=await post('messages',msg);assert.equal(replay.body.message.id,original.body.message.id);assert.equal(replay.body.duplicate,true);
  const bypass=await post('messages',{...msg,source_message_id:'bypass',workflow:false});assert.equal(bypass.body.mode,'direct');assert.equal(app.store.all('SELECT * FROM messages').length,1);
  assert.equal((await post('messages',{...msg,conversation_id:'b',source_message_id:'other'})).status,200);
  assert.equal(app.store.requirement(id).state,'pending');assert.equal(app.runtime.enabled,false);assert.equal(app.store.one('SELECT enabled FROM scheduler_controls WHERE scope=?','workflow:a')?.enabled,0);
  assert.equal(teamBoard(app.store,config,'a',[]).teams.find(t=>t.key==='a')!.workflowEnabled,false);
  assert.equal((await post('teams/a/workflow',{enabled:'yes'})).status,400);
  await post('teams/a/runtime',{enabled:false});await post('teams/a/workflow',{enabled:true});assert.equal(app.store.canSchedule(id),false,'workflow enable must retain team pause');
  await post('teams/a/runtime',{enabled:true});assert.equal(app.store.canSchedule(id),true);
 }finally{await new Promise<void>(r=>app.server.close(()=>r()));app.store.close();rmSync(dir,{recursive:true,force:true});}
});
