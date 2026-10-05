import { evidenceFileResponse } from '../../shared/evidence-file-response.js';
import { requireAccess } from '../../shared/access.js';
import { headers, benchPage, escapeHtml as esc } from '../../shared/bench-style.js';
import { renderEvidenceText, renderEvidenceAudio, renderEvidenceTranscript } from '../../shared/bench-rich-text.js';
import { listEvidence, getEvidence, getEvidenceArtifact } from '../../shared/bench-evidence.js';

const BASE='/bench/evidence';
const parse=(s,fallback={})=>{try{return JSON.parse(s)||fallback;}catch{return fallback;}};
const response=(body,status=200)=>new Response(body,{status,headers:headers('text/html; charset=utf-8')});
const missing=()=>response('Not Found',404);
const link=(id)=>`${BASE}/${encodeURIComponent(id)}`;
const fileLink=(id,hash)=>`${link(id)}/original/${hash}`;
function receiptView(intake){
 const r=parse(intake.receipt_json);
 return `<section class="card"><h2>Receipt</h2><p>Received ${esc(intake.received_at)} · ${esc(intake.state)}</p><p>${parse(intake.metadata_json).source_kind==='recovered_file'?'Recovered source file preserved':'Original email preserved'}${r.attachments_preserved!=null?` · ${esc(r.attachments_preserved)} attachments preserved · ${esc(r.processed)} processed · ${esc(r.needs_review)} need review`:''}.</p>${intake.error_code?'<p>Processing needs attention. Preserved originals remain available.</p>':''}</section>`;
}
function renderItem(record,controls=""){
 const {intake:i,parts,derivations,deliveries}=record;
 const meta=parse(i.metadata_json);
 const recovered=meta.source_kind==='recovered_file';
 const original=`<a href="${fileLink(i.id,i.original_artifact_id)}">${recovered?'Download recovered source file':'Download original email (.eml)'}</a>`;
 const attachments=parts.map(p=>{
  const url=fileLink(i.id,p.artifact_id), ds=derivations.filter(d=>d.artifact_id===p.artifact_id);
  const media=/^audio\//.test(p.mime_type)?renderEvidenceAudio({href:url,title:p.filename}):/^image\/(png|jpeg|webp|gif)$/.test(p.mime_type)?`<img src="${url}" alt="${esc(p.filename)}" style="max-width:100%;height:auto">`:'';
  return `<article class="card"><h2>${esc(p.filename)}</h2><p>${esc(p.mime_type)} · ${esc(p.byte_size)} bytes · ${esc(p.state)}</p><p><a href="${url}">Open original</a> · <a href="${url}?download=1">Download</a></p>${media}<details><summary>Source hash</summary><p class="hash">SHA-256 ${esc(p.sha256)}</p></details>${ds.map(d=>{
   const provenance=parse(d.provenance_json);
   const body=d.kind==='transcript'?renderEvidenceTranscript({text:d.text_content,source:'auto',segments:(Array.isArray(provenance.segments)?provenance.segments:[]).map(s=>({speaker:s.speaker||'',timestamp:s.start==null?'':String(s.start)+'s',text:s.text}))}):renderEvidenceText(d.text_content);
   return `<section><h3>${d.kind==='transcript'?'Automatic transcript':'Extracted text'}</h3><p class="hint">${esc(d.method)} · ${esc(d.version)}${provenance.ocr_status?' · '+esc(provenance.ocr_status):''}</p>${body}<details><summary>Derivation provenance</summary>${renderEvidenceText(JSON.stringify(provenance,null,2))}</details></section>`;
  }).join('')}${!ds.length?'<p>Derived text is not available. See the processing state above.</p>':''}</article>`;
 }).join('');
 return `<nav><a href="${BASE}">Evidence register</a> · <a href="/bench/">Bench Notes</a></nav><h1>${recovered?'Recovered evidence':'Evidence intake'}</h1>${receiptView(i)}<h2>${esc(i.subject||'Email awaiting processing')}</h2><dl>${recovered?'<dt>Source</dt><dd>Recovered uploaded file</dd>':`<dt>Envelope sender</dt><dd>${esc(i.envelope_from)}</dd>`}<dt>Source message date (as supplied)</dt><dd>${esc(i.sent_at||'Unknown')}</dd><dt>Received</dt><dd>${esc(i.received_at)}</dd><dt>Message-ID</dt><dd>${esc(i.message_id||'Unknown')}</dd></dl><p>${original}</p><details><summary>${recovered?'Recovery provenance':'Email addresses and headers'}</summary>${renderEvidenceText(JSON.stringify(meta,null,2))}</details><section class="card"><h2>${recovered?'Recovery record':'Email communication'}</h2>${renderEvidenceText(i.body_text||'No plain-text body. The original email retains its complete MIME and HTML content.')}</section><p>${deliveries.length} delivery occurrence(s). Repeated attachment bytes share an original; each communication remains traceable.</p>${renderContext(record)}${controls}${attachments}`;
}
function renderContext(record){
 const context=record.context;
 if(!context)return '<section class="card"><h2>Context</h2><p>Context is not available yet. The source remains preserved.</p></section>';
 const data=parse(context.context_json), claims=Array.isArray(data.claims)?data.claims:[];
 const labels={person:'People',court:'Court or agency',document_type:'Document type',date:'Date',deadline:'Possible deadline',hearing:'Hearing',document_status:'Attributed document status',new_event:'Possible new event',possible_contradiction:'Possible contradiction'};
 const knownArtifacts=new Set([record.intake.original_artifact_id,...record.parts.map(p=>p.artifact_id)]);
 const rows=claims.map(claim=>{
  const citations=(Array.isArray(claim.citations)?claim.citations:[]).map(c=>{
   const source=knownArtifacts.has(c.artifact_id)?`<a href="${fileLink(record.intake.id,c.artifact_id)}">Open source${c.page!=null?` · page ${esc(c.page)}`:''}</a>`:c.docket_entry_id?`Existing register entry ${esc(c.docket_entry_id)}`:`Source ${esc(c.source_id||'not specified')}`;
   return `<blockquote>${renderEvidenceText(c.quote)}<footer>${source} · ${esc(c.source_layer||'source layer not specified')}</footer></blockquote>`;
  }).join('');
  return `<article><h3>${esc(Object.hasOwn(labels,claim.type)?labels[claim.type]:'Context')}</h3>${renderEvidenceText(claim.value)}<p class="hint">System inference · Review required</p>${citations}</article>`;
 }).join('');
 return `<section class="card"><h2>Context to review</h2><p>${esc(context.state)} · ${esc(context.method)} · ${esc(context.created_at)}</p><p>These are system inferences supported by quoted sources. They are not verified findings or founder-authored interpretations. Filing does not establish issuance or service.</p>${rows||'<p>No supported contextual claims are available. Classification remains unknown.</p>'}</section>`;
}

