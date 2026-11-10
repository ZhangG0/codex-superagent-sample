import { Store, type Row, type Worker, WorkflowError } from './store.ts';
import { Intake } from './intake.ts';
const fields=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'] as const;
const stages=['intake','analysis_planning','execution','verification'];
export class Usage {
 store:Store;workers:Worker[];coordinator?:Worker;
 constructor(store:Store,workers:Worker[],coordinator?:Worker){this.store=store;this.workers=workers;this.coordinator=coordinator;}
 targets(requirementId?:string,messageId?:string):Row[]{
  const runs=messageId?[]:this.store.all(`SELECT * FROM runs ${requirementId?'WHERE requirement_id=?':''}`, ...(requirementId?[requirementId]:[]));
  const messages=this.store.all(`SELECT * FROM messages ${messageId?'WHERE id=?':requirementId?'WHERE requirement_id=?':''}`, ...(messageId?[messageId]:requirementId?[requirementId]:[]));
  return [...runs.filter(r=>['analyze','execute','verify_task','verify_requirement'].includes(r.kind)).map(r=>({invocation_id:r.id,run_id:r.id,message_id:null,thread_id:this.workers.find(w=>w.key===r.worker_key)?.threadId||`unbound:${r.worker_key}`,host_turn_id:r.host_turn_id,stage:r.kind==='analyze'?'analysis_planning':r.kind==='execute'?'execution':'verification',kind:r.kind,attempt:r.attempt,title:r.task_id?this.store.task(r.task_id).title:'需求分析 / 验证',state:r.state})),...messages.filter(m=>JSON.parse(m.metadata_json)._project_key).map(m=>({invocation_id:`I-${m.id}`,message_id:m.id,run_id:null,thread_id:this.coordinator?.threadId||'unbound:intake',stage:'intake',kind:'intake',attempt:1,title:m.content.slice(0,60),state:m.state,rule:Intake.isGreeting(m.content)}))];
 }
 due(){return this.targets().filter(t=>{const old=this.store.one('SELECT * FROM token_usage WHERE invocation_id=?',t.invocation_id);return !old||!(old.status==='observed'&&old.finished)&&Date.now()-old.observed_at>(old.status==='missing'?300000:25000);});}
 record(target:Row,result:Row){return this.store.tx(()=>{
  if(result.invocation_id!==target.invocation_id||result.thread_id!==target.thread_id||!['observed','partial','missing'].includes(result.status))throw new WorkflowError('Invalid usage attribution',400);
  if(target.host_turn_id&&result.turn_id&&target.host_turn_id!==result.turn_id)throw new WorkflowError('Usage turn mismatch');
  const usage=result.usage||{};for(const key of fields)if(usage[key]!=null&&(!Number.isSafeInteger(usage[key])||usage[key]<0))throw new WorkflowError('Invalid token counter',400);
  if(result.status!=='missing'&&(!fields.filter(k=>['input_tokens','output_tokens','total_tokens'].includes(k)).every(k=>usage[k]!=null)||usage.total_tokens!==usage.input_tokens+usage.output_tokens))throw new WorkflowError('Invalid usage total',400);
  if(usage.cached_input_tokens>usage.input_tokens||usage.reasoning_output_tokens>usage.output_tokens)throw new WorkflowError('Invalid usage subset',400);
  if(result.source==='local_rule'&&!target.rule)throw new WorkflowError('Unexpected rule usage');
  if(result.status!=='missing'&&result.source!=='local_rule'&&!result.turn_id)throw new WorkflowError('Usage needs a correlated turn');
  const old=this.store.one('SELECT * FROM token_usage WHERE invocation_id=?',target.invocation_id);
  if(old?.status==='observed'&&result.status==='missing')return;
  const values=[target.invocation_id,target.run_id,target.message_id,target.thread_id,result.turn_id||null,target.stage,result.model||null,...fields.map(k=>usage[k]??null),result.status,result.finished?1:0,result.source,String(result.detail||'').slice(0,500)||null,Date.now()];
  this.store.write(`INSERT INTO token_usage VALUES(${values.map(()=>'?').join(',')}) ON CONFLICT(invocation_id) DO UPDATE SET turn_id=excluded.turn_id,model=excluded.model,input_tokens=excluded.input_tokens,cached_input_tokens=excluded.cached_input_tokens,cache_write_input_tokens=excluded.cache_write_input_tokens,output_tokens=excluded.output_tokens,reasoning_output_tokens=excluded.reasoning_output_tokens,total_tokens=excluded.total_tokens,status=excluded.status,finished=excluded.finished,source=excluded.source,detail=excluded.detail,observed_at=excluded.observed_at`,...values);
 });}
 summary(requirementId?:string,messageId?:string):Row{
  const rows=this.targets(requirementId,messageId).map(t=>({...t,...this.store.one('SELECT * FROM token_usage WHERE invocation_id=?',t.invocation_id)}));
  const aggregate=(items:Row[])=>{const known=items.filter(x=>x.status==='observed'||x.status==='partial');const complete=items.length>0&&items.every(x=>x.status==='observed'&&x.finished);return {status:complete?'complete':known.length?'partial':'missing',expected:items.length,collected:known.length,...Object.fromEntries(fields.map(k=>[k,known.some(x=>x[k]!=null)?known.reduce((n,x)=>n+(x[k]??0),0):null]))};};
  return {...aggregate(rows),stages:stages.map(stage=>({stage,...aggregate(rows.filter(x=>x.stage===stage))})),invocations:rows.map(x=>({...x,status:x.status||'missing'}))};
 }
}
