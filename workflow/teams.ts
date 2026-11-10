import type { Store, Row } from './store.ts';
import { WorkflowError } from './store.ts';
import type { Config } from './runtime.ts';
export type Team = {key:string;name:string;projects:string[];entries:{source:string;conversationId:string}[];connected?:boolean};
export function teamList(config:Config):Team[] {
 return config.teams ?? [{key:'default',name:'当前团队',projects:[...new Set([...(config.coordinator?.projects||[]),...config.workers.flatMap(w=>w.projects)])],entries:[]}];
}
export function validateTeams(teams:Team[]) {
 if(!Array.isArray(teams)||new Set(teams.map(t=>t.key)).size!==teams.length)throw new Error('Invalid or duplicate team keys');
 for(const t of teams)if(!t.key||['all','unassigned'].includes(t.key)||!t.name||!Array.isArray(t.projects)||t.projects.some(p=>typeof p!=='string'||!p)||!Array.isArray(t.entries)||t.entries.some(e=>!e.source||!e.conversationId)||t.connected!==undefined&&typeof t.connected!=='boolean')throw new Error('Invalid team mapping');
}
export function teamBoard(store:Store,config:Config,key:string,intake:Row[]) {
 const teams=teamList(config),team=key==='all'?undefined:teams.find(t=>t.key===key);
 if(key!=='all'&&!team)throw new WorkflowError('Unknown team',400);
 const matches=(m:Row,project:string)=>!team||(team.connected!==false&&(team.projects.length===0||team.projects.includes(project))&&(team.entries.length===0||team.entries.some(e=>e.source===m.source&&e.conversationId===m.conversation_id)));
 const ownership=(messages:Row[],project:string)=>teams.filter(t=>t.connected!==false&&messages.some(m=>belongs(t,m,project))).map(t=>({key:t.key,name:t.name}));
 const requirements=store.board().map((r):Row=>({...r,teams:ownership(store.all('SELECT source,conversation_id FROM messages WHERE requirement_id=?',r.id),r.project_key)})).filter(r=>!team||store.all('SELECT source,conversation_id FROM messages WHERE requirement_id=?',r.id).some(m=>matches(m,r.project_key)));
 const ids=new Set(requirements.map(r=>r.id));
 const filtered=intake.filter(m=>m.requirement_id?ids.has(m.requirement_id):matches(m,JSON.parse(m.metadata_json||'{}')._project_key));
 return {teams:teams.map(t=>({key:t.key,name:t.name,connected:t.connected!==false,enabled:!teamPaused(store,t.key),workflowEnabled:workflowEnabled(store,t.key)})),selectedTeam:key,teamNotice:team?.connected===false?'该团队尚未接入新工作流，旧台账数据尚未迁移。':team&&!workflowEnabled(store,team.key)?'工作流已关闭；若 Bridge 正在运行，飞书新消息会直接进入团队绑定的 Codex 聊天。已登记任务和结果仍保留。':null,requirements,intake:filtered.map(m=>({...m,teams:ownership([m],JSON.parse(m.metadata_json||'{}')._project_key),candidates:(m.candidates||[]).filter((r:Row)=>ids.has(r.id))}))};
}
export function teamPaused(store:Store,key:string):boolean {return store.one('SELECT enabled FROM scheduler_controls WHERE scope=?','team:'+key)?.enabled===0;}
export function scheduleAllowed(store:Store,config:Config,id:string):boolean {
 const r=store.requirement(id),messages=store.all('SELECT source,conversation_id FROM messages WHERE requirement_id=?',id);
 return !teamList(config).some(t=>(!workflowEnabled(store,t.key)||teamPaused(store,t.key))&&messages.some(m=>belongs(t,m,r.project_key)));
}
function belongs(t:Team,m:Row,project:string):boolean{return (t.projects.length===0||t.projects.includes(project))&&(t.entries.length===0||t.entries.some(e=>e.source===m.source&&e.conversationId===m.conversation_id));}
export function routeAllowed(store:Store,config:Config,m:Row):boolean {const project=JSON.parse(m.metadata_json||'{}')._project_key;return !teamList(config).some(t=>(!workflowEnabled(store,t.key)||teamPaused(store,t.key))&&belongs(t,m,project));}

export function workflowEnabled(store:Store,key:string):boolean{return store.one('SELECT enabled FROM scheduler_controls WHERE scope=?','workflow:'+key)?.enabled!==0;}
export function inputWorkflowEnabled(store:Store,config:Config,input:Row):boolean{return !teamList(config).some(t=>!workflowEnabled(store,t.key)&&belongs(t,{source:input.source,conversation_id:input.conversation_id},input.project_key));}
