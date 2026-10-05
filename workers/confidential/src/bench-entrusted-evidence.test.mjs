import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleBenchEntrustedGet, handleBenchEntrustedPost } from './bench-entrusted.js';
import { signSession, sha256Hex } from '../../shared/bench-crypto.js';

const ORIGIN='https://confidential.darius.life';
const HASH='a'.repeat(64), EMAIL='b'.repeat(64), OTHER='c'.repeat(64);
async function fixture() {
 const db=new DatabaseSync(':memory:');
 for (const name of ['bench-notes.sql','bench-evidence.sql','bench-evidence-sharing.sql']) db.exec(readFileSync(new URL('../../shared/schema/'+name,import.meta.url),'utf8'));
 db.exec(`INSERT INTO cases(id,title) VALUES('case-1','One'),('case-2','Two');
 INSERT INTO access_grants(id,code_hash,case_ids_json) VALUES('grant-1','hash','["case-1"]'),('grant-2','hash2','["case-2"]');
 INSERT INTO docket_entries(id,case_id,case_label,entry_date,fact,shared_at,share_number) VALUES('note-1','case-1','Case one','2026-10-05','TARGET NOTE','t',2),('note-2','case-1','Case one','2026-10-05','UNRELATED NOTE','t',3);
 INSERT INTO entrusted_notes(id,case_id,case_label,body) VALUES('general-note','case-1','Case one','UNRELATED BODY');
 INSERT INTO documents(id,case_id,case_label,entry_id,title,storage_ref,shared_at) VALUES('doc-1','case-1','Case one','note-1','ATTACHED DOCUMENT','https://example.org/doc','t'),('doc-2','case-1','Case one',NULL,'UNRELATED DOCUMENT','https://example.org/other','t');
 INSERT INTO evidence_artifacts(id,sha256,object_key,byte_size,created_at) VALUES('${HASH}','${HASH}','secret/audio',5,'t'),('${EMAIL}','${EMAIL}','secret/email',4,'t'),('${OTHER}','${OTHER}','secret/other',4,'t');
 INSERT INTO evidence_intakes(id,source_sha256,original_artifact_id,state,received_at,updated_at,envelope_from,subject,body_text) VALUES('intake-1','${EMAIL}','${EMAIL}','registered','t','t','sender@example.org','PRIVATE SUBJECT','PRIVATE BODY');
 INSERT INTO evidence_parts(id,intake_id,artifact_id,part_index,filename,mime_type,role,state) VALUES('part-1','intake-1','${HASH}',0,'PRIVATE AUDIO.wav','audio/wav','attachment','processed');
 INSERT INTO evidence_derivations(id,artifact_id,kind,method,version,created_at,text_content,provenance_json) VALUES('derivation-1','${HASH}','transcript','whisper','1','t','PRIVATE TRANSCRIPT','{}');
 INSERT INTO evidence_note_links(entry_id,intake_id,shared_at) VALUES('note-1','intake-1','t');`);
 const r2Reads=[];
 const env={ENTRUSTED_COOKIE_SECRET:'secret',BENCH_NOTES:{prepare(sql){const stmt=db.prepare(sql);let args=[];return {bind(...values){args=values;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};}};}},BENCH_DOCUMENTS:{async get(key,options){r2Reads.push(key);const data=new TextEncoder().encode(key==='secret/audio'?'audio':'mail');const r=options?.range;return {body:r?data.slice(r.offset,r.offset+r.length):data};}}};
 const token=await signSession({gid:'grant-1'},env.ENTRUSTED_COOKIE_SECRET,3600);
 const cookie='bench_entrusted_session='+token;
 const get=(path,withCookie=cookie,extra={})=>handleBenchEntrustedGet(new Request(ORIGIN+path,{headers:{...(withCookie?{cookie:withCookie}:{}),...extra}}),env,new URL(ORIGIN+path));
 return {db,env,get,cookie,r2Reads};
}

test('numbered note shows only that note, its documents and explicitly linked intake',async()=>{
 const {get}=await fixture(); const res=await get('/entrusted/grant-1/note/note-1');const body=await res.text();
 assert.equal(res.status,200);assert.match(body,/Bench Note 002/);assert.match(body,/TARGET NOTE/);assert.match(body,/ATTACHED DOCUMENT/);assert.match(body,/PRIVATE SUBJECT/);assert.match(body,/PRIVATE TRANSCRIPT/);assert.match(body,/<audio controls/);
 assert.doesNotMatch(body,/UNRELATED NOTE|UNRELATED DOCUMENT|UNRELATED BODY|secret\/audio|secret\/email/);
});

