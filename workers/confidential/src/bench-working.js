// confidential.darius.life/bench/* — Bench Notes working side. Darius's own
// private docket: cases, dated timeline entries carrying four simultaneous
// layers (fact, recommended direction, his commentary, court takeaways), a
// living glossary, pattern-spotting on judge/opposing-counsel behavior, and
// any number of dated recordings/notes per document.
//
// Gated by the pre-existing Cloudflare Access application that already
// protected confidential.darius.life ("confidential legal area," policy
// "Allowed readers") — reused as-is; see workers/confidential/wrangler.toml
// for how its real team domain/AUD were found. requireAccess below is this
// module's own independent re-check of the Access JWT, same defense-in-depth
// pattern as every other gated route in this repo (workers/shared/access.js).
// This module and bench-entrusted.js (a different Worker entirely — see its
// own header) deliberately share no query helper: this file is the only
// place in either Worker that ever reads or writes cases, docket_entries,
// patterns, or glossary_terms. That is what keeps the entrusted side
// structurally unable to reach this data, rather than merely filtered away
// from it.
//
// A large upload used to crash outright: the old handler read the whole
// file into the Worker's own memory (once via request.formData(), again via
// file.arrayBuffer() for text extraction) — Workers have a hard, per-isolate
// 128 MB memory ceiling, shared across every in-flight request, and
// exceeding it gets the in-flight request killed outright, not a catchable
// error. Every upload now goes through PUT /bench/blobs/:id first (see
// handleBenchPut below), which streams request.body straight to R2 without
// ever materializing the file in memory, and separately, analysis
// (bench-document-ai.js) is skipped entirely — cheaply, before fetching any
// bytes, via R2's own head() — for anything over MAX_ANALYZABLE_BYTES. That
// streaming PUT is why this file now serves one small piece of first-party
// JavaScript (bench-client-script.js) on the two pages that need it: a
// browser form alone cannot PUT a raw (non-multipart) body, and live audio
// recording (MediaRecorder) has no non-JS equivalent at all. Both pages
// declare an explicit script-src 'self' CSP override for exactly that
// reason — every other page in Bench Notes keeps script-src 'none'.
import { requireAccess } from "../../shared/access.js";
import { escapeHtml, headers, benchPage, STENOTYPE_ICON } from "../../shared/bench-style.js";
import { sha256Hex } from "../../shared/bench-crypto.js";
import * as data from "../../shared/bench-data.js";
import { listSharedDocuments, listNotesForCases, listSharedEntries, renderEntrustedView } from "../../shared/bench-entrusted-view.js";
import { analyzeUploadedDocument } from "../../shared/bench-document-ai.js";
import { BENCH_CLIENT_JS } from "./bench-client-script.js";

export const PREFIX = "/bench/";
const UPLOAD_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://darius.life; script-src 'self'; connect-src 'self'";
// A sanity ceiling, not a real one: R2's own single-PUT limit is 5 GiB, but
// Cloudflare's edge enforces its own request body size limit ahead of this
// Worker entirely, based on the account's plan (100 MB on Free/Pro, 200 MB
// on Business, up to 5 GB on Enterprise) — a request over that limit never
// reaches this code at all. This constant exists only to reject something
// absurd cheaply, at head() time, not to promise any particular ceiling.
const MAX_STORABLE_BYTES = 2 * 1024 * 1024 * 1024;

const forbidden = () => new Response("Forbidden", { status: 403, headers: headers("text/plain; charset=utf-8") });
const notFound = () => new Response("Not Found", { status: 404, headers: headers("text/plain; charset=utf-8") });
const html = (body, status = 200) => new Response(body, { status, headers: headers("text/html; charset=utf-8") });

function errorPage(message) {
  return benchPage("Error", `<h1>Something went wrong</h1><p class="error">Nothing was saved. ${escapeHtml(message)}</p><p class="note"><a href="${PREFIX}">Back to Bench Notes</a></p>`);
}

// --- D1 access — thin adapters over workers/shared/bench-data.js, the one
// place these operations are actually implemented (the machine API at
// workers/private-legal/src/bench-api.js calls the exact same functions —
// no second copy of what "publish," "share," or "revoke" means). ---

const listCases = (env) => data.listCases(env.BENCH_NOTES);
const getCase = (env, id) => data.getCase(env.BENCH_NOTES, id);
const createCase = (env, fields) => data.createCase(env.BENCH_NOTES, fields);
const listEntries = (env, caseId) => data.listEntries(env.BENCH_NOTES, caseId);
const addEntry = (env, fields) => data.addEntry(env.BENCH_NOTES, fields);
const setEntryShared = (env, id, shared) => data.setEntryShared(env.BENCH_NOTES, id, shared);
const updateEntry = (env, id, fields) => data.updateEntry(env.BENCH_NOTES, id, fields);
const listGlossary = (env, caseId) => data.listGlossary(env.BENCH_NOTES, caseId);
const addGlossaryTerm = (env, fields) => data.addGlossaryTerm(env.BENCH_NOTES, fields);
const listPatterns = (env, caseId) => data.listPatterns(env.BENCH_NOTES, caseId);
const addPattern = (env, fields) => data.addPattern(env.BENCH_NOTES, fields);
const listDocuments = (env, caseId) => data.listDocuments(env.BENCH_NOTES, caseId);
const addDocument = (env, fields) => data.addDocument(env.BENCH_NOTES, fields);
const setDocumentShared = (env, id, shared) => data.setDocumentShared(env.BENCH_NOTES, id, shared);
const listEntrustedNotes = (env, caseId) => data.listEntrustedNotes(env.BENCH_NOTES, caseId);
const listDocumentRecordings = (env, documentId) => data.listDocumentRecordings(env.BENCH_NOTES, documentId);
const addDocumentRecording = (env, fields) => data.addDocumentRecording(env.BENCH_NOTES, fields);
const getDocumentRecording = (env, id) => data.getDocumentRecording(env.BENCH_NOTES, id);
const deleteDocumentRecording = (env, id) => data.deleteDocumentRecording(env.BENCH_NOTES, id);
const deleteEntry = (env, id) => data.deleteEntry(env.BENCH_NOTES, id);

