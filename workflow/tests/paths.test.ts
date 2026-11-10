import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dataDirectory,storagePaths} from '../paths.ts';
import {join,resolve} from 'node:path';
test('portable defaults and explicit paths preserve existing installations',()=>{
 assert.equal(dataDirectory('darwin','/example',{}),join('/example','Library','Application Support','codex-superagent-sample'));
 assert.equal(dataDirectory('linux','/example',{}),join('/example','.local','share','codex-superagent-sample'));
 assert.equal(dataDirectory('linux','/example',{XDG_DATA_HOME:'/data'}),join('/data','codex-superagent-sample'));
 assert.equal(dataDirectory('darwin','/example',{WORKFLOW_DATA_DIR:'/custom'}),resolve('/custom'));
 assert.deepEqual(storagePaths({database:'state/db',tokenFile:'/private/token'},'/config'),{database:resolve('/config','state/db'),tokenFile:resolve('/private/token')});
 assert.equal(storagePaths({},'/checkout-a').database,storagePaths({},'/checkout-b').database);
 assert.equal(storagePaths({},'/checkout-a').database,join(dataDirectory(),'workflow.sqlite3'));
});

test('Windows prefers LOCALAPPDATA and falls back to user AppData/Local',()=>{
 assert.equal(dataDirectory('win32','/user',{LOCALAPPDATA:'/local-data'}),join('/local-data','codex-superagent-sample'));
 assert.equal(dataDirectory('win32','/user',{}),join('/user','AppData','Local','codex-superagent-sample'));
 assert.equal(dataDirectory('win32','/user',{LOCALAPPDATA:'/local-data',WORKFLOW_DATA_DIR:'/override'}),resolve('/override'));
});
