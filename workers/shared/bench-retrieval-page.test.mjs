import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listEvidencePage} from './bench-evidence.js';
import {handleEvidenceApi} from '../confidential/src/bench-evidence-api.js';
function setup(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('./schema/bench-evidence.sql',import.meta.url),'utf8'));
 sql.exec('CREATE TABLE docket_entries(id TEXT PRIMARY KEY,case_id TEXT,case_label TEXT,source TEXT,ingest_item_id TEXT,share_number INTEGER,created_at TEXT,fact TEXT,commentary TEXT,court_takeaways TEXT)');
 let ai=0;const env={BENCH_RETRIEVAL_KEY:'test-key',AI:{run(){ai++;throw Error('AI must not run');}},BENCH_NOTES:{prepare(query){const s=sql.prepare(query);const bind=(...args)=>({all:async()=>({results:s.all(...args)}),first:async()=>s.get(...args)||null});return {...bind(),bind};}}};
 const add=(id,date,subject='report',metadata='{}')=>sql.prepare('INSERT INTO evidence_intakes(id,source_sha256,original_artifact_id,state,received_at,updated_at,subject,metadata_json) VALUES(?,?,?,?,?,?,?,?)').run(id,id,id,'registered',date,date,subject,metadata);
 const call=async(path,auth=true)=>{const url=new URL('https://example.com/evidence-api/'+path);return handleEvidenceApi(new Request(url,{headers:auth?{Authorization:'Bearer test-key'}:{}}),env,url);};
 return {sql,env,add,call,ai:()=>ai};
}
test('literal search finds old match beyond 30 recent records and traverses same-date ties',async()=>{
 const {env,add,ai}=setup();for(let i=0;i<45;i++)add('new-'+String(i).padStart(2,'0'),'2026-10-06','unrelated');for(let i=0;i<5;i++)add('old-'+i,'2000-01-01','needle');
 const ids=[];let cursor;do{const p=await listEvidencePage(env,{q:'needle',limit:2,cursor});ids.push(...p.items.map(x=>x.id));cursor=p.retrieval.next_cursor;}while(cursor);
 assert.deepEqual(ids,['old-4','old-3','old-2','old-1','old-0']);assert.equal(ai(),0);
});
test('cursor cannot silently change filters; literal percent is not wildcard',async()=>{
 const {env,add}=setup();add('a','2026','100% claim');add('b','2026','100% claim');add('c','2026','1000 claim');
 const p=await listEvidencePage(env,{q:'100%',limit:1});assert.ok(p.retrieval.next_cursor);
 await assert.rejects(()=>listEvidencePage(env,{q:'different',cursor:p.retrieval.next_cursor}),/invalid_cursor/);
 const all=await listEvidencePage(env,{q:'100%'});assert.equal(all.items.length,2);
});
test('structured synthetic markers excluded before paging; narrative title alone retained',async()=>{
 const {env,add}=setup();add('fake','2026','needle',JSON.stringify({provenance:{source:'synthetic_test'}}));add('real','2025','synthetic data research');add('flag','2026','needle',JSON.stringify({is_synthetic:true}));
 const p=await listEvidencePage(env,{});assert.deepEqual(p.items.map(x=>x.id),['real']);
});
test('API auth, metadata status, note paging and zero AI cost for literal search',async()=>{
 const {sql,add,call,ai}=setup();add('i','2026','needle');for(let i=0;i<3;i++)sql.prepare('INSERT INTO docket_entries(id,source,created_at,fact) VALUES(?,?,?,?)').run('n'+i,'manual','2026','needle PRIVATE ORIGINAL '+ 'x'.repeat(700));sql.prepare('INSERT INTO docket_entries(id,source,created_at,fact) VALUES(?,?,?,?)').run('fake','synthetic_test','2026','needle');
 assert.equal((await call('status',false)).status,401);
 const status=await (await call('status')).json();assert.equal(status.counts.eligible_authored_notes,3);assert.equal(status.evidence_bodies_included,false);assert.doesNotMatch(JSON.stringify(status),/PRIVATE ORIGINAL|needle/);
 const first=await (await call('search?q=needle&limit=2')).json();assert.equal(first.authored_notes.length,2);assert.equal(first.authored_notes[0].excerpt.length,600);assert.equal(first.authored_notes[0].fact,undefined);assert.ok(first.authored_retrieval.next_cursor);
 const last=await (await call('search?q=needle&limit=2&note_cursor='+encodeURIComponent(first.authored_retrieval.next_cursor))).json();assert.equal(last.authored_notes.length,1);assert.equal(last.authored_retrieval.has_more,false);assert.equal(ai(),0);
 assert.equal((await call('search?cursor=invalid')).status,400);
});
test('synthetic derivation cannot match a literal query on a real intake',async()=>{
 const {sql,env,add}=setup();add('real','2026','ordinary');sql.prepare('INSERT INTO evidence_parts(id,intake_id,artifact_id,part_index,mime_type,state,role) VALUES(?,?,?,?,?,?,?)').run('p','real','artifact',0,'text/plain','processed','attachment');sql.prepare('INSERT INTO evidence_derivations(id,artifact_id,kind,method,version,created_at,text_content,provenance_json) VALUES(?,?,?,?,?,?,?,?)').run('d','artifact','text','test','1','2026','needle','{"source":"synthetic_test"}');assert.equal((await listEvidencePage(env,{q:'needle'})).items.length,0);
});

test('intake-only filters suppress unrelated authored notes with an explicit reason',async()=>{
 const {sql,call}=setup();sql.prepare('INSERT INTO docket_entries(id,source,created_at,fact) VALUES(?,?,?,?)').run('real','manual','2026','needle');
 for(const filter of ['person','document','state','type','email','collection_id']){const result=await(await call('search?q=needle&'+filter+'=x')).json();assert.deepEqual(result.authored_notes,[]);assert.equal(result.authored_retrieval.state,'unsupported_filters');assert.deepEqual(result.authored_retrieval.unsupported_filters,[filter]);}
});
test('collection_id is an exact metadata filter and cursor-bound',async()=>{
 const {add,env}=setup();add('a','2026','needle','{"collection_id":"research"}');add('b','2026','needle','{"collection_id":"research-other"}');add('c','2026','needle','{}');
 assert.deepEqual((await listEvidencePage(env,{collection_id:'research'})).items.map(x=>x.id),['a']);
});
test('structured synthetic hyphen and space variants excluded from notes and intakes',async()=>{
 const {sql,add,call,env}=setup();for(const [i,source] of ['synthetic-test','test-fixture','synthetic test','test fixture'].entries()){add('i'+i,'2026','needle',JSON.stringify({source}));sql.prepare('INSERT INTO docket_entries(id,source,created_at,fact) VALUES(?,?,?,?)').run('n'+i,source,'2026','needle');}
 assert.equal((await listEvidencePage(env,{})).items.length,0);const response=await(await call('search?q=needle')).json();assert.deepEqual(response.authored_notes,[]);
});