// Every R2 delete below is best-effort: if a key is already gone (or the
// bucket call fails), the D1 rows still go — an orphaned R2 object costs
// nothing and points at nothing; a docket entry Darius can't get rid of
// because R2 hiccuped is the worse failure mode by far.
async function deleteBlobRefs(env, refs) {
  await Promise.all(refs.map((ref) => env.BENCH_DOCUMENTS.delete(ref).catch(() => {})));
}

async function deleteDocumentAndBlobs(env, docId) {
  const refs = await data.listDocumentBlobRefs(env.BENCH_NOTES, docId);
  await deleteBlobRefs(env, refs);
  await data.deleteDocument(env.BENCH_NOTES, docId);
}

async function deleteCaseAndBlobs(env, caseId) {
  const refs = await data.listCaseBlobRefs(env.BENCH_NOTES, caseId);
  await deleteBlobRefs(env, refs);
  await data.deleteCase(env.BENCH_NOTES, caseId);
}
const addEntrustedNote = (env, fields) => data.addEntrustedNote(env.BENCH_NOTES, fields);
const listGrants = (env) => data.listGrants(env.BENCH_NOTES);
const createGrant = (env, fields) => data.createGrant(env.BENCH_NOTES, fields);
const revokeGrant = (env, id) => data.revokeGrant(env.BENCH_NOTES, id);
const updateGrantPassphrase = (env, id, newCodeHash) => data.updateGrantPassphrase(env.BENCH_NOTES, id, newCodeHash);

// --- Rendering ---

// summary: { caseTitles: string[], docCount, entryCount } — computed by the
// caller (handleBenchGet), since it requires querying shared docs/entries
// per grant, not something this pure render function should do itself.
function renderGrantRow(g, summary) {
  const status = g.revoked_at ? `revoked ${escapeHtml(g.revoked_at)}` : "active";
  const scope = summary.caseTitles.length ? summary.caseTitles.map(escapeHtml).join(", ") : "no cases";
  const sharedCount = `${summary.docCount} document${summary.docCount === 1 ? "" : "s"}, ${summary.entryCount} timeline entr${summary.entryCount === 1 ? "y" : "ies"} shared`;
  return `<div class="card">
<div class="case-row"><span><strong>${escapeHtml(g.label || g.id)}</strong></span><span class="status">${status}</span></div>
<p class="hint">Sees: ${scope} — ${sharedCount}</p>
<div class="case-row">
${g.revoked_at ? "" : `<a href="${PREFIX}preview/${escapeHtml(g.id)}">Preview their view</a>`}
${g.revoked_at ? "" : `<form style="display:inline" method="post" action="${PREFIX}grants/${escapeHtml(g.id)}/revoke"><button type="submit">Revoke</button></form>`}
</div>
${g.revoked_at ? "" : `<form method="post" action="${PREFIX}grants/${escapeHtml(g.id)}/passphrase">
<label for="newPassphrase-${escapeHtml(g.id)}">Change passphrase</label>
<input type="text" id="newPassphrase-${escapeHtml(g.id)}" name="newPassphrase" required>
<button type="submit">Update</button>
</form>`}
</div>`;
}

// Shared by the document-upload form and the recording-upload/record form
// below — the hidden fields bench-client-script.js fills in once the file's
// bytes are safely in R2, plus a progress bar and a status line it writes
// to. The file input itself carries no name attribute: it is never actually
// part of the submitted form body, only read by the script.
function blobUploadFields() {
  return `<input type="hidden" name="blobId" data-blob-id>
<input type="hidden" name="filename" data-blob-filename>
<input type="hidden" name="contentType" data-blob-content-type>
<progress data-upload-progress value="0" max="1" style="display:none;width:100%;margin:0.4em 0"></progress>
<p data-upload-status class="hint" style="display:none"></p>`;
}

