import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {queueEvidenceReceipt,runEvidenceReceipts} from './bench-evidence-receipts.js';
function setup(state='registered') {
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('./schema/bench-evidence.sql',import.meta.url),'utf8'));
 sql.exec(readFileSync(new URL('./schema/bench-evidence-receipts.sql',import.meta.url),'utf8'));
 const received=new Date().toISOString();
 sql.prepare('INSERT INTO evidence_intakes(id,source_sha256,original_artifact_id,state,received_at,updated_at,envelope_from,subject,receipt_json) VALUES(?,?,?,?,?,?,?,?,?)').run('email-safe','hash','hash',state,received,received,'owner@example.com','PRIVATE CASE PERSON SECRET',JSON.stringify({authentication:'receiver_dmarc_aligned',attachments_preserved:2,needs_review:1}));
 sql.exec("INSERT INTO evidence_parts(id,intake_id,artifact_id,part_index,filename,mime_type,role,state) VALUES('pdf','email-safe','a',0,'SECRET CASE.pdf','application/pdf','attachment','processed'),('unsupported','email-safe','b',1,'PRIVATE.bin','application/octet-stream','attachment','needs_review_unsupported')");
 const sent=[];
 const env={BENCH_INTAKE_SENDERS:'owner@example.com',BENCH_RECEIPTS:{send:async message=>{sent.push(message);return {messageId:'provider-id'};}},BENCH_NOTES:{prepare(query){return{bind(...args){const statement=sql.prepare(query);return{run:async()=>({meta:{changes:Number(statement.run(...args).changes)}}),first:async()=>statement.get(...args)||null,all:async()=>({results:statement.all(...args)})};}};}}};
 return {sql,env,sent};
}
test('durable receipt waits for processing then sends generic counts once',async()=>{
 const {sql,env,sent}=setup('preserved');
 assert.equal((await queueEvidenceReceipt(env,'email-safe')).queued,true);
 assert.equal((await runEvidenceReceipts(env)).sent,0);
 sql.prepare("UPDATE evidence_intakes SET state='needs_review'").run();
 assert.equal((await runEvidenceReceipts(env)).sent,1);assert.equal(sent.length,1);
 assert.equal(sent[0].to,'owner@example.com');assert.equal(sent[0].from,'bench@intake.darius.life');assert.match(sent[0].text,/2 attachments preserved/);assert.match(sent[0].text,/1 PDF searchable/);assert.match(sent[0].text,/1 item needs review/);
 assert.doesNotMatch(JSON.stringify(sent),/SECRET|PRIVATE|CASE|PERSON/);
 assert.match(sent[0].text,/https:\/\/confidential.darius.life\/bench\/evidence\/email-safe/);
 await queueEvidenceReceipt(env,'email-safe');await runEvidenceReceipts(env);assert.equal(sent.length,1);
 assert.equal(sql.prepare('SELECT provider_message_id FROM evidence_receipt_outbox').get().provider_message_id,'provider-id');
});
test('sending failure is retried visibly without losing receipt or evidence',async()=>{
 const {sql,env,sent}=setup();await queueEvidenceReceipt(env,'email-safe');
 const original=env.BENCH_RECEIPTS.send;env.BENCH_RECEIPTS.send=async()=>{throw new Error('provider error with confidential detail');};
 await runEvidenceReceipts(env);const failed=sql.prepare('SELECT * FROM evidence_receipt_outbox').get();assert.equal(failed.state,'retry');assert.equal(failed.error_code,'receipt_send_failed');
 env.BENCH_RECEIPTS.send=original;sql.exec("UPDATE evidence_receipt_outbox SET available_at='2000-01-01'");await runEvidenceReceipts(env);assert.equal(sent.length,1);assert.equal(sql.prepare('SELECT state FROM evidence_receipt_outbox').get().state,'sent');
});
test('recipient removed after queue and automated messages cannot send',async()=>{
 const {sql,env,sent}=setup();await queueEvidenceReceipt(env,'email-safe');env.BENCH_INTAKE_SENDERS='someone@example.com';await runEvidenceReceipts(env);assert.equal(sent.length,0);assert.equal(sql.prepare('SELECT state FROM evidence_receipt_outbox').get().state,'needs_review');
 env.BENCH_INTAKE_SENDERS='owner@example.com';sql.prepare('UPDATE evidence_intakes SET metadata_json=?').run(JSON.stringify({headers:[{key:'auto-submitted',value:'auto-generated'}]}));assert.equal((await queueEvidenceReceipt(env,'email-safe')).queued,false);
});
test('ten-minute preservation receipt is truthful about still-pending processing',async()=>{
 const {sql,env,sent}=setup('processing');sql.exec("UPDATE evidence_intakes SET received_at='2000-01-01',receipt_json='{}'");
 sql.prepare('UPDATE evidence_intakes SET receipt_json=?').run(JSON.stringify({authentication:'receiver_dmarc_aligned'}));await queueEvidenceReceipt(env,'email-safe');await runEvidenceReceipts(env);
 assert.equal(sent.length,1);assert.match(sent[0].text,/Processing is still underway/);assert.doesNotMatch(sent[0].text,/register updated|0 attachments/);
});
