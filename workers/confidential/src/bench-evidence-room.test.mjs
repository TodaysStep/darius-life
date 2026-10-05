import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleEvidenceRoom} from './bench-evidence-room.js';
import {resetCertsCacheForTests} from '../../shared/access.js';
const ORIGIN='https://confidential.darius.life', HASH='a'.repeat(64);
async function fixture(t){
 resetCertsCacheForTests();
 const key=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk={...await crypto.subtle.exportKey('jwk',key.publicKey),kid:'test-owner'};
 const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
 const data=b64({alg:'RS256',kid:jwk.kid})+'.'+b64({aud:'owner-aud',exp:Math.floor(Date.now()/1000)+3600});
 const token=data+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,new TextEncoder().encode(data))).toString('base64url');
 const previous=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({keys:[jwk]})});t.after(()=>{globalThis.fetch=previous;resetCertsCacheForTests();});
 const db=new DatabaseSync(':memory:');
 for(const file of ['bench-notes.sql','bench-evidence.sql','bench-evidence-sharing.sql','bench-evidence-receipts.sql'])db.exec(readFileSync(new URL('../../shared/schema/'+file,import.meta.url),'utf8'));
 db.exec(`INSERT INTO cases(id,title) VALUES('case','Test');
 INSERT INTO docket_entries(id,case_id,case_label,entry_date,fact,shared_at,share_number) VALUES('note','case','Test case','2026-10-05','Existing authored note','t',2),('private-note','case','Test case','2026-10-05','Private note',NULL,NULL);
 INSERT INTO evidence_intakes(id,source_sha256,original_artifact_id,state,received_at,updated_at,subject) VALUES('intake','${HASH}','${HASH}','needs_review','t','t','Private subject');
 INSERT INTO evidence_jobs(id,intake_id,state,available_at,attempts,error_code) VALUES('job','intake','needs_review','t',5,'processing_failed');`);
 const context={claims:[{type:'hearing',value:'Hearing October 16',citations:[{artifact_id:HASH,page:2,quote:'Hearing on October 16.',source_layer:'extracted_text'}]}]};
 db.prepare('INSERT INTO evidence_context(intake_id,context_json,method,version,created_at,state) VALUES(?,?,?,?,?,?)').run('intake',JSON.stringify(context),'model','1','t','needs_review');
 const env={ACCESS_TEAM_DOMAIN:'test-team.example',ACCESS_AUD:'owner-aud',BENCH_NOTES:{async batch(statements){db.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}},prepare(sql){const stmt=db.prepare(sql);let args=[];return {bind(...values){args=values;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return {meta:{changes:stmt.run(...args).changes}};}};}}};
 const request=(path,{method='GET',form,origin=ORIGIN,auth=true}={})=>{const url=new URL(ORIGIN+'/bench/evidence/'+path);return handleEvidenceRoom(new Request(url,{method,headers:{...(auth?{'Cf-Access-Jwt-Assertion':token}:{}),...(origin?{Origin:origin}:{})},...(form?{body:new URLSearchParams(form)}:{})}),env,url);};
 return {db,request};
}

test('owner sees contextual claims, cited quotation, retries and explicit full-intake sharing control',async t=>{
 const {request}=await fixture(t);const res=await request('intake');assert.equal(res.status,200);const html=await res.text();
 for(const expected of ['Context to review','Hearing October 16','Hearing on October 16.','page 2','System inference','Retry failed processing','Link privately','approve_full_intake','Share full intake with this note'])assert.ok(html.includes(expected),expected);
 assert.doesNotMatch(html,/&quot;claims&quot;/);
});

test('mutations require owner authentication and matching origin before any change',async t=>{
 const {request,db}=await fixture(t);
 for(const options of [{auth:false},{origin:'https://attacker.example'},{origin:null}]){const res=await request('link-note',{method:'POST',form:{id:'intake',entry_id:'note',visibility:'shared',approve_full_intake:'yes'},...options});assert.equal(res.status,403);}
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_note_links').get().n,0);
});

