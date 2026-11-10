import { spawn } from 'node:child_process';
import { Store, type Worker, type Row } from './store.ts';
import { scheduleAllowed,routeAllowed } from './teams.ts';
import { Usage } from './usage.ts';
import { Intake } from './intake.ts';
import { Automation, type AutomationConfig } from './automation.ts';
export type Config = { teams?:import('./teams.ts').Team[]; port:number; database:string; tokenFile:string; enabled:boolean; intake?:{enabled:boolean}; usage?:{enabled:boolean;intervalMs?:number}; command?:string[]; timeoutMs?:number; concurrency:number; coordinator?:Worker; workers:Worker[]; notifications?:{command:string[]}; automation?:AutomationConfig; };
export interface Transport { invoke(input:Row):Promise<Row>; }
export class CommandTransport implements Transport {
 command:string[]; timeoutMs:number;
 constructor(command:string[],timeoutMs=1800000){this.command=command;this.timeoutMs=timeoutMs;}
 invoke(input:Row):Promise<Row>{return new Promise((resolve,reject)=>{
  const child=spawn(this.command[0],this.command.slice(1),{stdio:['pipe','pipe','pipe'],shell:false});let stdout='',stderr='',settled=false;
  const finish=(error?:Error,result?:Row)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result!);};
  const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error('Adapter timed out; original execution may still be running'));},this.timeoutMs);timer.unref();
  child.stdout.on('data',b=>{stdout+=b;if(stdout.length>2_000_000){child.kill();finish(new Error('Adapter response too large'));}});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
  child.on('error',e=>finish(e));child.stdin.on('error',e=>finish(e));child.on('close',code=>{if(code!==0)return finish(new Error(`Adapter exited ${code}: ${stderr}`));try{finish(undefined,JSON.parse(stdout));}catch{finish(new Error('Adapter returned invalid JSON; inspect execution before retry'));}});child.stdin.end(JSON.stringify(input));
 });}
}
export class Runtime {
 store:Store;config:Config;transport?:Transport;busy=new Set<string>();enabled:boolean;interval?:ReturnType<typeof setInterval>;ticking=false;automation?:Automation;intake?:Intake;intakeBusy=false;usage:Usage;usageBusy=false;lastUsageSweep=0;
 constructor(store:Store,config:Config,transport?:Transport){this.store=store;this.config=config;store.canSchedule=id=>scheduleAllowed(store,config,id);store.canRoute=m=>routeAllowed(store,config,m);this.usage=new Usage(store,[...(config.coordinator?[config.coordinator]:[]),...config.workers,...(config.automation?[config.automation.verifier]:[])],config.coordinator);this.automation=config.automation?new Automation(store,config.automation,config.workers):undefined;this.intake=config.intake?.enabled&&config.coordinator?new Intake(store,config.coordinator):undefined;this.enabled=store.one('SELECT enabled FROM scheduler_controls WHERE scope=?','global')?.enabled===undefined?config.enabled:store.one('SELECT enabled FROM scheduler_controls WHERE scope=?','global')!.enabled===1;this.transport=transport||(config.command?.length?new CommandTransport(config.command,config.timeoutMs):undefined);}
 start(){this.interval=setInterval(()=>void this.tick(),1000);void this.tick();}
 stop(){if(this.interval)clearInterval(this.interval);this.enabled=false;}
 async tick(){if(this.ticking)return;this.ticking=true;try{
  if(this.enabled){for(const run of this.store.all("SELECT x.* FROM runs x JOIN requirements r ON r.id=x.requirement_id WHERE x.kind='analyze' AND x.state='review' AND r.state!='paused'")){try{this.store.proposal(run.id,run.dispatch_token,JSON.parse(run.output_summary));}catch(e){this.store.analysisFailure(run.id,run.dispatch_token,String(e),false);}}}
  if(this.enabled&&this.intake&&this.transport&&!this.intakeBusy&&this.busy.size<this.config.concurrency){const incoming=this.intake.claim();if(incoming){this.intakeBusy=true;this.busy.add(incoming.run_id);void this.route(incoming);}}
  if(this.enabled){this.automation?.resumeDeferred();if(!this.intakeBusy)this.automation?.advance();}
  if(this.enabled&&this.transport){for(const run of this.store.all("SELECT x.* FROM runs x JOIN requirements r ON r.id=x.requirement_id WHERE x.state='waiting' AND x.heartbeat_at<? AND r.state NOT IN ('paused','cancelled','completed')",Date.now()-15000)){if(this.busy.size>=this.config.concurrency)break;if(this.store.canSchedule(run.requirement_id)&&!this.busy.has(run.id)){this.busy.add(run.id);void this.execute(run);}}}
  if(this.enabled&&this.transport){while(this.busy.size<this.config.concurrency){const run=(!this.intakeBusy?this.automation?.claim():undefined)||(!this.intakeBusy&&this.config.coordinator?this.store.claimAnalysis(this.config.coordinator):undefined)||this.store.claim(this.config.workers.filter(w=>!this.intakeBusy||w.threadId!==this.config.coordinator?.threadId));if(!run)break;this.busy.add(run.id);void this.execute(run);}}
  if(this.config.usage?.enabled&&this.config.command?.length&&!this.usageBusy&&Date.now()-this.lastUsageSweep>=(this.config.usage.intervalMs||30000)){this.lastUsageSweep=Date.now();void this.collectUsage();}
  await this.deliver();
 }catch(e){console.error('Workflow scheduler:',e);}finally{this.ticking=false;}}
 async collectUsage(){this.usageBusy=true;try{const targets=this.usage.due();if(!targets.length)return;const output=await new CommandTransport(this.config.command!,120000).invoke({kind:'usage',targets});for(const result of output.records||[]){const target=targets.find(t=>t.invocation_id===result.invocation_id);if(target)this.usage.record(target,result);}}catch{console.error('Token usage collection unavailable; retained as uncollected');}finally{this.usageBusy=false;}}
 async route(incoming:Row){try{const output=Intake.isGreeting(incoming.payload.message.content)?{intent:'ignore',reason:'仅问候，没有提出需求',reply:'你好，你可以继续补充想法或需求。'}:await this.transport!.invoke({...incoming,policy:this.config.automation?.projects[incoming.project_key]});if(output.waiting===true){this.store.write("UPDATE messages SET state='pending_intake',processed_at=? WHERE id=?",Date.now()+15000,incoming.id);return;}this.intake!.apply(incoming.id,output);}catch(e){this.intake!.fail(incoming.id,String(e));}finally{this.intakeBusy=false;this.busy.delete(incoming.run_id);}}
 async execute(run:Row){const worker=run.kind.startsWith('verify_')?this.config.automation?.verifier:run.kind==='analyze'?this.config.coordinator:this.config.workers.find(w=>w.key===run.worker_key);let heartbeat:ReturnType<typeof setInterval>|undefined;
  try{this.store.started(run.id,run.dispatch_token);heartbeat=setInterval(()=>{try{this.store.started(run.id,run.dispatch_token);}catch{}},5000);
   const policy=this.config.automation?.projects[this.store.requirement(run.requirement_id).project_key];
   const output=await this.transport!.invoke({policy,kind:run.kind,run_id:run.id,dispatch_token:run.dispatch_token,worker,payload:{...JSON.parse(run.input_json),resource_catalog:policy?.resources||[],available_workers:this.config.workers.map(w=>({key:w.key,role:w.role,projects:w.projects}))}});
   if(output.waiting===true){this.store.waitForWorker(run.id,run.dispatch_token,String(output.reason||'Target session busy'));return;}
   if(run.kind.startsWith('verify_'))this.automation!.finish(run.id,run.dispatch_token,output);
   else if(run.kind==='analyze'){this.store.proposal(run.id,run.dispatch_token,output);}
   else {this.store.report(run.id,run.dispatch_token,{outcome:output.outcome||'completed',summary:output.summary,evidence:output.evidence||[]});if(output.outcome&&output.outcome!=='completed'&&this.automation)this.automation.notice(run.requirement_id,'attention','任务需要核对：'+output.summary);}
  }catch(e){const error=String(e);if(run.kind.startsWith('verify_')){try{this.automation!.failed(run.id,run.dispatch_token,error);}catch{}}
   else if(run.kind==='analyze'){try{this.store.analysisFailure(run.id,run.dispatch_token,error);}catch{}}
   else{try{this.store.report(run.id,run.dispatch_token,{outcome:'uncertain',summary:error,evidence:[]});this.automation?.notice(run.requirement_id,'attention','执行状态待核对：'+error);}catch{}}
  }finally{if(heartbeat)clearInterval(heartbeat);this.busy.delete(run.id);}}
 async deliver(){
  // Only one local runtime owns the outbox. Stable IDs are reused on retry.
  for(const n of this.store.all("SELECT * FROM outbox WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT 10",Date.now())){
   if(n.source==='codex'){this.store.write("UPDATE outbox SET state='available' WHERE id=?",n.id);continue;}
   if(!this.config.notifications?.command?.length)continue;
   this.store.write("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'",n.id);
   try{await new CommandTransport(this.config.notifications.command,30000).invoke({kind:'notify',notification:{...n,destination:JSON.parse(n.destination_json)}});this.store.write("UPDATE outbox SET state='sent',sent_at=?,error=NULL WHERE id=?",Date.now(),n.id);}
   catch(e){const attempts=n.attempts+1;this.store.write('UPDATE outbox SET state=?,next_attempt_at=?,error=? WHERE id=?',attempts>=20?'failed':'pending',Date.now()+Math.min(300000,1000*2**attempts),String(e),n.id);}
  }
 }
}