function renderCaseList(cases, grants, grantSummaries) {
  const rows = cases.length
    ? cases.map((c) => `<div class="case-row"><a href="${PREFIX}case/${escapeHtml(c.id)}">${escapeHtml(c.title)}</a><span class="status">${escapeHtml(c.status)}${c.case_number ? ` · ${escapeHtml(c.case_number)}` : ""}</span></div>`).join("\n")
    : `<p class="hint">No cases yet — upload a document below, or add one the long way further down.</p>`;
  const grantRows = grants.length ? grants.map((g) => renderGrantRow(g, grantSummaries.get(g.id))).join("\n") : `<p class="hint">No entrusted access granted yet.</p>`;
  const caseCheckboxes = cases.map((c) => `<label class="opt"><input type="checkbox" name="caseIds" value="${escapeHtml(c.id)}"> ${escapeHtml(c.title)}</label>`).join("\n");

  return benchPage(
    "Bench Notes",
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>Bench Notes<span class="tag">Working docket — private</span></h1></header>
<p class="hint">Your own case timelines. Nothing here is visible to anyone on the entrusted side unless you explicitly share a document.</p>

<h2>Upload a document</h2>
<p class="hint">The default way to start a bench note. Bench Notes reads the document itself to say what it is and find its case number — matching an existing case by that number, or starting a new one. Nothing to type except your own notes, and even those are optional. Large files upload directly with a progress bar, so a big scan won't hang or crash the page.</p>
<form method="post" action="${PREFIX}upload/finalize" data-blob-upload>
<label for="uploadFile">Document</label>
<input type="file" id="uploadFile" data-blob-file required>
${blobUploadFields()}
<label for="uploadCommentary">Your notes about it (optional — private, never shared)</label>
<textarea id="uploadCommentary" name="commentary"></textarea>
<button type="submit">Upload</button>
</form>
<p class="hint">If the document can't be read automatically (a scanned image with no text layer, or a file over 20&nbsp;MB, which skips automatic reading), it still uploads — the entry is tagged so you know to fill in the rest yourself from the case page.</p>
<script src="${PREFIX}static/bench.js"></script>
<div class="ticker"></div>
${rows}

<h2>Add a case the long way</h2>
<p class="hint">For when you want court and case-number details on record before there's a document to attach — never required to get started.</p>
<form method="post" action="${PREFIX}">
<label for="title">Case title</label>
<input type="text" id="title" name="title" required>
<label for="court">Court</label>
<input type="text" id="court" name="court">
<label for="caseNumber">Case number</label>
<input type="text" id="caseNumber" name="caseNumber">
<button type="submit">Add case</button>
</form>

<h2>Entrusted access — management</h2>
<p class="hint">Everything currently live on the entrusted side (<a href="/bench-entrusted/">/bench-entrusted/</a>, a structurally separate area, not this login): who has a passphrase, what they can see, and what's actually been shared with them.</p>
${grantRows}
<h3>Add a guest</h3>
<form method="post" action="${PREFIX}grants">
<label for="grantLabel">Label (for your own reference)</label>
<input type="text" id="grantLabel" name="grantLabel" placeholder="e.g. Attorney — family case">
<label for="passphrase">Passphrase to give them</label>
<input type="text" id="passphrase" name="passphrase" required>
<label>Which cases can they see</label>
<fieldset>${caseCheckboxes || '<p class="hint">Add a case first.</p>'}</fieldset>
<button type="submit">Grant access</button>
</form>`,
    { csp: UPLOAD_CSP },
  );
}

function renderEntry(base, e, attachedDocs) {
  const layer = (name, value) => (value ? `<div class="entry-layer"><span class="layer-name">${name}</span>${escapeHtml(value)}</div>` : "");
  const shared = Boolean(e.shared_at);
  const toggleAction = `${base}/entries/${escapeHtml(e.id)}/${shared ? "unshare" : "share"}`;
  const editAction = `${base}/entries/${escapeHtml(e.id)}/edit`;
  // Anything not typed by Darius himself (an uploaded document Bench Notes
  // read on its own) is tagged, visibly, every time it's shown — never
  // presented as indistinguishable from his own fact.
  const autoTag = e.source && e.source !== "manual" ? `<span class="status">auto-extracted</span>` : "";
  return `<div class="card">
<div class="case-row"><span class="entry-date">${escapeHtml(e.entry_date)}</span><span class="status">${autoTag}${shared ? `shared ${escapeHtml(e.shared_at)}` : "not shared"} · <form style="display:inline" method="post" action="${toggleAction}"><button type="submit">${shared ? "Unshare" : "Share"}</button></form></span></div>
<div class="entry-layer"><span class="layer-name">Fact</span>${escapeHtml(e.fact)}</div>
${layer("Recommended direction", e.recommended_direction)}
${layer("Commentary", e.commentary)}
${layer("Court takeaways", e.court_takeaways)}
${attachedDocs.length ? attachedDocs.map((d) => renderDocumentRow(base, d)).join("\n") : ""}
<details>
<summary>Edit</summary>
<form method="post" action="${editAction}">
<label for="fact-${escapeHtml(e.id)}">Fact</label>
<textarea id="fact-${escapeHtml(e.id)}" name="fact" required>${escapeHtml(e.fact)}</textarea>
<label for="recommendedDirection-${escapeHtml(e.id)}">Recommended direction (optional)</label>
<textarea id="recommendedDirection-${escapeHtml(e.id)}" name="recommendedDirection">${escapeHtml(e.recommended_direction || "")}</textarea>
<label for="commentary-${escapeHtml(e.id)}">Commentary (optional)</label>
<textarea id="commentary-${escapeHtml(e.id)}" name="commentary">${escapeHtml(e.commentary || "")}</textarea>
<label for="courtTakeaways-${escapeHtml(e.id)}">Court takeaways (optional)</label>
<textarea id="courtTakeaways-${escapeHtml(e.id)}" name="courtTakeaways">${escapeHtml(e.court_takeaways || "")}</textarea>
<button type="submit">Save changes</button>
</form>
</details>
<form method="post" action="${base}/entries/${escapeHtml(e.id)}/delete"><button type="submit">Delete entry</button></form>
</div>`;
}

function renderGlossaryTerm(g) {
  return `<div class="card"><strong>${escapeHtml(g.term)}</strong><div>${escapeHtml(g.definition)}</div></div>`;
}

function renderPattern(p) {
  return `<div class="card"><strong>${escapeHtml(p.subject_name)}</strong> <span class="hint">(${escapeHtml(p.subject_type)})</span><div>${escapeHtml(p.description)}</div></div>`;
}

function documentOwnerHref(d) {
  return d.storage_kind === "upload" ? `${PREFIX}documents/${d.id}/file` : d.storage_ref;
}

function renderDocumentRow(base, d) {
  const shared = Boolean(d.shared_at);
  const toggleAction = `${base}/documents/${escapeHtml(d.id)}/${shared ? "unshare" : "share"}`;
  const deleteAction = `${base}/documents/${escapeHtml(d.id)}/delete`;
  const detailHref = `${PREFIX}documents/${escapeHtml(d.id)}`;
  return `<div class="case-row"><span><a href="${escapeHtml(documentOwnerHref(d))}">${escapeHtml(d.title)}</a>${d.filed_date ? ` <span class="hint">(${escapeHtml(d.filed_date)})</span>` : ""} · <a href="${detailHref}">notes &amp; recordings</a></span><span class="status">${shared ? `shared ${escapeHtml(d.shared_at)}` : "not shared"} · <form style="display:inline" method="post" action="${toggleAction}"><button type="submit">${shared ? "Unshare" : "Share"}</button></form> · <form style="display:inline" method="post" action="${deleteAction}"><button type="submit">Delete</button></form></span></div>`;
}

function renderNoteRow(n) {
  return `<div class="card"><span class="entry-date">${escapeHtml(n.created_at)}</span><div>${escapeHtml(n.body)}</div></div>`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderRecordingRow(base, r) {
  const audio = r.audio_storage_ref
    ? `<audio controls src="${PREFIX}recordings/${escapeHtml(r.id)}/file" style="width:100%;margin-top:0.5em"></audio>${r.audio_duration_seconds ? `<span class="hint">${formatDuration(r.audio_duration_seconds)}</span>` : ""}`
    : "";
  return `<div class="card"><span class="entry-date">${escapeHtml(r.noted_at)}</span>${r.body ? `<div class="entry-layer">${escapeHtml(r.body)}</div>` : ""}${audio}
<form method="post" action="${base}/recordings/${escapeHtml(r.id)}/delete"><button type="submit">Delete</button></form>
</div>`;
}

// A document's own page — where "record or upload multiple recordings per
// document, at different points in time" actually lives, rather than
// crowding the already form-dense case page with it. Reachable from the
// case page's "notes & recordings" link next to each document.
function renderDocumentDetail(caseRow, doc, recordings) {
  const base = `${PREFIX}case/${escapeHtml(caseRow.id)}`;
  const today = new Date().toISOString().slice(0, 10);
  return benchPage(
    doc.title,
    `<header class="bench-header">${STENOTYPE_ICON(40)}<h1>${escapeHtml(doc.title)}<span class="tag">${escapeHtml(caseRow.title)}</span></h1></header>
<p class="note"><a href="${base}">&larr; Back to ${escapeHtml(caseRow.title)}</a></p>
<p class="hint"><a href="${escapeHtml(documentOwnerHref(doc))}">Open the document itself</a>${doc.filed_date ? ` — filed ${escapeHtml(doc.filed_date)}` : ""}</p>

<h2>Notes &amp; recordings</h2>
<p class="hint">Your own thinking about this document, dated, as many as you like, added whenever something changes — never shared, never entrusted-visible.</p>
${recordings.length ? recordings.map((r) => renderRecordingRow(`${base}/documents/${escapeHtml(doc.id)}`, r)).join("\n") : `<p class="hint">Nothing recorded yet.</p>`}

<h3>Add one</h3>
<form method="post" action="${base}/documents/${escapeHtml(doc.id)}/recordings" id="recordingForm" data-blob-upload>
<label for="recordingDate">Date this is about</label>
<input type="date" id="recordingDate" name="notedAt" value="${today}" required>
<label for="recordingBody">Note (optional — type one, or just record and leave this blank)</label>
<textarea id="recordingBody" name="body"></textarea>
<label for="recordingFile">Audio (optional — upload a file, or use Record below)</label>
<input type="file" id="recordingFile" data-blob-file accept="audio/*">
${blobUploadFields()}
<div class="case-row"><button type="button" data-record="recordingForm">● Record</button><span data-record-timer class="hint">00:00</span></div>
<button type="submit">Save</button>
</form>
<script src="${PREFIX}static/bench.js"></script>`,
    { csp: UPLOAD_CSP },
  );
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function renderCaseDetail(caseRow, entries, glossary, patterns, documents, notes) {
  const base = `${PREFIX}case/${escapeHtml(caseRow.id)}`;
  const docsByEntry = new Map();
  const generalDocs = [];
  for (const d of documents) {
    if (d.entry_id) {
      if (!docsByEntry.has(d.entry_id)) docsByEntry.set(d.entry_id, []);
      docsByEntry.get(d.entry_id).push(d);
    } else generalDocs.push(d);
  }
  const entryOptions = entries
    .map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.entry_date)} — ${escapeHtml(truncate(e.fact, 40))}</option>`)
    .join("\n");

  return benchPage(
    caseRow.title,
    `<header class="bench-header">${STENOTYPE_ICON(40)}<h1>${escapeHtml(caseRow.title)}<span class="tag">${escapeHtml(caseRow.status)}${caseRow.case_number ? ` · ${escapeHtml(caseRow.case_number)}` : ""}${caseRow.court ? ` · ${escapeHtml(caseRow.court)}` : ""}</span></h1></header>
<p class="note"><a href="${PREFIX}">&larr; All cases</a></p>

<h2>Timeline</h2>
<p class="hint">Chronological, dated. Each entry can be shared to the entrusted side on its own — sharing shows only the date and the fact, never your recommended direction, commentary, or court takeaways.</p>
${entries.length ? `<div class="spine">${entries.map((e) => renderEntry(base, e, docsByEntry.get(e.id) || [])).join("\n")}</div>` : `<p class="hint">No entries yet.</p>`}
<div class="ticker"></div>
<h2>Add a docket entry</h2>
<form method="post" action="${base}/entries">
<label for="entryDate">Date</label>
<input type="date" id="entryDate" name="entryDate" required>
<label for="fact">Fact — what happened</label>
<textarea id="fact" name="fact" required></textarea>
<label for="recommendedDirection">Recommended direction (optional)</label>
<textarea id="recommendedDirection" name="recommendedDirection"></textarea>
<label for="commentary">Commentary (optional)</label>
<textarea id="commentary" name="commentary"></textarea>
<label for="courtTakeaways">Court takeaways (optional)</label>
<textarea id="courtTakeaways" name="courtTakeaways"></textarea>
<button type="submit">Add entry</button>
</form>

<h2>Documents</h2>
<p class="hint">The files themselves live wherever you're storing them (the document viewer, R2). This is only the reference — and the switch that shares it to the entrusted side, which never happens on its own. A document tied to a timeline entry (below) shows under that entry instead of here.</p>
${generalDocs.length ? generalDocs.map((d) => renderDocumentRow(base, d)).join("\n") : `<p class="hint">No general documents added yet.</p>`}
<form method="post" action="${base}/documents">
<label for="docTitle">Title</label>
<input type="text" id="docTitle" name="docTitle" required>
<label for="storageRef">Where it lives (a link or reference)</label>
<input type="text" id="storageRef" name="storageRef" required>
<label for="filedDate">Filed date (optional)</label>
<input type="date" id="filedDate" name="filedDate">
<label for="entryId">Attach to a timeline entry (optional)</label>
<select id="entryId" name="entryId">
<option value="">General — not tied to one entry</option>
${entryOptions}
</select>
<button type="submit">Add document</button>
</form>

<h2>Notes to the entrusted side</h2>
<p class="hint">Sent to whoever holds a passphrase scoped to this case, immediately — not the same as your own commentary above, which never leaves this page.</p>
${notes.length ? notes.map(renderNoteRow).join("\n") : `<p class="hint">No notes sent yet.</p>`}
<form method="post" action="${base}/notes">
<label for="noteBody">Note</label>
<textarea id="noteBody" name="noteBody" required></textarea>
<button type="submit">Send note</button>
</form>

<h2>Glossary</h2>
${glossary.length ? glossary.map(renderGlossaryTerm).join("\n") : `<p class="hint">No terms yet.</p>`}
<form method="post" action="${base}/glossary">
<label for="term">Term</label>
<input type="text" id="term" name="term" required>
<label for="definition">Definition</label>
<textarea id="definition" name="definition" required></textarea>
<button type="submit">Add term</button>
</form>

<h2>Patterns</h2>
${patterns.length ? patterns.map(renderPattern).join("\n") : `<p class="hint">No patterns flagged yet.</p>`}
<form method="post" action="${base}/patterns">
<label for="subjectType">Who</label>
<select id="subjectType" name="subjectType">
  <option value="judge">Judge</option>
  <option value="opposing-counsel">Opposing counsel</option>
  <option value="other">Other</option>
</select>
<label for="subjectName">Name</label>
<input type="text" id="subjectName" name="subjectName" required>
<label for="description">What you're noticing</label>
<textarea id="description" name="description" required></textarea>
<button type="submit">Flag pattern</button>
</form>

<h2>Delete this case</h2>
<p class="hint">Removes the case and everything under it — every timeline entry, every document and its recordings — permanently. Type the case title exactly to confirm.</p>
<form method="post" action="${base}/delete">
<label for="confirmTitle">Case title</label>
<input type="text" id="confirmTitle" name="confirmTitle" placeholder="${escapeHtml(caseRow.title)}" required>
<button type="submit">Delete case</button>
</form>`,
  );
}

