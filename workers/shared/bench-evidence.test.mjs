import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptEvidenceEmail,runEvidenceJobs,getEvidence,listEvidence,evidenceHash,validateEvidenceContext,intakeAuthentication,parseModelJSON,evidenceImagePNG,semanticEvidenceSearch,boundedScanRaster,extractPageScanRasters} from './bench-evidence.js';
function setup(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('./schema/bench-evidence.sql',import.meta.url),'utf8'));sql.exec(readFileSync(new URL('./schema/bench-evidence-pdf-pages.sql',import.meta.url),'utf8'));sql.exec('CREATE TABLE cases(id TEXT,case_number TEXT); INSERT INTO cases VALUES(\'test-case\',\'26FDV03796S\')');
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
 {type:'possible_contradiction',value:'Two dates differ',shared_subject:'Hearing October',citations:[{source_id:'new',quote:'Hearing October 16, 2026.'},{source_id:'old',quote:'Hearing October 14, 2026.'}]},
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
 const record=await getEvidence(env,accepted.id);assert.equal(record.derivations.length,0);assert.equal(record.parts[0].state,'needs_review_pdf_pages');
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
test('arrival context rejects unrelated historical people, dates and invented court roles',()=>{
 const sources=[
  {id:'arrival',artifact_id:'emailhash',text:'SYNTHETIC SCAN TEST. This is not a court document.',layer:'source_communication'},
  {id:'history',docket_entry_id:'old-note',text:'Susan Heavilin at San Diego Chamber of Connection. Hearing October 16, 2026.',layer:'existing_register_entry'},
  {id:'real',artifact_id:'documenthash',text:'Superior Court of California. Hearing October 16, 2026.',layer:'extracted_text'}
 ];
 const quote=(source_id,quote)=>({source_id,quote});
 const claims=[
  {type:'person',value:'Susan Heavilin',citations:[quote('history','Susan Heavilin at San Diego Chamber of Connection.')]},
  {type:'person',value:'Susan Heavilin',citations:[quote('arrival','SYNTHETIC SCAN TEST.'),quote('history','Susan Heavilin at San Diego Chamber of Connection.')]},
  {type:'court',value:'San Diego Chamber of Connection',citations:[quote('arrival','This is not a court document.'),quote('history','San Diego Chamber of Connection.')]},
  {type:'hearing',value:'Hearing October 16, 2026',citations:[quote('arrival','SYNTHETIC SCAN TEST.'),quote('history','Hearing October 16, 2026.')]},
  {type:'court',value:'Superior Court of California',citations:[quote('real','Superior Court of California.')]},
  {type:'hearing',value:'Hearing October 16, 2026',citations:[quote('real','Hearing October 16, 2026.')]}
 ];
 const result=validateEvidenceContext({claims},sources);assert.equal(result.claims.length,2);assert.deepEqual(result.claims.map(c=>c.type),['court','hearing']);
});
test('semantic result limit caps returned items without shrinking candidate coverage',async()=>{
 const {env}=setup();await acceptEvidenceEmail(message(email('first matching intake')),env);await acceptEvidenceEmail(message(email('second matching intake')),env);await runEvidenceJobs(env,{limit:2});
 env.AI.run=async(_model,input)=>{const {sources}=JSON.parse(input.messages[1].content);return {response:{matches:sources.filter(s=>s.source_id.startsWith('email:')).map(s=>({source_id:s.source_id,quote:s.text}))}};};
 const result=await semanticEvidenceSearch(env,{semantic_query:'Find matching evidence',limit:1});
 assert.equal(result.items.length,1);assert.equal(result.retrieval.candidates,2);assert.equal(result.retrieval.candidate_limit,30);assert.equal(result.retrieval.matches,2);assert.equal(result.retrieval.results_truncated,true);assert.equal(result.retrieval.result_limit,1);
});
test('self-identified synthetic fixtures cannot contradict the real docket',()=>{
 const sources=[
  {id:'new',artifact_id:'safe-test',text:'SYNTHETIC TEST EVIDENCE. This is not a court filing or witness evidence. Case 26FDV03796S.',layer:'source_communication'},
  {id:'old',docket_entry_id:'real-docket',text:'Case 26FDV03796S is a court matter involving Mary Ann Rahimpour.',layer:'existing_register_entry'}
 ];
 const result=validateEvidenceContext({claims:[{type:'possible_contradiction',value:'Court matter involvement differs',shared_subject:'26FDV03796S',citations:[{source_id:'new',quote:sources[0].text},{source_id:'old',quote:sources[1].text}]}]},sources);
 assert.equal(result.claims.length,0);assert.equal(result.test_evidence_detected,true);assert.equal(result.evidence_classification,'source_declares_synthetic_test_evidence');
});
test('packed one-bit scan decodes row padding and bounds high-resolution raster',()=>{
 const small=boundedScanRaster({width:9,height:2,kind:1,data:new Uint8Array([255,128,0,0])});
 assert.equal(small.channels,1);assert.deepEqual([...small.data.slice(0,9)],Array(9).fill(255));assert.deepEqual([...small.data.slice(9)],Array(9).fill(0));
 const large=boundedScanRaster({width:3392,height:4406,kind:1,data:new Uint8Array(Math.ceil(3392/8)*4406).fill(255)});
 assert.equal(large.height,2000);assert.ok(large.width<=2000);assert.equal(large.data.length,large.width*large.height);
});
test('PDF page checkpoints survive bounded continuation and preserve partial text',async()=>{
 const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();const png=await evidenceImagePNG({width:3,height:3,channels:3,data:new Uint8Array(27).fill(255)});const image=await pdf.embedPng(png);for(let p=0;p<3;p++)pdf.addPage().drawImage(image);
 const {env,sql}=setup();let ocrCalls=0;env.AI.run=async model=>model.includes('mistral-small')?({response:`OCR page ${++ocrCalls}`}):({response:{claims:[]}});
 const raw=email('checkpoint',Buffer.from(await pdf.save()).toString('base64')).replace('Content-Type: text/plain\r\nContent-Disposition','Content-Type: application/pdf\r\nContent-Disposition');
 const accepted=await acceptEvidenceEmail(message(raw),env);await runEvidenceJobs(env);
 let record=await getEvidence(env,accepted.id);assert.equal(record.intake.state,'processing');assert.equal(ocrCalls,2);assert.equal(record.pdf_pages.filter(p=>p.state==='processed').length,2);assert.equal(JSON.parse(record.derivations[0].provenance_json).partial,true);assert.equal(JSON.parse(record.intake.receipt_json).attachments_preserved,2);
 sql.exec("UPDATE evidence_jobs SET available_at='2000-01-01'");await runEvidenceJobs(env);record=await getEvidence(env,accepted.id);assert.equal(ocrCalls,3);assert.equal(record.pdf_pages.filter(p=>p.state==='processed').length,3);assert.equal(JSON.parse(record.derivations[0].provenance_json).partial,false);assert.equal(sql.prepare('SELECT attempts FROM evidence_jobs').get().attempts,1);
});
test('exhausted job updates receipt processing to needs review',async()=>{
 const {env,sql}=setup();const accepted=await acceptEvidenceEmail(message(email()),env);env.AI.run=async()=>{throw new Error('provider unavailable');};
 sql.exec('UPDATE evidence_jobs SET attempts=4');await runEvidenceJobs(env);const record=await getEvidence(env,accepted.id);assert.equal(record.intake.state,'needs_review');assert.equal(JSON.parse(record.intake.receipt_json).processing,'needs_review');
});
test('truncated PDF OCR remains searchable partial evidence requiring review',async()=>{
 const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();const image=await pdf.embedPng(await evidenceImagePNG({width:3,height:3,channels:3,data:new Uint8Array(27).fill(255)}));pdf.addPage().drawImage(image);
 const {env}=setup();env.AI.run=async model=>model.includes('mistral-small')?({choices:[{message:{content:'Exact preserved partial statement'},finish_reason:'length'}]}):({response:{claims:[]}});
 const raw=email('truncated scan',Buffer.from(await pdf.save()).toString('base64')).replace('Content-Type: text/plain\r\nContent-Disposition','Content-Type: application/pdf\r\nContent-Disposition');
 const accepted=await acceptEvidenceEmail(message(raw),env);await runEvidenceJobs(env);const record=await getEvidence(env,accepted.id);
 assert.equal(record.parts[0].state,'needs_review_pdf_pages');assert.equal(record.pdf_pages[0].error_code,'ocr_truncated');assert.equal(JSON.parse(record.derivations[0].provenance_json).partial,true);assert.match(record.derivations[0].text_content,/Exact preserved partial statement/);assert.equal((await listEvidence(env,{q:'Exact preserved partial statement'})).length,1);
});
test('short native footer does not suppress substantial scanned page content',async()=>{
 const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();const image=await pdf.embedPng(await evidenceImagePNG({width:500,height:500,channels:1,data:new Uint8Array(250000).fill(255)}));const page=pdf.addPage();page.drawImage(image);page.drawText('Page 1');
 const {env}=setup();let calls=0;env.AI.run=async model=>model.includes('mistral-small')?({response:'Actual scanned body',usage:{completion_tokens:++calls}}):({response:{claims:[]}});
 const raw=email('hybrid scan',Buffer.from(await pdf.save()).toString('base64')).replace('Content-Type: text/plain\r\nContent-Disposition','Content-Type: application/pdf\r\nContent-Disposition');
 const accepted=await acceptEvidenceEmail(message(raw),env);await runEvidenceJobs(env);const record=await getEvidence(env,accepted.id);
 assert.equal(calls,1);assert.match(record.derivations[0].text_content,/\[Native text\][\s\S]*Page 1/);assert.match(record.derivations[0].text_content,/\[OCR-derived text\][\s\S]*Actual scanned body/);
});
test('image OCR output token ceiling stays review-required across duplicate artifact reuse',async()=>{
 const {env,sql}=setup();env.AI.run=async model=>model.includes('mistral-small')?({response:'Preserved image fragment',usage:{completion_tokens:3000}}):({response:{claims:[]}});
 const raw=email('image truncation').replace('Content-Type: text/plain\r\nContent-Disposition','Content-Type: image/png\r\nContent-Disposition');const accepted=await acceptEvidenceEmail(message(raw),env);await runEvidenceJobs(env);let record=await getEvidence(env,accepted.id);
 assert.equal(record.parts[0].state,'needs_review_ocr_truncated');assert.equal(JSON.parse(record.derivations[0].provenance_json).partial,true);
 const other=await acceptEvidenceEmail(message(raw.replace('image truncation','another occurrence')),env);await runEvidenceJobs(env);record=await getEvidence(env,other.id);assert.equal(record.parts[0].state,'needs_review_ocr_truncated');
});
test('repetitive page OCR is excluded and stale complete PDF cache cannot bypass correction',async()=>{
 const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();const image=await pdf.embedPng(await evidenceImagePNG({width:3,height:3,channels:3,data:new Uint8Array(27).fill(255)}));pdf.addPage().drawImage(image);
 const {env,sql}=setup();let calls=0;env.AI.run=async model=>model.includes('mistral-small')?({response:'Invalid run '+ '_'.repeat(300),usage:{completion_tokens:300}}):({response:{claims:[]}});
 const raw=email('repetitive scan',Buffer.from(await pdf.save()).toString('base64')).replace('Content-Type: text/plain\r\nContent-Disposition','Content-Type: application/pdf\r\nContent-Disposition');
 const accepted=await acceptEvidenceEmail(message(raw),env);await runEvidenceJobs(env);let record=await getEvidence(env,accepted.id);const artifact=record.parts[0].artifact_id;
 assert.equal(record.pdf_pages[0].state,'needs_review');assert.equal(record.derivations[0].text_content,'');assert.equal(JSON.parse(record.derivations[0].provenance_json).pages[0].text,'');
 sql.prepare("INSERT INTO evidence_derivations(id,artifact_id,kind,method,version,created_at,text_content,provenance_json) VALUES(?,?,'extracted_text','checkpointed-pdf/native+vision-ocr','2026-10-05.3','2000-01-01',?,?)").run('old-complete',artifact,'Invalid run '+ '_'.repeat(300),'{}');
 sql.exec("UPDATE evidence_parts SET state='processed' WHERE mime_type='application/pdf'; UPDATE evidence_jobs SET state='pending',available_at='2000-01-01'");await runEvidenceJobs(env);record=await getEvidence(env,accepted.id);
 assert.equal(record.parts[0].state,'needs_review_pdf_pages');assert.equal(record.derivations[0].text_content,'');assert.ok(record.derivation_history.some(d=>d.id==='old-complete'));assert.equal((await listEvidence(env,{q:'Invalid run'})).length,0);
 env.AI.run=async model=>model.includes('mistral-small')?({response:'Valid recovered page body '+ ++calls}):({response:{claims:[]}});
 sql.exec("UPDATE evidence_pdf_pages SET state='pending'; UPDATE evidence_parts SET state='preserved' WHERE mime_type='application/pdf'; UPDATE evidence_jobs SET state='pending',available_at='2000-01-01'");await runEvidenceJobs(env);record=await getEvidence(env,accepted.id);
 assert.equal(calls,1);assert.equal(record.derivations[0].version,'2026-10-05.3-validation2-complete');assert.match(record.derivations[0].text_content,/Valid recovered page body/);assert.equal(JSON.parse(record.derivations[0].provenance_json).partial,false);assert.ok(record.derivation_history.some(d=>d.id==='old-complete'));
});