test('full-intake sharing requires explicit approval and a shared note; private link and revocation stay private',async t=>{
 const {request,db}=await fixture(t);
 const post=form=>request('link-note',{method:'POST',form:{id:'intake',entry_id:'note',visibility:'shared',...form}});
 assert.equal((await post({})).status,400);
 assert.equal((await post({entry_id:'private-note',approve_full_intake:'yes'})).status,400);
 assert.equal((await post({visibility:'private'})).status,303);assert.equal(db.prepare('SELECT shared_at FROM evidence_note_links').get().shared_at,null);
 assert.equal((await post({approve_full_intake:'yes'})).status,303);assert.ok(db.prepare('SELECT shared_at FROM evidence_note_links').get().shared_at);
 assert.equal((await request('unshare-note',{method:'POST',form:{id:'intake',entry_id:'note'}})).status,303);assert.equal(db.prepare('SELECT shared_at FROM evidence_note_links').get().shared_at,null);
 assert.equal((await post({approve_full_intake:'yes'})).status,303);
 assert.equal((await post({visibility:'private'})).status,303);assert.equal(db.prepare('SELECT shared_at FROM evidence_note_links').get().shared_at,null);
 assert.equal(db.prepare('SELECT fact FROM docket_entries WHERE id=?').get('note').fact,'Existing authored note');
});

test('retry visibly queues failed work without disrupting a running lease',async t=>{
 const {request,db}=await fixture(t);
 const res=await request('retry',{method:'POST',form:{id:'intake'}});assert.equal(res.status,303);assert.match(res.headers.get('location'),/notice=retry-queued/);
 assert.equal(db.prepare('SELECT state FROM evidence_jobs').get().state,'pending');
 db.exec("UPDATE evidence_jobs SET state='running',lease_until='future'");
 assert.equal((await request('retry',{method:'POST',form:{id:'intake'}})).status,409);
 assert.equal(db.prepare('SELECT lease_until FROM evidence_jobs').get().lease_until,'future');
});


test('receipt recovery is separately authorized, resets failed outbox atomically and never resends sent or running work',async t=>{
 const {request,db}=await fixture(t);
 db.exec("INSERT INTO evidence_receipt_outbox(intake_id,state,attempts,available_at,created_at,updated_at,lease_until,error_code) VALUES('intake','needs_review',5,'t','t','t','old-lease','receipt_send_failed'); UPDATE evidence_intakes SET receipt_json='{\"email_acknowledgment\":\"needs_review\",\"email_acknowledgment_error\":\"receipt_send_failed\",\"original_preserved\":true}'");
 assert.match(await (await request('intake')).text(),/Retry receipt/);
 for(const options of [{auth:false},{origin:'https://attacker.example'},{origin:null}])assert.equal((await request('retry-receipt',{method:'POST',form:{id:'intake'},...options})).status,403);
 assert.equal(db.prepare('SELECT attempts FROM evidence_receipt_outbox').get().attempts,5);
 const before=db.prepare('SELECT original_artifact_id FROM evidence_intakes').get().original_artifact_id;
 const res=await request('retry-receipt',{method:'POST',form:{id:'intake'}});assert.equal(res.status,303);assert.match(res.headers.get('location'),/notice=receipt-retry-queued/);
 const outbox=db.prepare('SELECT * FROM evidence_receipt_outbox').get();assert.equal(outbox.state,'pending');assert.equal(outbox.attempts,0);assert.equal(outbox.lease_until,null);assert.equal(outbox.error_code,null);
 const receipt=JSON.parse(db.prepare('SELECT receipt_json FROM evidence_intakes').get().receipt_json);assert.equal(receipt.email_acknowledgment,'queued');assert.equal(receipt.email_acknowledgment_error,undefined);assert.equal(receipt.original_preserved,true);
 assert.equal(db.prepare('SELECT original_artifact_id FROM evidence_intakes').get().original_artifact_id,before);
 assert.equal(db.prepare('SELECT state FROM evidence_jobs').get().state,'needs_review');
 for(const state of ['pending','sent','running']){db.prepare('UPDATE evidence_receipt_outbox SET state=?,lease_until=?').run(state,'live-lease');assert.equal((await request('retry-receipt',{method:'POST',form:{id:'intake'}})).status,409);assert.equal(db.prepare('SELECT lease_until FROM evidence_receipt_outbox').get().lease_until,'live-lease');assert.doesNotMatch(await (await request('intake')).text(),/>Retry receipt</);}
});