// --- Routing ---

export async function handleBenchGet(request, env, url) {
  const payload = await requireAccess(request, env);
  if (!payload) return forbidden();

  const path = url.pathname.slice(PREFIX.length);
  try {
    if (path === "") {
      const [cases, grants] = await Promise.all([listCases(env), listGrants(env)]);
      const caseTitleById = new Map(cases.map((c) => [c.id, c.title]));
      const grantSummaries = new Map();
      await Promise.all(
        grants.map(async (g) => {
          const caseIds = JSON.parse(g.case_ids_json || "[]");
          const [docs, entries] = await Promise.all([
            listSharedDocuments(env.BENCH_NOTES, caseIds),
            listSharedEntries(env.BENCH_NOTES, caseIds),
          ]);
          grantSummaries.set(g.id, {
            caseTitles: caseIds.map((id) => caseTitleById.get(id) || id),
            docCount: docs.length,
            entryCount: entries.length,
          });
        }),
      );
      return html(renderCaseList(cases, grants, grantSummaries));
    }

    const previewMatch = path.match(/^preview\/([^/]+)$/);
    if (previewMatch) {
      const grant = await env.BENCH_NOTES.prepare("SELECT * FROM access_grants WHERE id = ?").bind(previewMatch[1]).first();
      if (!grant || grant.revoked_at) return notFound();
      const caseIds = JSON.parse(grant.case_ids_json || "[]");
      const [documents, notes, entries] = await Promise.all([
        listSharedDocuments(env.BENCH_NOTES, caseIds),
        listNotesForCases(env.BENCH_NOTES, caseIds),
        listSharedEntries(env.BENCH_NOTES, caseIds),
      ]);
      const banner = `<div class="preview-banner"><span>Previewing as: <strong>${escapeHtml(grant.label || grant.id)}</strong> — read-only, no session created</span><a href="${PREFIX}">&larr; Back to your view</a></div>`;
      return html(
        benchPage(
          "Preview — Bench Notes",
          `<header class="bench-header">${STENOTYPE_ICON()}<h1>Bench Notes<span class="tag">Entrusted access (preview)</span></h1></header>${renderEntrustedView(documents, notes, entries, { previewBanner: banner, documentHref: documentOwnerHref })}`,
        ),
      );
    }

    const caseMatch = path.match(/^case\/([^/]+)$/);
    if (caseMatch) {
      const caseRow = await getCase(env, caseMatch[1]);
      if (!caseRow) return notFound();
      const [entries, glossary, patterns, documents, notes] = await Promise.all([
        listEntries(env, caseRow.id),
        listGlossary(env, caseRow.id),
        listPatterns(env, caseRow.id),
        listDocuments(env, caseRow.id),
        listEntrustedNotes(env, caseRow.id),
      ]);
      return html(renderCaseDetail(caseRow, entries, glossary, patterns, documents, notes));
    }

    const fileMatch = path.match(/^documents\/([^/]+)\/file$/);
    if (fileMatch) {
      const doc = await data.getDocument(env.BENCH_NOTES, fileMatch[1]);
      if (!doc || doc.storage_kind !== "upload") return notFound();
      const object = await env.BENCH_DOCUMENTS.get(doc.storage_ref);
      if (!object) return notFound();
      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType || "application/octet-stream",
          "content-disposition": `inline; filename="${doc.title.replace(/"/g, "")}"`,
          "cache-control": "private, no-store",
        },
      });
    }

    const docDetailMatch = path.match(/^documents\/([^/]+)$/);
    if (docDetailMatch) {
      const doc = await data.getDocument(env.BENCH_NOTES, docDetailMatch[1]);
      if (!doc) return notFound();
      const caseRow = await getCase(env, doc.case_id);
      if (!caseRow) return notFound();
      const recordings = await listDocumentRecordings(env, doc.id);
      return html(renderDocumentDetail(caseRow, doc, recordings));
    }

    const recordingFileMatch = path.match(/^recordings\/([^/]+)\/file$/);
    if (recordingFileMatch) {
      const recording = await env.BENCH_NOTES.prepare("SELECT * FROM document_recordings WHERE id = ?").bind(recordingFileMatch[1]).first();
      if (!recording || !recording.audio_storage_ref) return notFound();
      const object = await env.BENCH_DOCUMENTS.get(recording.audio_storage_ref);
      if (!object) return notFound();
      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType || "application/octet-stream",
          "cache-control": "private, no-store",
        },
      });
    }

    if (path === "static/bench.js") {
      return new Response(BENCH_CLIENT_JS, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "private, max-age=3600" } });
    }
    return notFound();
  } catch (e) {
    return html(errorPage(e.message), 502);
  }
}