async function ownerControls(env,record,notice){
 const id=record.intake.id;
 const [job,notes,links]=await Promise.all([
  env.BENCH_NOTES.prepare('SELECT state,attempts,available_at,error_code FROM evidence_jobs WHERE intake_id=?').bind(id).first(),
  env.BENCH_NOTES.prepare('SELECT id,case_label,entry_date,share_number,shared_at,substr(fact,1,120) AS excerpt FROM docket_entries ORDER BY entry_date DESC LIMIT 200').all(),
  env.BENCH_NOTES.prepare('SELECT l.entry_id,l.shared_at,e.share_number,e.entry_date,e.case_label,e.shared_at AS note_shared_at FROM evidence_note_links l JOIN docket_entries e ON e.id=l.entry_id WHERE l.intake_id=?').bind(id).all()
 ]);
 const noteLabel=n=>`${n.share_number!=null?'Bench Note '+String(n.share_number).padStart(3,'0'):n.entry_date+' entry'} · ${n.case_label||''}`;
 const retryAllowed=job&&['done','retry','needs_review'].includes(job.state)&&(record.intake.state!=='registered'||record.context?.state==='needs_review');
 const retry=`<section class="card"><h2>Processing</h2><p>${job?`Job: ${esc(job.state)} · ${esc(job.attempts)} attempt(s)`: 'No processing job is registered.'}</p>${job?.error_code?'<p>Processing needs attention. Originals are preserved.</p>':''}${retryAllowed?`<form method="post" action="${BASE}/retry"><input type="hidden" name="id" value="${esc(id)}"><button type="submit">Retry failed processing and context</button></form><p class="hint">Unsupported files remain available for review. Retrying does not replace originals.</p>`:''}</section>`;
 const current=links.results.map(n=>`<li>${esc(noteLabel(n))} — ${n.shared_at?(n.note_shared_at?'Shared with this note’s authorized recipients':'Sharing approved, but the note is not currently shared'):'Private relationship'}${n.shared_at?`<form method="post" action="${BASE}/unshare-note"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="entry_id" value="${esc(n.entry_id)}"><button type="submit">Stop sharing this intake through this note</button></form>`:''}</li>`).join('');
 const select=notes.results.map(n=>`<option value="${esc(n.id)}">${esc(noteLabel(n)+' · '+(n.excerpt||''))}${n.shared_at?'':' (not shared)'}</option>`).join('');
 const sharing=`<section class="card"><h2>Relate to an existing Bench Note</h2><p>A relationship keeps the evidence intake separate from the authored note.</p>${current?`<ul>${current}</ul>`:'<p>No notes linked yet.</p>'}${select?`<form method="post" action="${BASE}/link-note"><input type="hidden" name="id" value="${esc(id)}"><label for="entry-id">Existing note</label><select name="entry_id" id="entry-id" required>${select}</select><p><button name="visibility" value="private" type="submit">Link privately</button></p><p>Sharing grants that note’s authorized recipients access to this complete intake: original email, every attachment, extracted text and transcripts.</p><label><input type="checkbox" name="approve_full_intake" value="yes"> I approve sharing this full intake with the selected note’s authorized recipients.</label><p><button name="visibility" value="shared" type="submit">Share full intake with this note</button></p></form>`:'<p>Create a Bench Note before linking evidence.</p>'}</section>`;
 const messages={'retry-queued':'Processing retry queued. Preserved originals remain available.','linked':'Private relationship saved.','shared':'Full intake sharing saved for the selected note.','unshared':'Sharing through this note has stopped. The private relationship remains.'};
 return `${Object.hasOwn(messages,notice)?`<p role="status">${messages[notice]}</p>`:''}${retry}${sharing}`;
}

