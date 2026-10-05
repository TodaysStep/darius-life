// Receipts acknowledge preservation; they never forward evidence or source headers.
// The outbox is at-least-once: a crash after provider acceptance but before D1
// records it may produce a duplicate generic receipt. It cannot lose originals.
const SENDER='bench@intake.darius.life';
const now=()=>new Date().toISOString();
const run=(env,sql,...args)=>env.BENCH_NOTES.prepare(sql).bind(...args).run();
const first=(env,sql,...args)=>env.BENCH_NOTES.prepare(sql).bind(...args).first();
const rows=async(env,sql,...args)=>(await env.BENCH_NOTES.prepare(sql).bind(...args).all()).results||[];
function approvedRecipient(env,intake) {
 const address=String(intake.envelope_from||'').trim().toLowerCase();
 const allowed=String(env.BENCH_INTAKE_SENDERS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
 return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)&&allowed.includes(address)?address:null;
}
function decode(value) {try{return JSON.parse(value||'{}');}catch{return {};}}
function isAutomated(intake) {
 const headers=decode(intake.metadata_json).headers;
 if(!Array.isArray(headers))return false;
 return headers.some(h=>String(h.key||h.name||'').toLowerCase()==='auto-submitted'&&String(h.value||'').trim().toLowerCase()!=='no');
}
export async function queueEvidenceReceipt(env,id) {
 const intake=await first(env,'SELECT id,state,envelope_from,receipt_json,metadata_json FROM evidence_intakes WHERE id=?',id);
 if(!intake || intake.state==='quarantined' || !approvedRecipient(env,intake) || isAutomated(intake) || decode(intake.receipt_json).authentication!=='receiver_dmarc_aligned')return {queued:false,reason:'not_eligible'};
 const time=now();
 await run(env,"INSERT OR IGNORE INTO evidence_receipt_outbox(intake_id,state,available_at,created_at,updated_at) VALUES(?,'pending',?,?,?)",id,time,time,time);
 await run(env,"UPDATE evidence_intakes SET receipt_json=json_set(COALESCE(receipt_json,'{}'),'$.email_acknowledgment',COALESCE((SELECT CASE WHEN state IN ('sent','needs_review','retry') THEN state ELSE 'queued' END FROM evidence_receipt_outbox WHERE intake_id=?),'queued')) WHERE id=?",id,id);
 return {queued:true};
}
export function evidenceReceiptText(intake,parts) {
 const receipt=decode(intake.receipt_json);
 const completed=['registered','needs_review','processing_failed'].includes(intake.state);
 const preserved=Number.isInteger(receipt.attachments_preserved)?receipt.attachments_preserved:null;
 const processed=parts.filter(p=>p.state==='processed').length;
 const pending=parts.filter(p=>p.state!=='processed').length;
 const count=(n,singular,plural)=>`${n} ${n===1?singular:plural}`;
 const lines=['Received. Your original email is preserved.'];
 if(preserved!==null)lines.push(`${count(preserved,'attachment','attachments')} preserved.`);
 if(completed) {
  if(processed)lines.push(`${count(processed,'attachment','attachments')} processed.`);
  const pdfs=parts.filter(p=>p.state==='processed'&&p.mime_type==='application/pdf').length;
  const audio=parts.filter(p=>p.state==='processed'&&String(p.mime_type).startsWith('audio/')).length;
  if(pdfs)lines.push(`${count(pdfs,'PDF','PDFs')} searchable.`);
  if(audio)lines.push(`${count(audio,'audio recording','audio recordings')} transcribed.`);
  lines.push('Bench Notes register updated.');
  const review=Math.max(pending,Number(receipt.needs_review)||0);
  if(review)lines.push(`${count(review,'item needs','items need')} review.`);
  else if(intake.state==='processing_failed')lines.push('Processing needs attention; originals remain preserved.');
 } else lines.push('Processing is still underway. Open the private receipt for its current status.');
 lines.push('','Open your private receipt:',`https://confidential.darius.life/bench/evidence/${encodeURIComponent(intake.id)}`);
 return lines.join('\n');
}
export async function runEvidenceReceipts(env,{limit=2}={}) {
 const time=now(),cutoff=new Date(Date.now()-10*60*1000).toISOString();
 const jobs=await rows(env,`SELECT o.* FROM evidence_receipt_outbox o JOIN evidence_intakes i ON i.id=o.intake_id WHERE ((o.state IN ('pending','retry') AND o.available_at<=?) OR (o.state='running' AND o.lease_until<?)) AND (i.state IN ('registered','needs_review','processing_failed','quarantined') OR i.received_at<=?) ORDER BY o.available_at LIMIT ?`,time,time,cutoff,Math.max(1,Math.min(10,Number(limit)||2)));
 let sent=0;
 for(const job of jobs) {
  const lease=new Date(Date.now()+5*60*1000).toISOString();
  const claimed=await run(env,"UPDATE evidence_receipt_outbox SET state='running',attempts=attempts+1,lease_until=?,updated_at=? WHERE intake_id=? AND ((state IN ('pending','retry') AND available_at<=?) OR (state='running' AND lease_until<?))",lease,time,job.intake_id,time,time);
  if(!claimed.meta?.changes)continue;
  const intake=await first(env,'SELECT id,state,received_at,envelope_from,receipt_json,metadata_json FROM evidence_intakes WHERE id=?',job.intake_id);
  const recipient=intake&&approvedRecipient(env,intake);
  if(!recipient || intake.state==='quarantined' || isAutomated(intake) || decode(intake.receipt_json).authentication!=='receiver_dmarc_aligned') {
   const blocked=await run(env,"UPDATE evidence_receipt_outbox SET state='needs_review',error_code='receipt_not_eligible',lease_until=NULL,updated_at=? WHERE intake_id=? AND lease_until=?",now(),job.intake_id,lease);
   if(blocked.meta?.changes)await run(env,"UPDATE evidence_intakes SET receipt_json=json_set(COALESCE(receipt_json,'{}'),'$.email_acknowledgment','needs_review','$.email_acknowledgment_error','receipt_not_eligible') WHERE id=?",job.intake_id);
   continue;
  }
  try {
   if(!env.BENCH_RECEIPTS?.send)throw new Error('binding_missing');
   const parts=await rows(env,'SELECT state,mime_type FROM evidence_parts WHERE intake_id=?',job.intake_id);
   const result=await env.BENCH_RECEIPTS.send({from:SENDER,to:recipient,subject:'Bench Notes — evidence received',text:evidenceReceiptText(intake,parts)});
   const providerId=typeof result?.messageId==='string'?result.messageId:null;
   const stamp=now();
   const updated=await run(env,"UPDATE evidence_receipt_outbox SET state='sent',sent_at=?,updated_at=?,provider_message_id=?,error_code=NULL,lease_until=NULL WHERE intake_id=? AND lease_until=?",stamp,stamp,providerId,job.intake_id,lease);
   if(updated.meta?.changes) {
    sent++;
    await run(env,"UPDATE evidence_intakes SET receipt_json=json_set(json_remove(COALESCE(receipt_json,'{}'),'$.email_acknowledgment_error'),'$.email_acknowledgment','sent','$.email_acknowledgment_at',?,'$.email_acknowledgment_message_id',?) WHERE id=?",stamp,providerId,job.intake_id);
   }
   console.log(JSON.stringify({event:'evidence_receipt',id:job.intake_id,state:'sent'}));
  } catch {
   const exhausted=job.attempts>=4,state=exhausted?'needs_review':'retry';
   const available=new Date(Date.now()+Math.min(3600000,60000*2**job.attempts)).toISOString();
   const updated=await run(env,'UPDATE evidence_receipt_outbox SET state=?,available_at=?,updated_at=?,lease_until=NULL,error_code=? WHERE intake_id=? AND lease_until=?',state,available,now(),'receipt_send_failed',job.intake_id,lease);
   if(updated.meta?.changes)await run(env,"UPDATE evidence_intakes SET receipt_json=json_set(COALESCE(receipt_json,'{}'),'$.email_acknowledgment',?,'$.email_acknowledgment_error','receipt_send_failed') WHERE id=?",state,job.intake_id);
   console.log(JSON.stringify({event:'evidence_receipt',id:job.intake_id,state,error_code:'receipt_send_failed'}));
  }
 }
 return {checked:jobs.length,sent};
}