test('unauthenticated envelope and original response disclose no confidential metadata',async()=>{
 const {get,r2Reads}=await fixture();
 for(const path of ['/entrusted/grant-1/note/note-1',`/entrusted/evidence/note-1/intake-1/${HASH}`]){const res=await get(path,null);const body=await res.text();assert.doesNotMatch(body,/PRIVATE|sender@example.org|secret\/audio/);}
 assert.deepEqual(r2Reads,[]);
});

test('shared originals require active grant, matching case, shared note, explicit intake and member hash',async()=>{
 const {get,db,env,r2Reads}=await fixture();
 const path=`/entrusted/evidence/note-1/intake-1/${HASH}`;
 const valid=await get(path);assert.equal(valid.status,200);assert.equal(await valid.text(),'audio');
 r2Reads.length=0;
 const wrong='bench_entrusted_session='+await signSession({gid:'grant-2'},env.ENTRUSTED_COOKIE_SECRET,3600);
 for(const [p,c] of [[path,wrong],[path,'bench_entrusted_session=forged'],[path.replace('intake-1','intake-wrong'),undefined],[path.replace(HASH,OTHER),undefined],[path.replace('note-1','note-2'),undefined]]){const res=await get(p,c);assert.equal(res.status,404);assert.equal(await res.text(),'Not Found');assert.equal(res.headers.get('content-disposition'),null);}
 assert.deepEqual(r2Reads,[]);
 db.exec("UPDATE access_grants SET revoked_at='t' WHERE id='grant-1'");assert.equal((await get(path)).status,404);
 db.exec("UPDATE access_grants SET revoked_at=NULL WHERE id='grant-1'; UPDATE docket_entries SET shared_at=NULL WHERE id='note-1'");assert.equal((await get(path)).status,404);
 db.exec("UPDATE docket_entries SET shared_at='t' WHERE id='note-1'; UPDATE evidence_note_links SET shared_at=NULL");assert.equal((await get(path)).status,404);
 assert.deepEqual(r2Reads,[]);
});

test('audio supports Safari byte range and active document MIME cannot execute inline',async()=>{
 const {get,db}=await fixture();const path=`/entrusted/evidence/note-1/intake-1/${HASH}`;
 const partial=await get(path,undefined,{range:'bytes=0-1'});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),'bytes 0-1/5');assert.equal(await partial.text(),'au');
 db.exec("UPDATE evidence_parts SET mime_type='text/html',filename='PRIVATE.html'");const active=await get(path);assert.match(active.headers.get('content-disposition'),/^attachment/);assert.equal(active.headers.get('x-content-type-options'),'nosniff');assert.equal(active.headers.get('cache-control'),'private, no-store');
});

test('generic passphrase login and logout stay on confidential origin',async()=>{
 const {env,db}=await fixture();db.prepare('UPDATE access_grants SET code_hash=? WHERE id=?').run(await sha256Hex('pass'),'grant-1');
 for(const path of ['login','logout']){
  const url=new URL(ORIGIN+'/entrusted/'+path);
  const res=await handleBenchEntrustedPost(new Request(url,{method:'POST',body:new URLSearchParams({passphrase:'pass'})}),env,url);
  assert.equal(res.status,303);assert.equal(res.headers.get('location'),ORIGIN+'/entrusted/');
 }
});

test('recovered recording remains audio when it is also the intake source artifact',async()=>{
 const {get,db}=await fixture();
 db.prepare('UPDATE evidence_intakes SET original_artifact_id=?,metadata_json=? WHERE id=?').run(HASH,JSON.stringify({source_kind:'recovered_file'}),'intake-1');
 const res=await get(`/entrusted/evidence/note-1/intake-1/${HASH}`,undefined,{range:'bytes=0-1'});
 assert.equal(res.status,206);assert.equal(res.headers.get('content-type'),'audio/wav');assert.match(res.headers.get('content-disposition'),/^inline/);
 const body=await (await get('/entrusted/grant-1/note/note-1')).text();
 assert.match(body,/Recovered source evidence/);assert.doesNotMatch(body,/Download original email|Email communication/);
});