async function handleOwnerAction(request,env,url,tail){
 if(request.headers.get('Origin')!==url.origin)return response('Forbidden',403);
 const type=request.headers.get('Content-Type')||'';
 if(!/^(application\/x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(type))return response('Unsupported form type',415);
 const form=await request.formData();const id=String(form.get('id')||'');
 const record=await getEvidence(env,id);if(!record)return missing();
 if(tail==='retry'){
  const result=await env.BENCH_NOTES.prepare("UPDATE evidence_jobs SET state='pending',available_at=?,attempts=0,lease_until=NULL,error_code=NULL WHERE intake_id=? AND state IN ('done','retry','needs_review')").bind(new Date().toISOString(),id).run();
  if(!result.meta?.changes)return response('Processing is already queued or running, or no job exists.',409);
  return Response.redirect(url.origin+link(id)+'?notice=retry-queued',303);
 }
 const entryId=String(form.get('entry_id')||'');
 const entry=await env.BENCH_NOTES.prepare('SELECT id,shared_at FROM docket_entries WHERE id=?').bind(entryId).first();if(!entry)return missing();
 if(tail==='unshare-note'){
  await env.BENCH_NOTES.prepare('UPDATE evidence_note_links SET shared_at=NULL WHERE intake_id=? AND entry_id=?').bind(id,entryId).run();
  return Response.redirect(url.origin+link(id)+'?notice=unshared',303);
 }
 const visibility=String(form.get('visibility')||'');
 if(!['private','shared'].includes(visibility))return response('Choose a private relationship or explicit sharing.',400);
 if(visibility==='shared'&&(form.get('approve_full_intake')!=='yes'||!entry.shared_at))return response('Sharing requires approval of the full intake and an already shared Bench Note.',400);
 if(visibility==='private'){
  // The explicit private action also revokes this intake link's sharing.
  await env.BENCH_NOTES.prepare('INSERT INTO evidence_note_links(entry_id,intake_id,shared_at) VALUES(?,?,NULL) ON CONFLICT(entry_id,intake_id) DO UPDATE SET shared_at=NULL').bind(entryId,id).run();
 }else{
  await env.BENCH_NOTES.prepare('INSERT INTO evidence_note_links(entry_id,intake_id,shared_at) VALUES(?,?,?) ON CONFLICT(entry_id,intake_id) DO UPDATE SET shared_at=excluded.shared_at').bind(entryId,id,new Date().toISOString()).run();
 }
 return Response.redirect(url.origin+link(id)+'?notice='+(visibility==='shared'?'shared':'linked'),303);
}

export async function handleEvidenceRoom(request,env,url){
 if(!await requireAccess(request,env))return response('Forbidden',403);
 const tail=url.pathname.slice(BASE.length).replace(/^\//,'');
 if(request.method==='POST' && ['retry','link-note','unshare-note'].includes(tail))return handleOwnerAction(request,env,url,tail);
 if(request.method!=='GET')return response('Method Not Allowed',405);
 if(!tail){
  const q=url.searchParams.get('q')||'';const rows=await listEvidence(env,{q,case_id:url.searchParams.get('case_id')||undefined});
  const body=`<nav><a href="/bench/">Bench Notes</a></nav><h1>Evidence room</h1><p>Forward correspondence to <strong>bench@intake.darius.life</strong>.</p><p>Evidence intake stays separate from authored Bench Notes.</p><form method="get"><label for="q">Search evidence</label><input id="q" name="q" type="text" value="${esc(q)}"><button>Search</button></form>${rows.map(i=>`<article class="card"><h2><a href="${link(i.id)}">${esc(i.subject||'Email awaiting processing')}</a></h2><p>${esc(i.received_at)} · ${esc(i.envelope_from)}</p><p>${esc(i.state)}</p></article>`).join('')||'<p>No matching intake records.</p>'}`;
  return response(roomPage('Evidence room',body));
 }
 const m=tail.match(/^([^/]+)(?:\/original\/([a-f0-9]{64}))?$/);if(!m)return missing();
 const record=await getEvidence(env,decodeURIComponent(m[1]));if(!record)return missing();
 if(m[2]){
  const part=record.parts.find(p=>p.artifact_id===m[2]);
  const isEmail=record.intake.original_artifact_id===m[2]&&parse(record.intake.metadata_json).source_kind!=='recovered_file';if(!part&&!isEmail)return missing();
  const found=await getEvidenceArtifact(env,m[2]);if(!found?.object)return missing();
  const type=isEmail?'message/rfc822':part.mime_type;
  return evidenceFileResponse(request,env,found.artifact,{mimeType:type,filename:isEmail?'original.eml':part.filename});
 }
 return response(roomPage('Evidence intake',renderItem(record,await ownerControls(env,record,url.searchParams.get('notice')))));
}
function roomPage(title,body){return benchPage(title,`<style>.evidence-text{font-family:Georgia,serif;font-size:1.05rem;line-height:1.6}.evidence-text blockquote{border-left:3px solid #a88642;margin-left:0;padding-left:1rem}audio,select{width:100%}select{padding:.75rem;max-width:100%}blockquote{margin-left:0;border-left:3px solid #a88642;padding-left:1rem}button{min-height:44px}.hash,dd{overflow-wrap:anywhere}dd{margin-left:0}</style>${body}`,{csp:"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; media-src 'self'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});}
