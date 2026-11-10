import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store, WorkflowError, type Row } from './store.ts';
import { teamBoard,validateTeams,teamList,inputWorkflowEnabled } from './teams.ts';
import { storagePaths } from './paths.ts';
import { Runtime, type Config, type Transport } from './runtime.ts';
export function loadConfig(path:string):Config {const raw=JSON.parse(readFileSync(path,'utf8')),base=dirname(resolve(path));const c={...raw,...storagePaths(raw,base)} as Config;
 if(!Number.isInteger(c.port)||c.port<0||c.port>65535||!Number.isInteger(c.concurrency)||c.concurrency<1||c.concurrency>8||typeof c.enabled!=='boolean'||!Array.isArray(c.workers))throw new Error('Invalid configuration');
 const workers=[...(c.coordinator?[c.coordinator]:[]),...c.workers];if(new Set(workers.map(w=>w.key)).size!==workers.length)throw new Error('Duplicate worker key');
 for(const w of workers)if(!w.key||!w.threadId||!Array.isArray(w.projects))throw new Error('Invalid worker binding');
 for(const command of [c.command,c.notifications?.command])if(command&&(!Array.isArray(command)||command.some(x=>typeof x!=='string'||!x)))throw new Error('Invalid adapter command');
 if(c.automation){const a=c.automation;if(!a.verifier?.threadId||!Array.isArray(a.verifier.projects)||c.workers.some(w=>w.threadId===a.verifier.threadId))throw new Error('Independent verifier thread required');
  for(const p of Object.values(a.projects)){if(!p.root||!p.authorization||!Array.isArray(p.allowedSources)||!Array.isArray(p.resources)||!Number.isInteger(p.maxTasks)||p.maxTasks<1||p.maxTasks>50||!Number.isInteger(p.maxAttempts)||p.maxAttempts<1||p.maxAttempts>3||!Number.isFinite(p.authorizedAfter))throw new Error('Invalid automatic local-development policy');}}
 if(c.usage&&(typeof c.usage.enabled!=='boolean'||(c.usage.intervalMs!==undefined&&(!Number.isInteger(c.usage.intervalMs)||c.usage.intervalMs<10000))))throw new Error('Invalid token usage configuration');
 if(c.intake&&(typeof c.intake.enabled!=='boolean'||(c.intake.enabled&&!c.coordinator)))throw new Error('Intake requires a coordinator');
 if(c.teams)validateTeams(c.teams);
 if(c.enabled&&!c.command?.length)throw new Error('Enabled runtime requires an adapter');return c;
}
function tokenAt(path:string){mkdirSync(dirname(path),{recursive:true,mode:0o700});if(!existsSync(path))writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});chmodSync(path,0o600);const token=readFileSync(path,'utf8').trim();if(token.length<32)throw new Error('Invalid local token');return token;}
async function body(req:IncomingMessage):Promise<Row>{let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>256000)throw new WorkflowError('Request too large',413);}try{const parsed=JSON.parse(text||'{}');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;}catch{throw new WorkflowError('Invalid JSON body',400);}}
export function application(config:Config,transport?:Transport){const store=new Store(config.database);store.recover();const runtime=new Runtime(store,config,transport),token=tokenAt(config.tokenFile);
 const json=(res:ServerResponse,status:number,data:any)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
 const server=createServer(async(req,res)=>{try{const address=server.address();const port=typeof address==='object'&&address?address.port:config.port;const host=`127.0.0.1:${port}`,origin=`http://${host}`;
  if(req.headers.host!==host)throw new WorkflowError('Invalid Host',403);
  if(req.headers.origin&&req.headers.origin!==origin)throw new WorkflowError('Cross-origin request denied',403);
  if(req.headers['sec-fetch-site']==='cross-site')throw new WorkflowError('Cross-site request denied',403);
  const url=new URL(req.url||'/',origin),path=url.pathname;
  if(req.method==='GET'&&(path==='/'||/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(path))){
   const nonce=randomBytes(16).toString('base64');const name=path==='/'?'index.html':path.slice(1);res.setHeader('content-type',path==='/'?'text/html; charset=utf-8':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('content-security-policy',`default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);if(path==='/')res.setHeader('set-cookie',`workflow=${token}; HttpOnly; SameSite=Strict; Path=/`);const asset=readFileSync(resolve(import.meta.dirname,process.env.WORKFLOW_PUBLIC_DIR||'frontend/dist',name));res.end(path==='/'?asset.toString('utf8').replace('</head>',`<meta name="csp-nonce" content="${nonce}"></head>`):asset);return;
  }
  const bearer=req.headers.authorization===`Bearer ${token}`,cookie=(req.headers.cookie||'').split(';').some(x=>x.trim()===`workflow=${token}`);
  if(!bearer&&!cookie)throw new WorkflowError('Local authentication required',401);
  // Cookies may read; browser writes must carry our same-origin intent header.
  if(!['GET','HEAD'].includes(req.method||'')&&!bearer&&req.headers['x-workflow-action']!=='1')throw new WorkflowError('Missing action header',403);
  if(req.method==='GET'){
   if(path==='/api/board'){const board=teamBoard(store,config,url.searchParams.get('team')||'all',runtime.intake?.pending()||[]);return json(res,200,{...board,requirements:board.requirements.map(r=>({...r,usage:runtime.usage.summary(r.id)})),runtime:{enabled:runtime.enabled,configured:!!runtime.transport,active:runtime.busy.size,concurrency:config.concurrency},workers:config.workers.map(w=>({key:w.key,projects:w.projects})),storage:{database:config.database},preview:false});}
   if(path==='/api/queue')return json(res,200,store.queue());
   if(path==='/api/events'){const after=Number(url.searchParams.get('after')||0);return json(res,200,store.all('SELECT * FROM events WHERE id>? ORDER BY id LIMIT 200',Number.isFinite(after)?after:0));}
   if(path==='/api/outbox')return json(res,200,store.all('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 100'));
   const match=path.match(/^\/api\/requirements\/([^/]+)$/);if(match)return json(res,200,{...store.detail(match[1]),usage:runtime.usage.summary(match[1])});
  }
  if(req.method==='POST'){
   const input=await body(req);
   if(path==='/api/messages'){
    // Stable replays must return their original receipt, even after switching modes.
    const existing=store.one('SELECT id FROM messages WHERE source=? AND conversation_id=? AND source_message_id=?',input.source??null,input.conversation_id??null,input.source_message_id??null);
    if(!existing&&input.workflow===false){if(input.source!=='codex'||input.requirement_id)throw new WorkflowError('Single-request bypass requires a new Codex request',400);return json(res,200,{mode:'direct',registered:false});}
    if(!existing&&!inputWorkflowEnabled(store,config,input))throw new WorkflowError('Workflow disabled for this team; use direct coordination. Ingress remains buffered.',409);
    return json(res,200,store.ingest(input,config.intake?.enabled===true));
   }
   let intakeMatch=path.match(/^\/api\/messages\/([^/]+)\/resolve$/);if(intakeMatch){if(!runtime.intake)throw new WorkflowError('Intake not enabled');return json(res,200,runtime.intake.apply(intakeMatch[1],{...input,reason:'用户在看板确认消息归属'},true));}
   intakeMatch=path.match(/^\/api\/requirements\/([^/]+)\/reanalyze$/);if(intakeMatch){if(!runtime.intake)throw new WorkflowError('Intake not enabled');return json(res,200,runtime.intake.reanalyze(intakeMatch[1]));}
   if(path==='/api/reviews')return json(res,200,store.review(input));
   const modeMatch=path.match(/^\/api\/teams\/([^/]+)\/workflow$/);if(modeMatch){const key=decodeURIComponent(modeMatch[1]);const team=teamList(config).find(t=>t.key===key);if(!team||team.connected===false)throw new WorkflowError('Team not connected',400);if(typeof input.enabled!=='boolean')throw new WorkflowError('enabled must be boolean',400);store.tx(()=>{store.write('INSERT INTO scheduler_controls VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at','workflow:'+key,input.enabled?1:0,Date.now());store.event(null,'team.workflow.changed',{team:key,enabled:input.enabled});});return json(res,200,{key,workflowEnabled:input.enabled});}
   const teamMatch=path.match(/^\/api\/teams\/([^/]+)\/runtime$/);if(teamMatch){const key=decodeURIComponent(teamMatch[1]);const team=teamList(config).find(t=>t.key===key);if(!team||team.connected===false)throw new WorkflowError('Team not connected',400);if(typeof input.enabled!=='boolean')throw new WorkflowError('enabled must be boolean',400);store.tx(()=>{store.write('INSERT INTO scheduler_controls VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at','team:'+key,input.enabled?1:0,Date.now());store.event(null,'team.runtime.changed',{team:key,enabled:input.enabled});});return json(res,200,{key,enabled:input.enabled});}
   if(path==='/api/runtime'){if(typeof input.enabled!=='boolean')throw new WorkflowError('enabled must be boolean',400);if(input.enabled&&!runtime.transport)throw new WorkflowError('Execution adapter not configured');store.write('INSERT INTO scheduler_controls VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at','global',input.enabled?1:0,Date.now());runtime.enabled=input.enabled;store.event(null,'runtime.changed',{enabled:input.enabled});return json(res,200,{enabled:runtime.enabled});}
   let match=path.match(/^\/api\/requirements\/([^/]+)\/(analysis|plan|approve|actions)$/);if(match){const [,id,action]=match;return json(res,200,action==='analysis'?store.analysis(id,input):action==='plan'?store.plan(id,input):action==='approve'?store.approve(id,input.revision):store.action(id,input.action));}
   match=path.match(/^\/api\/runs\/([^/]+)\/(started|report|proposal|verification)$/);if(match){const [,id,action]=match;return json(res,200,action==='verification'?(runtime.automation?.finish(id,input.dispatch_token,input)??{}):action==='started'?store.started(id,input.dispatch_token,input.host_turn_id):action==='proposal'?store.proposal(id,input.dispatch_token,input):store.report(id,input.dispatch_token,input));}
   if(path==='/api/claim'){const worker=config.workers.find(w=>w.key===input.worker_key);if(!worker)throw new WorkflowError('Unknown worker',400);if(!runtime.enabled)throw new WorkflowError('Dispatch paused');return json(res,200,store.claim([worker])||null);}
   match=path.match(/^\/api\/tasks\/([^/]+)\/reopen$/);if(match)return json(res,200,store.reopen(match[1],input));
   match=path.match(/^\/api\/outbox\/([^/]+)\/retry$/);if(match){const n=store.one('SELECT * FROM outbox WHERE id=?',match[1]);if(!n)throw new WorkflowError('Notification not found',404);if(n.state!=='failed')throw new WorkflowError('Only failed notification can be retried');store.write("UPDATE outbox SET state='pending',attempts=0,next_attempt_at=? WHERE id=?",Date.now(),n.id);return json(res,200,{id:n.id});}
  }
  throw new WorkflowError('Not found',404);
 }catch(e){json(res,e instanceof WorkflowError?e.status:500,{error:e instanceof WorkflowError?e.message:'Internal service error'});if(!(e instanceof WorkflowError))console.error(e);}});
 return {server,store,runtime,token};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const file=process.argv[2];if(!file)throw new Error('Usage: node workflow/server.ts /absolute/config.json');const config=loadConfig(file);
 mkdirSync(dirname(config.database),{recursive:true,mode:0o700});const lock=config.database+'.service.lock';
 const acquire=()=>{try{const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);}catch(e:any){if(e.code!=='EEXIST')throw e;const pid=Number(readFileSync(lock,'utf8'));if(!Number.isInteger(pid)||pid<=0)throw new Error('Inspect invalid service lock');try{process.kill(pid,0);}catch(error:any){if(error.code==='ESRCH'){unlinkSync(lock);return acquire();}throw error;}throw new Error('Workflow database already owned by a service');}};acquire();
 let app:ReturnType<typeof application>;try{app=application(config);}catch(e){unlinkSync(lock);throw e;}
 app.server.listen(config.port,'127.0.0.1',()=>{console.log(`Workflow http://127.0.0.1:${config.port}\nDatabase: ${config.database}`);app.runtime.start();});
 app.server.on('error',e=>{console.error(e);app.runtime.stop();app.store.close();unlinkSync(lock);process.exitCode=1;});
 const stop=()=>{app.runtime.stop();app.server.close(()=>{app.store.close();if(existsSync(lock))unlinkSync(lock);process.exit(0);});};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
