import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig, Ledger } from '../dispatch.ts';
test('native TS runtime: configuration is read-only; ledger protects state and releases claims', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-runtime-'));
    try {
        mkdirSync(join(root, 'demo'));
        mkdirSync(join(root, 'config'));
        const config = join(root, 'config/routing.json');
        writeFileSync(config, JSON.stringify({ version: 1, workspace_root: '..', state_path: '../state/ledger.sqlite3', resources: ['repo:demo'], projects: { demo: { path: 'demo', host_id: 'local', thread_id: 'target', resources: ['repo:demo'] } }, entries: { entry: { host_id: 'local', thread_id: 'caller', projects: ['demo'], scopes: ['local'], resources: ['repo:demo'] } } }));
        const parsed = readConfig(config);
        assert.equal(existsSync(parsed.state), false);
        const l = new Ledger(config, 'entry', 'local', 'caller');
        try {
            assert.equal(statSync(parsed.state).mode & 0o777, 0o600);
            assert.equal(statSync(join(root, 'state')).mode & 0o777, 0o700);
            const t = l.create('request', 'demo', 'synthetic test', 'local', 'synthetic authorization');
            l.contract(t.id, {request_id:'request',description:'test',acceptance:'checks pass',boundaries:'demo',next_action:'review'});
            const p = l.prepare(t.id);
            l.receipt(t.id, p.attempt!, 'synthetic receipt');
            l.progress(t.id, 'implemented', 'synthetic diff');
            l.progress(t.id, 'verified', 'synthetic checks');
            l.report(t.id,{attempt:p.attempt!,revision:1,host:'local',thread:'target',evidence:'checked response'});
            assert.equal(l.finish(t.id, 'synthetic acceptance').status, 'completed');
            assert.deepEqual(l.summary().locks, []);
        }
        finally {
            l.close();
        }
        const direct = spawnSync(process.execPath, ['dispatch.ts', '--config', config, 'check'], { encoding: 'utf8' });
        assert.equal(direct.status, 0);
        assert.equal(JSON.parse(direct.stdout).valid, true);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

function scenario(run: (l: Ledger, config: string) => void) {
    const root=mkdtempSync(join(tmpdir(),'dispatch-recovery-'));
    mkdirSync(join(root,'demo'));
    const config=join(root,'routing.json');
    writeFileSync(config,JSON.stringify({version:1,workspace_root:'.',state_path:'state/db.sqlite3',resources:['repo:demo'],projects:{demo:{path:'demo',host_id:'local',thread_id:'worker',resources:['repo:demo']}},entries:{entry:{host_id:'local',thread_id:'caller',projects:['demo'],scopes:['local','discussion'],resources:['repo:demo']}}}));
    const l=new Ledger(config,'entry','local','caller');
    try {run(l,config);} finally {l.close();rmSync(root,{recursive:true,force:true});}
}
function start(l: Ledger,key='request') {
    const t=l.create(key,'demo','repair','local','user request');
    assert.throws(()=>l.prepare(t.id),/contract/);
    l.contract(t.id,{request_id:key,description:'repair login',acceptance:'login passes',boundaries:'demo only',next_action:'verify then report'});
    const p=l.prepare(t.id);l.receipt(t.id,p.attempt!,'receipt');return l.get(t.id);
}
test('paused work retains claims, resumes and invalidates old verification on rework',()=>scenario(l=>{
    const t=start(l);
    for(const status of ['blocked','awaiting_input','failed']) {
        l.state(t.id,status,'reason');assert.equal(l.summary().locks.length,2);
        assert.throws(()=>l.progress(t.id,'implemented','diff'));
        assert.equal(l.recovery()[0].status,status);l.state(t.id,'running','resolved');
    }
    l.progress(t.id,'implemented','diff');l.progress(t.id,'verified','checks');
    const report={attempt:t.attempt!,revision:1,host:'local',thread:'worker',evidence:'matching result'};
    l.report(t.id,report);l.rework(t.id,'new edit invalidates checks');
    assert.equal(l.context(t.id)!.revision,2);assert.equal(l.context(t.id)!.report,null);
    assert.throws(()=>l.report(t.id,report));assert.throws(()=>l.finish(t.id,'old checks'));
    l.progress(t.id,'implemented','new diff');l.progress(t.id,'verified','new checks');
    assert.throws(()=>l.finish(t.id,'no correlated report'));
    for(const bad of [{attempt:'wrong'},{thread:'wrong'},{host:'wrong'}]) assert.throws(()=>l.report(t.id,{...report,revision:2,...bad}));
    l.report(t.id,{...report,revision:2});assert.equal(l.finish(t.id,'accepted').status,'completed');
}));
test('discussion can finish without dispatch and release no execution claims',()=>scenario(l=>{
    const t=l.create('discussion','demo','design','discussion','discuss');
    assert.throws(()=>l.prepare(t.id));assert.equal(l.finish(t.id,'decision recorded').status,'completed');
    assert.deepEqual(l.summary().locks,[]);
}));
test('revoked projects remain visible to owner for safe cancellation, never execution',()=>scenario((l,path)=>{
    const t=start(l);
    const config=JSON.parse(readFileSync(path,'utf8'));config.entries.entry.projects=[];writeFileSync(path,JSON.stringify(config));
    const fresh=new Ledger(path,'entry','local','caller');
    try {
        assert.equal(fresh.summary().tasks.length,1);assert.equal(fresh.recovery()[0].policy_allowed,false);
        assert.throws(()=>fresh.progress(t.id,'implemented','diff'));
        assert.equal(fresh.cancel(t.id,'worker stopped, handoff checked').status,'cancelled');
        assert.deepEqual(fresh.summary().locks,[]);
    } finally {fresh.close();}
}));
test('cursor compare-and-swap rejects late results and rolls back partial merges',()=>scenario(l=>{
    const thread={hostId:'local',id:'worker'};
    l.mergeCursors([{thread,cursor:'new',expected_version:0}]);
    assert.throws(()=>l.mergeCursors([{thread,cursor:'late',expected_version:0}]));
    assert.throws(()=>l.mergeCursors([{thread,cursor:'missing'}]));
    assert.throws(()=>l.mergeCursors([{thread,cursor:'next',expected_version:1},{thread:{hostId:'local',id:'forbidden'},cursor:'x',expected_version:0}]));
    assert.equal(l.visibleCursors()[0].cursor,'new');
    l.mergeCursors([{thread,cursor:'next',expected_version:1}]);assert.equal(l.visibleCursors()[0].version,2);
}));
test('contracts and recovery survive reopening without re-dispatch',()=>scenario((l,path)=>{
    const t=start(l);const fresh=new Ledger(path,'entry','local','caller');
    try {
        assert.equal(fresh.recovery()[0].context!.contract!.next_action,'verify then report');
        assert.equal(fresh.create('request','demo','repair','local','user request').id,t.id);
        assert.throws(()=>fresh.prepare(t.id));
        assert.throws(()=>fresh.contract(t.id,{request_id:'other',description:'x',acceptance:'x',boundaries:'x',next_action:'x'}));
    } finally {fresh.close();}
}));