// PUT /bench/blobs/:blobId — streams request.body straight to R2. This is
// the fix for the crash: request.body is a ReadableStream R2's put() reads
// as it arrives, never materialized whole in the Worker's own memory,
// unlike the old handler's request.formData() (which must parse — and so
// buffer — an entire multipart body before it resolves) or file.arrayBuffer()
// (a second full in-memory copy on top of that). A blobId is generated
// client-side before the PUT even starts (bench-client-script.js), so this
// route needs nothing back from the caller except confirmation it worked;
// the finalize/recording routes below recompute the identical key from the
// same (blobId, filename) pair rather than this route inventing or storing
// one anywhere.
export async function handleBenchPut(request, env, url) {
  const payload = await requireAccess(request, env);
  if (!payload) return forbidden();

  const path = url.pathname.slice(PREFIX.length);
  const blobMatch = path.match(/^blobs\/([^/]+)$/);
  if (!blobMatch) return notFound();
  const jsonError = (message, status) => new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json" } });
  if (!request.body) return jsonError("No file data received.", 400);

  const filenameHeader = request.headers.get("x-filename");
  let filename = "file";
  try {
    filename = filenameHeader ? decodeURIComponent(filenameHeader) : "file";
  } catch {
    filename = filenameHeader || "file";
  }
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const key = data.benchBlobKey(blobMatch[1], filename);

  try {
    const object = await env.BENCH_DOCUMENTS.put(key, request.body, { httpMetadata: { contentType } });
    if (!object) return jsonError("The upload didn't complete.", 502);
    if (object.size > MAX_STORABLE_BYTES) {
      await env.BENCH_DOCUMENTS.delete(key);
      return jsonError("That file is larger than Bench Notes will store.", 413);
    }
    return new Response(JSON.stringify({ key, size: object.size }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

export async function handleBenchPost(request, env, url) {
  const payload = await requireAccess(request, env);
  if (!payload) return forbidden();

  const path = url.pathname.slice(PREFIX.length);
  const form = await request.formData();

  try {
    if (path === "") {
      const title = form.get("title");
      if (!title) return html(errorPage("A case needs a title."), 400);
      const id = crypto.randomUUID();
      await createCase(env, { id, title, court: form.get("court"), caseNumber: form.get("caseNumber") });
      return Response.redirect(`https://darius.life${PREFIX}case/${id}`, 303);
    }

    if (path === "upload/finalize") {
      // The file's bytes are already in R2 (PUT /bench/blobs/:id, before
      // this ever ran) — this step never reads them itself except through
      // analyzeUploadedDocument's own size-gated, head()-first path. blobId
      // and filename are exactly what the PUT used, so benchBlobKey
      // recomputes the identical key rather than needing it passed back.
      const blobId = form.get("blobId");
      const filename = form.get("filename");
      const contentType = form.get("contentType") || "application/octet-stream";
      if (!blobId || !filename) return html(errorPage("Choose a document to upload."), 400);
      const key = data.benchBlobKey(blobId, filename);
      const head = await env.BENCH_DOCUMENTS.head(key);
      if (!head) return html(errorPage("That upload didn't complete — try again."), 400);

      // What the document is, and which case it belongs to, come from
      // bench-document-ai.js's own read of the file — the only two things
      // Bench Notes doesn't try to read for itself are the bytes (already
      // handled) and Darius's own optional notes.
      const analysis = await analyzeUploadedDocument(env, filename, contentType, head.size, async () => {
        const object = await env.BENCH_DOCUMENTS.get(key);
        return object.arrayBuffer();
      });
      const caseRow = await data.findOrCreateCaseByNumber(env.BENCH_NOTES, analysis.caseNumber, crypto.randomUUID());
      const caseId = caseRow.id;

      const entryId = crypto.randomUUID();
      await addEntry(env, {
        id: entryId,
        caseId,
        caseLabel: caseRow.title,
        entryDate: new Date().toISOString().slice(0, 10),
        fact: analysis.fact,
        commentary: form.get("commentary"),
        source: analysis.source,
      });

      const docId = crypto.randomUUID();
      await addDocument(env, { id: docId, caseId, caseLabel: caseRow.title, entryId, title: filename, storageKind: "upload", storageRef: key });

      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const entriesMatch = path.match(/^case\/([^/]+)\/entries$/);
    if (entriesMatch) {
      const caseId = entriesMatch[1];
      const caseRow = await getCase(env, caseId);
      if (!caseRow) return notFound();
      const entryDate = form.get("entryDate");
      const fact = form.get("fact");
      if (!entryDate || !fact) return html(errorPage("A docket entry needs a date and a fact."), 400);
      await addEntry(env, {
        id: crypto.randomUUID(),
        caseId,
        caseLabel: caseRow.title,
        entryDate,
        fact,
        recommendedDirection: form.get("recommendedDirection"),
        commentary: form.get("commentary"),
        courtTakeaways: form.get("courtTakeaways"),
      });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const entryShareMatch = path.match(/^case\/([^/]+)\/entries\/([^/]+)\/(share|unshare)$/);
    if (entryShareMatch) {
      const [, caseId, entryId, action] = entryShareMatch;
      if (!(await getCase(env, caseId))) return notFound();
      await setEntryShared(env, entryId, action === "share");
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    // Correcting an entry — most useful right after an upload, since an
    // auto-extracted fact (tagged in the UI) is a machine's read of a
    // document, not Darius's own testimony, and can be wrong.
    const entryEditMatch = path.match(/^case\/([^/]+)\/entries\/([^/]+)\/edit$/);
    if (entryEditMatch) {
      const [, caseId, entryId] = entryEditMatch;
      if (!(await getCase(env, caseId))) return notFound();
      const fact = form.get("fact");
      if (!fact) return html(errorPage("A docket entry needs a fact."), 400);
      await updateEntry(env, entryId, {
        fact,
        recommendedDirection: form.get("recommendedDirection"),
        commentary: form.get("commentary"),
        courtTakeaways: form.get("courtTakeaways"),
        source: "manual",
      });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const entryDeleteMatch = path.match(/^case\/([^/]+)\/entries\/([^/]+)\/delete$/);
    if (entryDeleteMatch) {
      const [, caseId, entryId] = entryDeleteMatch;
      if (!(await getCase(env, caseId))) return notFound();
      await deleteEntry(env, entryId);
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const glossaryMatch = path.match(/^case\/([^/]+)\/glossary$/);
    if (glossaryMatch) {
      const caseId = glossaryMatch[1];
      if (!(await getCase(env, caseId))) return notFound();
      const term = form.get("term");
      const definition = form.get("definition");
      if (!term || !definition) return html(errorPage("A glossary entry needs a term and a definition."), 400);
      await addGlossaryTerm(env, { id: crypto.randomUUID(), caseId, term, definition });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const patternsMatch = path.match(/^case\/([^/]+)\/patterns$/);
    if (patternsMatch) {
      const caseId = patternsMatch[1];
      if (!(await getCase(env, caseId))) return notFound();
      const subjectType = form.get("subjectType");
      const subjectName = form.get("subjectName");
      const description = form.get("description");
      if (!subjectName || !description) return html(errorPage("A pattern needs a name and a description."), 400);
      await addPattern(env, { id: crypto.randomUUID(), caseId, subjectType: subjectType || "other", subjectName, description });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const documentsMatch = path.match(/^case\/([^/]+)\/documents$/);
    if (documentsMatch) {
      const caseId = documentsMatch[1];
      const caseRow = await getCase(env, caseId);
      if (!caseRow) return notFound();
      const title = form.get("docTitle");
      const storageRef = form.get("storageRef");
      if (!title || !storageRef) return html(errorPage("A document needs a title and where it lives."), 400);
      if (!data.isPublishableStorageRef(storageRef)) return html(errorPage("Where it lives must be an http(s) address."), 400);
      await addDocument(env, { id: crypto.randomUUID(), caseId, caseLabel: caseRow.title, entryId: form.get("entryId"), title, storageRef, filedDate: form.get("filedDate") });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const shareMatch = path.match(/^case\/([^/]+)\/documents\/([^/]+)\/(share|unshare)$/);
    if (shareMatch) {
      const [, caseId, docId, action] = shareMatch;
      if (!(await getCase(env, caseId))) return notFound();
      await setDocumentShared(env, docId, action === "share");
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const documentDeleteMatch = path.match(/^case\/([^/]+)\/documents\/([^/]+)\/delete$/);
    if (documentDeleteMatch) {
      const [, caseId, docId] = documentDeleteMatch;
      if (!(await getCase(env, caseId))) return notFound();
      if (!(await data.getDocument(env.BENCH_NOTES, docId))) return notFound();
      await deleteDocumentAndBlobs(env, docId);
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const recordingDeleteMatch = path.match(/^case\/([^/]+)\/documents\/([^/]+)\/recordings\/([^/]+)\/delete$/);
    if (recordingDeleteMatch) {
      const [, caseId, docId, recordingId] = recordingDeleteMatch;
      if (!(await getCase(env, caseId))) return notFound();
      const recording = await getDocumentRecording(env, recordingId);
      if (!recording || recording.document_id !== docId) return notFound();
      if (recording.audio_storage_ref) await deleteBlobRefs(env, [recording.audio_storage_ref]);
      await deleteDocumentRecording(env, recordingId);
      return Response.redirect(`https://darius.life${PREFIX}documents/${docId}`, 303);
    }

    const caseDeleteMatch = path.match(/^case\/([^/]+)\/delete$/);
    if (caseDeleteMatch) {
      const caseId = caseDeleteMatch[1];
      const caseRow = await getCase(env, caseId);
      if (!caseRow) return notFound();
      const confirmTitle = (form.get("confirmTitle") || "").trim();
      if (confirmTitle !== caseRow.title) return html(errorPage(`That doesn't match the case title exactly ("${caseRow.title}") — nothing was deleted.`), 400);
      await deleteCaseAndBlobs(env, caseId);
      return Response.redirect(`https://darius.life${PREFIX}`, 303);
    }

    const recordingMatch = path.match(/^case\/([^/]+)\/documents\/([^/]+)\/recordings$/);
    if (recordingMatch) {
      const [, caseId, docId] = recordingMatch;
      const caseRow = await getCase(env, caseId);
      if (!caseRow) return notFound();
      if (!(await data.getDocument(env.BENCH_NOTES, docId))) return notFound();
      const notedAt = form.get("notedAt");
      const body = form.get("body");
      const blobId = form.get("blobId");
      const filename = form.get("filename");
      if (!notedAt) return html(errorPage("Say which date this is about."), 400);
      if (!body && !blobId) return html(errorPage("Add a typed note, a recording, or both — not neither."), 400);

      let audioStorageRef = null;
      let audioMimeType = null;
      if (blobId && filename) {
        const key = data.benchBlobKey(blobId, filename);
        const head = await env.BENCH_DOCUMENTS.head(key);
        if (!head) return html(errorPage("That recording didn't finish uploading — try again."), 400);
        audioStorageRef = key;
        audioMimeType = form.get("contentType") || "application/octet-stream";
      }

      await addDocumentRecording(env, {
        id: crypto.randomUUID(),
        documentId: docId,
        caseId,
        notedAt,
        body,
        audioStorageRef,
        audioMimeType,
      });
      return Response.redirect(`https://darius.life${PREFIX}documents/${docId}`, 303);
    }

    const notesMatch = path.match(/^case\/([^/]+)\/notes$/);
    if (notesMatch) {
      const caseId = notesMatch[1];
      const caseRow = await getCase(env, caseId);
      if (!caseRow) return notFound();
      const body = form.get("noteBody");
      if (!body) return html(errorPage("A note needs a body."), 400);
      await addEntrustedNote(env, { id: crypto.randomUUID(), caseId, caseLabel: caseRow.title, body });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    if (path === "grants") {
      const passphrase = form.get("passphrase");
      if (!passphrase || passphrase.length < 6) return html(errorPage("Passphrase must be at least 6 characters."), 400);
      const caseIds = form.getAll("caseIds");
      const codeHash = await sha256Hex(passphrase);
      await createGrant(env, { id: crypto.randomUUID(), codeHash, caseIds, label: form.get("grantLabel") });
      return Response.redirect(`https://darius.life${PREFIX}`, 303);
    }

    const revokeMatch = path.match(/^grants\/([^/]+)\/revoke$/);
    if (revokeMatch) {
      await revokeGrant(env, revokeMatch[1]);
      return Response.redirect(`https://darius.life${PREFIX}`, 303);
    }

    const passphraseMatch = path.match(/^grants\/([^/]+)\/passphrase$/);
    if (passphraseMatch) {
      const newPassphrase = form.get("newPassphrase");
      if (!newPassphrase || newPassphrase.length < 6) return html(errorPage("Passphrase must be at least 6 characters."), 400);
      await updateGrantPassphrase(env, passphraseMatch[1], await sha256Hex(newPassphrase));
      return Response.redirect(`https://darius.life${PREFIX}`, 303);
    }

    return notFound();
  } catch (e) {
    return html(errorPage(e.message), 502);
  }
}

export const _internal = { renderCaseList, renderCaseDetail, errorPage };
