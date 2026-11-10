import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.ts';
test('every application table and field has a persisted description; time format stays unchanged',()=>{
 const s=new Store(':memory:');
 try {
  for(const {name} of s.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
   assert.ok(s.one('SELECT comment FROM schema_comments WHERE table_name=? AND column_name=?',name,'')?.comment);
   for(const column of s.all(`PRAGMA table_info("${name}")`)) {
    assert.ok(s.one('SELECT comment FROM schema_comments WHERE table_name=? AND column_name=?',name,column.name)?.comment);
    if(column.name==='created_at')assert.equal(column.type,'INTEGER');
   }
  }
 } finally {s.close();}
});
