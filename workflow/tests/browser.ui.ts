/** Optional browser verification: PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser.ui.ts */
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import assert from 'node:assert/strict';
import { application } from '../server.ts';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=mkdtempSync(join(tmpdir(),'workflow-browser-'));const app=application({port:0,database:join(dir,'db'),tokenFile:join(dir,'token'),enabled:false,intake:{enabled:true},coordinator:{key:'coordinator',threadId:'coordinator',projects:['demo']},concurrency:2,workers:[]});
const criteria=['请求符合预期','错误情况有明确反馈'];
for(let i=0;i<6;i++){
 const id=app.store.ingest({source:'codex',source_message_id:String(i),conversation_id:'main',sender_id:'user',content:['搜索历史任务','任务失败提醒','项目筛选','导出任务报告','减少排队提示','任务编号展示'][i],project_key:'demo'}).message!.requirement_id;
 if(i===0)continue;
 app.store.analysis(id,{revision:1,title:app.store.requirement(id).title,goal:'实现独立交付结果',scope:'本地代码',acceptance:criteria,questions:i===1?['确认通知渠道']:[]});
 if(i===1){app.store.write("UPDATE requirements SET stage='analysis',state='awaiting_approval' WHERE id=?",id);continue;}
 app.store.plan(id,{revision:2,tasks:[{key:'main',title:'实现接口',deliverable:'可调用并经过验证的接口',acceptance:criteria}]});if(i===2)continue;
 app.store.approve(id,3);const run=app.store.claim([{key:'demo',threadId:'demo-'+i,projects:['demo']}])!;
 if(i===3)continue;
 app.store.report(run.id,run.dispatch_token,{outcome:'completed',summary:'接口实现完成',evidence:['合成测试通过']});app.store.review({requirement_id:id,task_id:run.task_id,run_id:run.id,reviewer:'reviewer',verdict:'accepted',evidence:['验证返回内容'],comment:'符合验收'});
 if(i===5)app.store.review({requirement_id:id,reviewer:'reviewer',verdict:'accepted',evidence:['集成检查完成'],comment:'整体需求通过'});
}
const usageRequirement=app.store.board().find(r=>r.title==='任务编号展示')!;const usageTarget=app.runtime.usage.targets(usageRequirement.id)[0];app.runtime.usage.record(usageTarget,{invocation_id:usageTarget.invocation_id,thread_id:usageTarget.thread_id,turn_id:'synthetic-usage-turn',source:'codex_rollout',model:'test-model',status:'observed',finished:true,usage:{input_tokens:1200,output_tokens:45,cached_input_tokens:1000,reasoning_output_tokens:15,cache_write_input_tokens:0,total_tokens:1245}});
await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));const port=(app.server.address() as {port:number}).port;
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(e.message));page.on('console',(m:any)=>{if(m.type()==='error'&&/Content Security Policy|Refused to apply|violates/.test(m.text()))errors.push(m.text());});
try{
 await page.goto(`http://127.0.0.1:${port}`);await page.locator('.task').first().waitFor();assert.equal(await page.locator('.lane').count(),6);await page.getByText('1,245 token',{exact:true}).waitFor();
 assert.equal(await page.locator('textarea').count(),0);
 const y=await page.locator('.lane').evaluateAll((nodes:any[])=>nodes.map(n=>Math.round(n.getBoundingClientRect().top)));assert.equal(new Set(y).size,1);
 const out=resolve(process.env.WORKFLOW_SCREENSHOTS||'/tmp/workflow-screenshots');mkdirSync(out,{recursive:true});await page.screenshot({path:join(out,'desktop.png'),fullPage:true});
 await page.getByRole('tab',{name:/待我处理/}).click();assert.equal(await page.locator('.task:visible').count(),3);await page.getByRole('tab',{name:'全部',exact:true}).click();
 await page.getByRole('button',{name:/搜索历史任务/}).click();await page.getByRole('dialog').waitFor();await page.locator('#detail .details-grid').waitFor();assert.equal(await page.evaluate(()=>document.querySelector('#detail-modal')!.getAttribute('role')==='dialog'),true);await page.screenshot({path:join(out,'modal-desktop.png'),fullPage:false,animations:'disabled'});await page.getByText('需求分析',{exact:true}).last().click();const form=page.locator('#detail form').first();await form.locator('[name="goal"]').fill('可按项目查询历史任务');await form.locator('[name="scope"]').fill('本地查询');await form.locator('[name="acceptance"]').fill('按项目返回正确结果');await form.getByRole('button',{name:'保存分析'}).click();await page.getByText('任务计划',{exact:true}).click();const plan=page.locator('#detail form').last();await plan.locator('[name="title"]').fill('查询接口');await plan.locator('[name="deliverable"]').fill('按项目返回任务列表');await plan.locator('[name="acceptance"]').fill('项目隔离正确');await plan.getByRole('button',{name:'保存计划'}).click();await page.getByRole('button',{name:'确认计划',exact:true}).click();await page.getByText('任务计划',{exact:true}).waitFor({state:'detached'});
 assert.equal(app.store.board().find(r=>r.title==='搜索历史任务')!.stage,'execution');
 await page.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await page.locator('#detail').isVisible(),false);await page.waitForFunction(()=>document.activeElement?.textContent?.includes('搜索历史任务')&&document.activeElement?.classList.contains('task'));
 await page.getByRole('button',{name:/搜索历史任务/}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:/任务编号展示/}).click();await page.getByRole('dialog').waitFor();
 const history=page.locator('#detail details').filter({has:page.getByText('时间线',{exact:true})});await history.locator('summary').click();await page.locator('#detail').evaluate((node:any)=>{node.dataset.pollSentinel='kept';node.scrollTop=160;});const scrollBefore=await page.locator('#detail').evaluate((node:any)=>node.scrollTop);
 await page.waitForResponse((response:any)=>response.url().includes('/api/requirements/')&&response.request().method()==='GET');await page.waitForFunction(()=>document.querySelector('#detail')?.getAttribute('data-poll-sentinel')==='kept');assert.equal(await history.evaluate((node:any)=>node.open),true);assert.equal(await page.locator('#detail').evaluate((node:any)=>node.scrollTop),scrollBefore);
 const completed=app.store.board().find(r=>r.title==='任务编号展示')!;app.store.write('UPDATE requirements SET title=?,updated_at=? WHERE id=?','任务编号展示 · 已更新',Date.now()+1,completed.id);await page.waitForFunction(()=>document.querySelector('#detail-title')?.textContent==='任务编号展示 · 已更新');assert.equal(await history.evaluate((node:any)=>node.open),true);assert.equal(await page.locator('#detail').evaluate((node:any)=>node.scrollTop),scrollBefore);
 await page.mouse.click(4,4);await page.getByRole('dialog').waitFor({state:'hidden'});
 for(const width of [1024,390,320]){await page.setViewportSize({width,height:1000});await page.screenshot({path:join(out,`width-${width}.png`),fullPage:true});await page.getByRole('button',{name:/任务编号展示/}).click();await page.getByRole('dialog').waitFor();await page.screenshot({path:join(out,`modal-${width}.png`),fullPage:false,animations:'disabled'});const modalBounds=await page.getByRole('dialog').boundingBox();assert.ok(modalBounds&&modalBounds.x>=0&&modalBounds.x+modalBounds.width<=width);assert.ok(modalBounds&&modalBounds.y>=0&&modalBounds.y+modalBounds.height<=1001);await page.getByRole('button',{name:'关闭',exact:true}).click();const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.equal(overflow,false,`overflow at ${width}`);}
 const raw=app.store.ingest({source:'codex',source_message_id:'ambiguous',conversation_id:'main',sender_id:'human',content:'这个再改一下',project_key:'demo'},true).message!;const router=app.runtime.intake!;assert.equal(router.claim()!.id,raw.id);router.apply(raw.id,{intent:'clarify',reason:'缺少关联目标',question:'这是新需求还是补充已有需求？'});await page.getByRole('button',{name:/这个再改一下/}).waitFor();await page.getByRole('button',{name:/这个再改一下/}).click();await page.getByRole('dialog').waitFor();await page.getByText('这是新需求还是补充已有需求？',{exact:true}).waitFor();await page.getByRole('button',{name:'作为新需求',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(app.store.board().length,7);assert.ok(app.store.one('SELECT requirement_id FROM messages WHERE id=?',raw.id)!.requirement_id);
 assert.deepEqual(errors,[]);console.log('Browser passed: six columns, filter, analysis, plan, approval, modal close/Escape/backdrop/focus restore, polling preserves disclosure/scroll, 1440/1024/390/320 widths.');console.log(out);
}finally{await browser.close();await new Promise<void>(r=>app.server.close(()=>r()));app.store.close();rmSync(dir,{recursive:true,force:true});}
