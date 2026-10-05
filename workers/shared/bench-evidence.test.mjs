import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptEvidenceEmail,runEvidenceJobs,getEvidence,listEvidence,evidenceHash,validateEvidenceContext,intakeAuthentication,parseModelJSON,evidenceImagePNG,semanticEvidenceSearch} from './bench-evidence.js';
function setup(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('./schema/bench-evidence.sql',import.meta.url),'utf8'));sql.exec('CREATE TABLE cases(id TEXT,case_number TEXT); INSERT INTO cases VALUES(\'test-case\',\'26FDV03796S\')');
 const objects=new Map();
 const env={AI:{run:async()=>({response:{claims:[]}})},BENCH_INTAKE_SENDERS:'owner@example.com',BENCH_NOTES:{prepare(query){return {bind(...args){const s=sql.prepare(query);return {run:async()=>({meta:{changes:Number(s.run(...args).changes)}}),first:async()=>s.get(...args)||null,all:async()=>({results:s.all(...args)})};}}}},BENCH_DOCUMENTS:{head:async k=>objects.has(k)?{size:objects.get(k).byteLength}:null,put:async(k,b)=>{if(!objects.has(k))objects.set(k,b.slice(0));},get:async k=>objects.has(k)?{arrayBuffer:async()=>objects.get(k).slice(0)}:null}};
 env.BENCH_NOTES.batch=async statements=>{sql.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}};
 return {env,sql,objects};
}
function email(subject='test',attachment='aGVsbG8gMjZGRFYwMzc5NlM=') {return `From: Owner <owner@example.com>\r\nTo: owner@example.com\r\nSubject: ${subject}\r\nMessage-ID: <source@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nThe source email.\r\n--b\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="evidence.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment}\r\n--b\r\nContent-Type: application/x-unsupported\r\nContent-Disposition: attachment; filename="unknown.bin"\r\n\r\nunknown original\r\n--b--\r\n`;}
const message=(raw,from='owner@example.com')=>({from,to:'bench@intake.darius.life',headers:new Headers({'Authentication-Results':'mx.cloudflare.net; dmarc=pass header.from=example.com; spf=pass smtp.mailfrom=owner@example.com'}),raw:new Response(raw).body});
test('preserves all originals; extracts text and exact case; unsupported visible; duplicates keep occurrences',async()=>{
 const {env,objects}=setup(),raw=email();
 const accepted=await acceptEvidenceEmail(message(raw),env);
 await runEvidenceJobs(env);
 const record=await getEvidence(env,accepted.id);
 assert.equal(record.intake.state,'needs_review');assert.equal(record.parts.length,2);assert.equal(record.derivations.length,1);
 assert.deepEqual(JSON.parse(record.intake.case_ids_json),['test-case']);
 assert.equal(record.parts[1].state,'needs_review_unsupported');
 assert.equal(await evidenceHash(await (await env.BENCH_DOCUMENTS.get(`evidence/originals/sha256/${accepted.original_sha256}`)).arrayBuffer()),accepted.original_sha256);
 await acceptEvidenceEmail(message(raw),env);await runEvidenceJobs(env);
 assert.equal((await getEvidence(env,accepted.id)).deliveries.length,2);
 const other=await acceptEvidenceEmail(message(email('forward again')),env);await runEvidenceJobs(env);
 assert.equal((await getEvidence(env,other.id)).parts[0].artifact_id,record.parts[0].artifact_id);
 assert.equal(objects.size,4);assert.equal((await listEvidence(env,{q:'26FDV03796S'})).length,2);
});
test('untrusted sender is preserved and quarantined, never interpreted',async()=>{
 const {env,sql}=setup();const accepted=await acceptEvidenceEmail(message(email(),'stranger@example.com'),env);
 await runEvidenceJobs(env);const record=await getEvidence(env,accepted.id);
 assert.equal(record.intake.state,'quarantined');assert.equal(record.parts.length,0);assert.equal(sql.prepare('SELECT COUNT(*) n FROM evidence_jobs').get().n,0);
});
test('AI failure retains original and schedules retry visibly',async()=>{
 const {env,sql}=setup();const raw=email().replace('Content-Type: text/plain\r\nContent-Disposition','Content-Type: application/pdf\r\nContent-Disposition');
 const accepted=await acceptEvidenceEmail(message(raw),env);await runEvidenceJobs(env);
 const record=await getEvidence(env,accepted.id);assert.equal(record.intake.state,'processing_failed');assert.equal(record.parts.length,2);
 assert.equal(sql.prepare('SELECT state FROM evidence_jobs').get().state,'retry');
});
test('PDF native extraction retains exact page provenance',async()=>{
 const {PDFDocument,StandardFonts}=await import('pdf-lib');
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
 pdf.addPage().drawText('Page one case 26FDV03796S',{font});pdf.addPage().drawText('Second page statement',{font});
 const {env}=setup();const raw=email('PDF',Buffer.from(await pdf.save()).toString('base64')).replace('Content-Type: text/plain\r\nContent-Disposition','Content-Type: application/pdf\r\nContent-Disposition');
 const accepted=await acceptEvidenceEmail(message(raw),env);await runEvidenceJobs(env);
 const record=await getEvidence(env,accepted.id);assert.equal(record.derivations.length,1);
 const provenance=JSON.parse(record.derivations[0].provenance_json);assert.equal(provenance.pages.length,2);assert.match(provenance.pages[1].text,/Second page/);assert.equal(provenance.ocr_status,'not_used');
});
test('nested RFC822 attachments are separately preserved',async()=>{
 const {env}=setup();const raw=email('outer',Buffer.from(email('inner')).toString('base64')).replace('Content-Type: text/plain\r\nContent-Disposition','Content-Type: message/rfc822\r\nContent-Disposition');
 const accepted=await acceptEvidenceEmail(message(raw),env);await runEvidenceJobs(env);const record=await getEvidence(env,accepted.id);
 assert.equal(record.parts.length,4);assert.ok(record.parts.some(p=>p.filename.includes('/evidence.txt')));
});
test('scan fallback retains page provenance and marks OCR uncertainty; audio timestamps retained',async()=>{
 const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();const png=await evidenceImagePNG({width:3,height:3,channels:3,data:new Uint8Array(27).fill(255)});const embedded=await pdf.embedPng(png);pdf.addPage().drawImage(embedded);
 const {env}=setup();env.AI={toMarkdown:async()=>[{format:'markdown',data:'Scanned statement 26FDV03796S'}],run:async(model)=>model.includes('mistral-small')?({response:'Scanned statement 26FDV03796S'}):model.includes('whisper')?({text:'Recorded statement',segments:[{start:0,end:2,text:'Recorded statement'}]}):({response:{claims:[]}})};
 const raw=email('scan',Buffer.from(await pdf.save()).toString('base64')).replace('Content-Type: text/plain\r\nContent-Disposition','Content-Type: application/pdf\r\nContent-Disposition').replace('application/x-unsupported','audio/wav');
 const accepted=await acceptEvidenceEmail(message(raw),env);await runEvidenceJobs(env);const record=await getEvidence(env,accepted.id);
 assert.equal(record.intake.state,'registered');assert.equal(record.derivations.length,2);
 const scan=record.derivations.find(d=>d.kind==='extracted_text'),audio=record.derivations.find(d=>d.kind==='transcript');
 assert.equal(JSON.parse(scan.provenance_json).pages[0].page,1);assert.match(JSON.parse(scan.provenance_json).ocr_status,/vision_ocr_derived/);
 assert.equal(JSON.parse(audio.provenance_json).timestamps_available,true);
});
test('context rejects invented citations and requires both sources for proposed contradictions',()=>{
 const sources=[{id:'new',artifact_id:'hash',page:2,text:'Hearing October 16, 2026.',layer:'extracted_text'},{id:'old',docket_entry_id:'entry',text:'Hearing October 14, 2026.',layer:'existing_register_entry'}];
 const context=validateEvidenceContext({claims:[
 {type:'hearing',value:'Source says October 16',citations:[{source_id:'new',quote:'Hearing October 16, 2026.'}]},
 {type:'deadline',value:'Invented deadline',citations:[{source_id:'new',quote:'Deadline October 20'}]},
 {type:'possible_contradiction',value:'Two dates differ',citations:[{source_id:'new',quote:'Hearing October 16, 2026.'},{source_id:'old',quote:'Hearing October 14, 2026.'}]},
 {type:'possible_contradiction',value:'Unsupported comparison',citations:[{source_id:'new',quote:'Hearing October 16, 2026.'}]},
 {type:'diagnosis',value:'Not allowed',citations:[{source_id:'new',quote:'Hearing October 16, 2026.'}]}
 ]},sources);
 assert.equal(context.claims.length,2);assert.equal(context.claims[0].citations[0].page,2);assert.equal(context.claims[0].classification,'system_inference');assert.equal(context.claims[0].status_verified,false);
});
test('intake sender trust requires first receiver result, aligned DMARC and exact From',()=>{
 const m=message(email());assert.equal(intakeAuthentication(m,'owner@example.com'),true);
 assert.equal(intakeAuthentication(m,'spoof@example.net'),false);
 m.headers=new Headers({'Authentication-Results':'mx.cloudflare.net; dmarc=fail header.from=example.com, mx.cloudflare.net; dmarc=pass header.from=example.com'});
 assert.equal(intakeAuthentication(m,'owner@example.com'),false);
 m.headers=new Headers({'Authentication-Results':'evil.example; dmarc=pass header.from=example.com'});
 assert.equal(intakeAuthentication(m,'owner@example.com'),false);
});
test('live fenced model response is accepted without losing source validation',()=>{
 assert.deepEqual(parseModelJSON({response:'```json\n{"claims":[]}\n```'}),{claims:[]});
 assert.deepEqual(parseModelJSON({choices:[{message:{content:'{"claims":[]}'}}]}),{claims:[]});
 assert.throws(()=>parseModelJSON({response:'truncated {"claims":['}),/context_json_invalid/);
});
test('blank PDF cannot become a processed OCR record from provider metadata',async()=>{
 const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();pdf.addPage();
 const {env}=setup();env.AI.toMarkdown=async()=>[{format:'markdown',data:'## Metadata\n### Page 1'}];
 const accepted=await acceptEvidenceEmail(message(email('blank',Buffer.from(await pdf.save()).toString('base64')).replace('Content-Type: text/plain\r\nContent-Disposition','Content-Type: application/pdf\r\nContent-Disposition')),env);await runEvidenceJobs(env);
 const record=await getEvidence(env,accepted.id);assert.equal(record.derivations.length,0);assert.equal(record.parts[0].state,'processing_failed');
});
test('reprocessing repairs outdated derivation while retaining history and acknowledgment',async()=>{
 const {env,sql}=setup();const accepted=await acceptEvidenceEmail(message(email()),env);await runEvidenceJobs(env);
 sql.prepare("UPDATE evidence_derivations SET version='2026-10-05.1',created_at='2000-01-01',text_content='obsolete metadata'").run();
 sql.prepare("UPDATE evidence_jobs SET state='pending',available_at='2000-01-01'").run();
 sql.prepare('UPDATE evidence_intakes SET receipt_json=? WHERE id=?').run(JSON.stringify({email_acknowledgment:'sent'}),accepted.id);
 await runEvidenceJobs(env);const record=await getEvidence(env,accepted.id);
 assert.equal(record.derivations.length,1);assert.match(record.derivations[0].text_content,/hello/);assert.equal(record.derivation_history.length,2);assert.equal(record.derivation_history.filter(d=>d.superseded).length,1);
 assert.equal(JSON.parse(record.intake.receipt_json).email_acknowledgment,'sent');
});
test('semantic retrieval returns only real passages from current evidence and reports outage',async()=>{
 const {env}=setup();const accepted=await acceptEvidenceEmail(message(email()),env);await runEvidenceJobs(env);
 env.AI.run=async(_model,input)=>{const {sources}=JSON.parse(input.messages[1].content);const text=sources.find(s=>s.source_id.startsWith('derivation:'));return {response:{matches:[{source_id:text.source_id,quote:text.text},{source_id:'invented',quote:'This quote does not exist'}]}};};
 const found=await semanticEvidenceSearch(env,{semantic_query:'Find the document relating to my case'});
 assert.equal(found.items.length,1);assert.equal(found.items[0].id,accepted.id);assert.match(found.items[0].semantic_matches[0].quote,/26FDV03796S/);assert.equal(found.retrieval.complete_corpus,false);
 env.AI.run=async()=>{throw new Error('unavailable');};
 assert.equal((await semanticEvidenceSearch(env,{semantic_query:'same question'})).retrieval.state,'unavailable');
});
