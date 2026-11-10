import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { Store, type Row, type Worker, required, strings, WorkflowError } from './store.ts';
export type ProjectPolicy={root:string;authorization:string;allowedSources:string[];resources:string[];maxTasks:number;maxAttempts:number;authorizedAfter:number};
export type AutomationConfig={projects:Record<string,ProjectPolicy>;verifier:Worker};
const id=()=>`X-${randomUUID().slice(0,12)}`;
// Prior run inputs contain earlier verification snapshots. Never nest them again.
export function verificationSnapshot(detail:Row):Row {
 const {events,notifications,...context}=detail;
 return {...context,runs:detail.runs.map(({input_json,dispatch_token,...run}:Row)=>run)};
}
export class Automation {
 store:Store;config:AutomationConfig;workers:Worker[];
 constructor(store:Store,config:AutomationConfig,workers:Worker[]=[]){this.store=store;this.config=config;this.workers=workers;}
 policy(r:Row):ProjectPolicy|undefined{const p=this.config.projects[r.project_key];if(!p?.authorization||!p.root||r.created_at<p.authorizedAfter)return;const sources=this.store.all('SELECT source FROM messages WHERE requirement_id=?',r.id);if(!sources.length||sources.some(m=>!p.allowedSources.includes(m.source)))return;return p;}
 attention(req:string,message:string){this.store.write("UPDATE requirements SET state='blocked',updated_at=? WHERE id=?",Date.now(),req);this.store.event(req,'automation.blocked',{message});this.notice(req,'attention',message);}
 notice(req:string,purpose:string,message:string){for(const m of this.store.all("SELECT * FROM messages WHERE requirement_id=? AND state!='context' ORDER BY received_at",req)){const key=`${req}:${purpose}:${m.source}:${m.conversation_id}`;this.store.write("INSERT OR IGNORE INTO outbox(id,requirement_id,source,destination_json,reply_to_message_id,purpose,content,state,dedupe_key,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)",`N-${randomUUID().slice(0,12)}`,req,m.source,JSON.stringify({conversation_id:m.conversation_id}),m.source_message_id,purpose,message,key,Date.now(),Date.now());}}
 advance(){for(const r of this.store.all("SELECT * FROM requirements WHERE archived_at IS NULL AND stage='planning' AND state IN ('pending','awaiting_approval','blocked')")){const p=this.policy(r);if(!this.store.canSchedule(r.id)||!p)continue;
  const tasks=this.store.all('SELECT * FROM tasks WHERE requirement_id=?',r.id);
  const corrections:{task_id:string;file_references:string[]}[]=[];
  for(const t of tasks){const refs=JSON.parse(t.resources_json) as string[];const files=refs.filter(x=>!p.resources.includes(x));
   if(!files.length||!p.resources.length||!existsSync(p.root))continue;
   const root=realpathSync(p.root);const safe=files.every(x=>{if(x.includes(':'))return false;const candidate=resolve(root,x);if(!existsSync(candidate))return false;const rel=relative(root,realpathSync(candidate));return rel!==''&&rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);});
   if(safe){corrections.push({task_id:t.id,file_references:files});t.resources_json=JSON.stringify([...new Set([...refs.filter(x=>p.resources.includes(x)),...p.resources])]);}
  }
  if(corrections.length)this.store.tx(()=>{for(const t of tasks)this.store.write('UPDATE tasks SET resources_json=? WHERE id=?',t.resources_json,t.id);this.store.event(r.id,'plan.resource_references_normalized',{corrections});});
  if(r.state==='blocked'){const last=this.store.one("SELECT payload_json FROM events WHERE requirement_id=? AND type='automation.blocked' ORDER BY id DESC LIMIT 1",r.id);if(!corrections.length||!last||JSON.parse(last.payload_json).message!=='计划超出已授权任务数量或资源范围，请核对。')continue;this.store.write("UPDATE requirements SET state='awaiting_approval',updated_at=? WHERE id=?",Date.now(),r.id);r.state='awaiting_approval';}
  const questions=JSON.parse(r.analysis_json).questions||[];if(questions.length){this.attention(r.id,'需求需要补充：\n'+questions.join('\n'));continue;}
  const analysis=JSON.parse(r.analysis_json);if(analysis.requires_approval){this.attention(r.id,'该需求超出自动本地研发范围，请在主会话确认。');continue;}
  if(r.state!=='awaiting_approval')continue;
  if(this.workers.length&&tasks.some(t=>!this.workers.some(w=>w.key===t.preferred_worker_key&&w.projects.includes(r.project_key)))){this.attention(r.id,'任务尚未绑定正确的项目执行会话。');continue;}
  if(tasks.length>p.maxTasks||tasks.some(t=>JSON.parse(t.resources_json).some((x:string)=>!p.resources.includes(x)))){this.attention(r.id,'计划超出已授权任务数量或资源范围，请核对。');continue;}
  this.store.tx(()=>{this.store.approve(r.id,r.revision);this.store.event(r.id,'plan.auto_approved',{authorization:p.authorization,revision:r.revision});});
 }}
 claim():Row|undefined{return this.store.tx(()=>{
  const s=this.store,v=this.config.verifier;
  if(s.one('SELECT run_id FROM resource_locks WHERE resource_key=?',`thread:${v.threadId}`))return;
  const candidates=s.all("SELECT * FROM requirements WHERE archived_at IS NULL AND state IN ('running','awaiting_review') AND stage IN ('execution','verification') ORDER BY updated_at");
  for(const r of candidates){const p=this.policy(r);if(!s.canSchedule(r.id)||!p||!v.projects.includes(r.project_key))continue;
   let task:Row|undefined,original:Row|undefined;
   for(const t of s.all("SELECT * FROM tasks WHERE requirement_id=? AND state='review' ORDER BY queue_order",r.id)){const run=s.one("SELECT * FROM runs WHERE task_id=? AND kind='execute' ORDER BY attempt DESC LIMIT 1",t.id);if(!run||run.state!=='review'||s.one("SELECT id FROM runs WHERE task_id=? AND kind='verify_task' AND state IN ('prepared','running','needs_review')",t.id))continue;task=t;original=run;break;}
   const overall=!task&&r.stage==='verification'&&r.state==='awaiting_review';if(!task&&!overall)continue;
   if(overall&&s.hasActive(r.id))continue;
   const resources=[...new Set([`thread:${v.threadId}`,...p.resources])];if(resources.some(x=>s.one('SELECT run_id FROM resource_locks WHERE resource_key=?',x)))continue;
   const context=verificationSnapshot(s.detail(r.id));
   const kind=task?'verify_task':'verify_requirement',runId=id(),token=randomUUID();const payload={requirement:context,task:task||null,execution:original?context.runs.find((x:Row)=>x.id===original!.id):null,policy:{root:p.root,authorization:p.authorization,scope:'local-development-only'},instruction:'Independently inspect the actual files and run relevant non-destructive checks. Do not edit implementation, deploy, send messages, or accept developer assertions without evidence. Return ONLY JSON {verdict:"accepted"|"changes_requested",comment:string,evidence:string[]}. For an overall review verify the integrated requirement. Unclear or unavailable evidence means changes_requested.'};
   s.write("INSERT INTO runs(id,requirement_id,task_id,kind,worker_key,attempt,state,dispatch_token,input_json,prepared_at,created_at) VALUES(?,?,?,?,?,1,'prepared',?,?,?,?)",runId,r.id,task?.id||null,kind,v.key,token,JSON.stringify(payload),Date.now(),Date.now());
   for(const key of resources)s.write('INSERT INTO resource_locks VALUES(?,?,?,?,?)',key,runId,Date.now(),Date.now(),'Verification');s.event(r.id,'verification.started',{kind},task?.id||null,runId);return s.one('SELECT * FROM runs WHERE id=?',runId);
  }
 });}
 finish(runId:string,token:string,output:Row){return this.store.tx(()=>{const s=this.store,run=s.run(runId,token);if(!['verify_task','verify_requirement'].includes(run.kind)||!['prepared','running','needs_review','deferred'].includes(run.state))throw new WorkflowError('Verification is not active');if(run.state==='needs_review')required(output.reconciliation_evidence,'reconciliation_evidence');const r=s.requirement(run.requirement_id);const p=this.policy(r);if(!p)throw new WorkflowError('Automatic verification authorization unavailable');
  const verdict=output.verdict;if(!['accepted','changes_requested'].includes(verdict))throw new WorkflowError('Invalid verification verdict',400);const evidence=strings(output.evidence,'evidence');if(!evidence.length)throw new WorkflowError('Verification evidence required');const comment=required(output.comment,'comment');
  if(r.state==='paused'){s.write("UPDATE runs SET state='deferred',output_summary=?,evidence_json=?,finished_at=? WHERE id=?",JSON.stringify(output),JSON.stringify(evidence),Date.now(),run.id);s.write('DELETE FROM resource_locks WHERE run_id=?',run.id);s.event(r.id,'verification.deferred',{},run.task_id,run.id);return;}
  const input=JSON.parse(run.input_json);if(input.requirement.revision!==r.revision)throw new WorkflowError('Verification for stale requirement revision');
  if(run.task_id){const original=s.one("SELECT * FROM runs WHERE task_id=? AND kind='execute' ORDER BY attempt DESC LIMIT 1",run.task_id);if(original?.id!==input.execution.id||s.task(run.task_id).state!=='review')throw new WorkflowError('Verification for stale execution');}
  s.write("UPDATE runs SET state='completed',output_summary=?,evidence_json=?,finished_at=? WHERE id=?",JSON.stringify(output),JSON.stringify(evidence),Date.now(),run.id);s.write('DELETE FROM resource_locks WHERE run_id=?',run.id);
  if(run.task_id){s.review({requirement_id:r.id,task_id:run.task_id,run_id:input.execution.id,reviewer:`verifier:${run.worker_key}`,verdict,evidence,comment});if(verdict==='changes_requested'&&input.execution.attempt>=p.maxAttempts){s.write("UPDATE tasks SET state='failed' WHERE id=?",run.task_id);this.attention(r.id,'任务返修达到上限：'+comment);}}
  else if(verdict==='accepted')s.review({requirement_id:r.id,reviewer:`verifier:${run.worker_key}`,verdict,evidence,comment});else this.attention(r.id,'整体验收未通过：'+comment);
  s.event(r.id,'verification.completed',{verdict},run.task_id,run.id);
 });}
 failed(runId:string,token:string,message:string){return this.store.tx(()=>{const s=this.store,run=s.run(runId,token);if(!['prepared','running','deferred'].includes(run.state))return;s.write("UPDATE runs SET state='needs_review',error=? WHERE id=?",message,run.id);this.attention(run.requirement_id,'验证状态待核对：'+message);s.event(run.requirement_id,'verification.uncertain',{},run.task_id,run.id);});}
 resumeDeferred(){for(const run of this.store.all("SELECT x.* FROM runs x JOIN requirements r ON r.id=x.requirement_id WHERE x.kind LIKE 'verify_%' AND x.state='deferred' AND r.state!='paused'")){try{this.finish(run.id,run.dispatch_token,JSON.parse(run.output_summary));}catch(e){this.failed(run.id,run.dispatch_token,String(e));}}}
}
