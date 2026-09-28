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
import { summarizeCase } from "../../shared/bench-case-summary.js";
import { generatePressureTest } from "../../shared/bench-prep.js";
import { buildTodayAgenda, selectVerses } from "../../shared/bench-verse.js";
import { MAX_TRANSCRIBABLE_BYTES, transcribeAudio } from "../../shared/bench-transcribe.js";
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

const todayStr = () => new Date().toISOString().slice(0, 10);

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
const listUpcomingEntries = (env) => data.listUpcomingEntries(env.BENCH_NOTES);
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
const markDocumentFiled = (env, id, filedDate) => data.markDocumentFiled(env.BENCH_NOTES, id, filedDate);
const markDocumentServed = (env, id, fields) => data.markDocumentServed(env.BENCH_NOTES, id, fields);
const updateCaseLocalRules = (env, caseId, notes) => data.updateCaseLocalRules(env.BENCH_NOTES, caseId, notes);
const listResources = (env) => data.listResources(env.BENCH_NOTES);
const addResource = (env, fields) => data.addResource(env.BENCH_NOTES, fields);
const deleteResource = (env, id) => data.deleteResource(env.BENCH_NOTES, id);
const listEntrustedNotes = (env, caseId) => data.listEntrustedNotes(env.BENCH_NOTES, caseId);
const listDocumentRecordings = (env, documentId) => data.listDocumentRecordings(env.BENCH_NOTES, documentId);
const listCaseRecordings = (env, caseId) => data.listCaseRecordings(env.BENCH_NOTES, caseId);
const addDocumentRecording = (env, fields) => data.addDocumentRecording(env.BENCH_NOTES, fields);
const getDocumentRecording = (env, id) => data.getDocumentRecording(env.BENCH_NOTES, id);
const deleteDocumentRecording = (env, id) => data.deleteDocumentRecording(env.BENCH_NOTES, id);
const editRecordingTranscript = (env, id, transcript) => data.editRecordingTranscript(env.BENCH_NOTES, id, transcript);
const setRecordingAffectedDocuments = (env, recordingId, documentIds) => data.setRecordingAffectedDocuments(env.BENCH_NOTES, recordingId, documentIds);
const listRecordingAffectedDocuments = (env, recordingId) => data.listRecordingAffectedDocuments(env.BENCH_NOTES, recordingId);
const listDocumentAffectingRecordings = (env, documentId) => data.listDocumentAffectingRecordings(env.BENCH_NOTES, documentId);
const searchAll = (env, filters) => data.searchAll(env.BENCH_NOTES, filters);
const deleteEntry = (env, id) => data.deleteEntry(env.BENCH_NOTES, id);
const listPrepSessions = (env) => data.listPrepSessions(env.BENCH_NOTES);
const getPrepSession = (env, id) => data.getPrepSession(env.BENCH_NOTES, id);
const addPrepSession = (env, fields) => data.addPrepSession(env.BENCH_NOTES, fields);
const updatePrepSessionPressureTest = (env, id, pressureTest) => data.updatePrepSessionPressureTest(env.BENCH_NOTES, id, pressureTest);
const deletePrepSession = (env, id) => data.deletePrepSession(env.BENCH_NOTES, id);
const listScriptureVerses = (env) => data.listScriptureVerses(env.BENCH_NOTES);
const addScriptureVerse = (env, fields) => data.addScriptureVerse(env.BENCH_NOTES, fields);
const deleteScriptureVerse = (env, id) => data.deleteScriptureVerse(env.BENCH_NOTES, id);
const getDailyVerse = (env, date) => data.getDailyVerse(env.BENCH_NOTES, date);
const setDailyVerse = (env, fields) => data.setDailyVerse(env.BENCH_NOTES, fields);

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

// Re-reads the whole case and asks bench-case-summary.js to synthesize it
// fresh — the one place that happens, called after every write that
// changes what's on record. Never throws: a failed regeneration just
// leaves the previous summary in place until the next successful write,
// same as any other best-effort background task in this file.
export async function regenerateCaseSummary(env, caseId) {
  const caseRow = await getCase(env, caseId);
  if (!caseRow) return;
  const [entries, documents, notes, patterns, glossary, recordings] = await Promise.all([
    listEntries(env, caseId),
    listDocuments(env, caseId),
    listEntrustedNotes(env, caseId),
    listPatterns(env, caseId),
    listGlossary(env, caseId),
    listCaseRecordings(env, caseId),
  ]);
  const { summary } = await summarizeCase(env, { caseRow, entries, documents, notes, patterns, glossary, recordings });
  if (summary) await data.updateCaseSummary(env.BENCH_NOTES, caseId, summary);
}

// Fires regeneration without making the caller (a redirect response) wait
// on an AI call. ctx.waitUntil keeps it alive past the response in the real
// Workers runtime; without a ctx (tests, or any future caller that omits
// one), the promise still runs — just not guaranteed to finish if the
// process exits, which only matters outside a test process that stays
// alive for its own assertions.
function regenerateCaseSummaryInBackground(env, ctx, caseId) {
  const task = regenerateCaseSummary(env, caseId).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(task);
  return task;
}

// The home page's verse-of-the-day, lazy-computed synchronously the first
// time it's needed each day (unlike regenerateCaseSummary above, this is
// deliberately awaited, not backgrounded — the home page has nothing
// meaningful to show below the header until a pick exists for today, so
// there's no earlier response to avoid blocking). Every later load that
// same day just reads back what getDailyVerse already has, no new AI
// call. force=true (the manual "Pick again for today" action) always
// recomputes even if today's pick already exists — see setDailyVerse's
// own INSERT OR REPLACE for why that's safe to call twice.
async function getOrComputeDailyVerse(env, { force = false } = {}) {
  const today = todayStr();
  if (!force) {
    const existing = await getDailyVerse(env, today);
    if (existing) return existing;
  }
  const verses = await listScriptureVerses(env);
  if (!verses.length) return null; // nothing curated yet — plainly nothing to show, never a fabricated pick

  const [upcomingEntries, prepSessions] = await Promise.all([listUpcomingEntries(env), listPrepSessions(env)]);
  const agenda = buildTodayAgenda(upcomingEntries, prepSessions, today);
  const { picks } = await selectVerses(env, verses, agenda, { count: 1 });
  if (!picks.length) return null; // the model didn't return a valid pick — no verse shown today, never a guess

  await setDailyVerse(env, { date: today, verseId: picks[0].verseId, rationale: picks[0].reason });
  return getDailyVerse(env, today);
}

// Reads a recording's own audio from R2 and asks bench-transcribe.js to
// turn it into text — the one place that happens, called right after a
// recording with audio is added. Never throws: a failed or skipped
// transcription just leaves transcript/transcript_error null/set and the
// recording itself untouched — audio is never lost over a transcription
// failure, same "best-effort, never blocks the write that triggered it"
// contract as regenerateCaseSummary.
export async function transcribeRecording(env, recordingId) {
  const recording = await getDocumentRecording(env, recordingId);
  if (!recording?.audio_storage_ref) return;
  const head = await env.BENCH_DOCUMENTS.head(recording.audio_storage_ref);
  if (!head || head.size > MAX_TRANSCRIBABLE_BYTES) return;
  const object = await env.BENCH_DOCUMENTS.get(recording.audio_storage_ref);
  if (!object) return;
  const bytes = await object.arrayBuffer();
  const { transcript, error } = await transcribeAudio(env, bytes);
  await data.updateRecordingTranscript(env.BENCH_NOTES, recordingId, transcript, error);
}

// Transcription, then a case summary regeneration once the transcript is
// there to inform it — chained so a voice note's own content reaches the
// summary without a second write. ctx.waitUntil, same non-blocking pattern
// as regenerateCaseSummaryInBackground.
function transcribeAndRegenerateInBackground(env, ctx, recordingId, caseId) {
  const task = transcribeRecording(env, recordingId)
    .catch(() => {})
    .then(() => regenerateCaseSummary(env, caseId))
    .catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(task);
  return task;
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

// Shown just below the header, home page only. dailyVerse is
// getOrComputeDailyVerse's own return — null means either nothing is
// curated yet (verses.length === 0) or the model didn't return a usable
// pick today; either way, this says that plainly rather than showing
// anything invented. verse.text/reference/translation always come from
// getDailyVerse's own join against scripture_verses — never from
// dailyVerse.rationale, which is only ever the model's stated reason, put
// next to the verse for context, never the verse itself.
function renderDailyVerseCard(dailyVerse) {
  if (!dailyVerse) {
    return `<div class="card"><p class="hint">No verse of the day yet — <a href="${PREFIX}scripture">add a few to your curated set</a> to start seeing one here.</p></div>`;
  }
  const { verse, rationale } = dailyVerse;
  return `<div class="card">
<strong>${escapeHtml(verse.reference)}</strong> <span class="hint">(${escapeHtml(verse.translation)})</span>
<div class="entry-layer">${escapeHtml(verse.text)}</div>
${rationale ? `<p class="hint">${escapeHtml(rationale)}</p>` : ""}
<form style="display:inline" method="post" action="${PREFIX}scripture/daily/refresh"><button type="submit">Pick again for today</button></form>
</div>`;
}

function renderCaseList(cases, grants, grantSummaries, upcomingByCase, dailyVerse) {
  const rows = cases.length
    ? cases.map((c) => {
        const upcoming = upcomingByCase?.get(c.id);
        const upcomingTag = upcoming ? ` · <span class="status">${escapeHtml(upcoming.entry_kind)} ${escapeHtml(upcoming.entry_date)}</span>` : "";
        return `<div class="case-row"><a href="${PREFIX}case/${escapeHtml(c.id)}">${escapeHtml(c.title)}</a><span class="status">${escapeHtml(c.status)}${c.case_number ? ` · ${escapeHtml(c.case_number)}` : ""}${upcomingTag}</span></div>`;
      }).join("\n")
    : `<p class="hint">No cases yet — upload a document below, or add one the long way further down.</p>`;
  const grantRows = grants.length ? grants.map((g) => renderGrantRow(g, grantSummaries.get(g.id))).join("\n") : `<p class="hint">No entrusted access granted yet.</p>`;
  const caseCheckboxes = cases.map((c) => `<label class="opt"><input type="checkbox" name="caseIds" value="${escapeHtml(c.id)}"> ${escapeHtml(c.title)}</label>`).join("\n");

  return benchPage(
    "Bench Notes",
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>Bench Notes<span class="tag">Working docket — private</span></h1></header>
${renderDailyVerseCard(dailyVerse)}
<p class="hint">Your own case timelines. Nothing here is visible to anyone on the entrusted side unless you explicitly share a document.</p>
<p class="note"><a href="${PREFIX}prep">Hearing &amp; presentation prep &rarr;</a> · <a href="${PREFIX}scripture">Scripture &rarr;</a> · <a href="${PREFIX}resources">Resources — self-help, legal aid, advocacy contacts &rarr;</a> · <a href="${PREFIX}search">Search everything &rarr;</a></p>

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

// note (a chronological fact, the default) | hearing | deadline — never
// inferred, same explicit-or-default rule as source below. hearing/deadline
// entries whose date hasn't passed yet drive renderUpcoming's banner.
const ENTRY_KINDS = [
  { value: "note", label: "Note" },
  { value: "hearing", label: "Hearing" },
  { value: "deadline", label: "Deadline" },
];
function entryKindSelect(id, selected) {
  const options = ENTRY_KINDS.map((k) => `<option value="${k.value}"${k.value === (selected || "note") ? " selected" : ""}>${k.label}</option>`).join("\n");
  return `<label for="${id}">Kind</label>
<select id="${id}" name="entryKind">
${options}
</select>`;
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
  const kindTag = e.entry_kind && e.entry_kind !== "note" ? `<span class="status">${escapeHtml(e.entry_kind)}</span>` : "";
  return `<div class="card">
<div class="case-row"><span class="entry-date">${escapeHtml(e.entry_date)}</span><span class="status">${kindTag}${autoTag}${shared ? `shared ${escapeHtml(e.shared_at)}` : "not shared"} · <form style="display:inline" method="post" action="${toggleAction}"><button type="submit">${shared ? "Unshare" : "Share"}</button></form></span></div>
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
${entryKindSelect(`entryKind-${escapeHtml(e.id)}`, e.entry_kind)}
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

// The one place a hearing/deadline actually becomes visible as something
// to act on, rather than just another timeline row — every hearing/deadline
// entry across the record whose own date hasn't passed yet, soonest first.
// Never a calculated deadline: only what Darius (or an edit) has already
// tagged as one, on a date he already entered.
function renderUpcoming(entries) {
  const today = todayStr();
  const upcoming = entries
    .filter((e) => e.entry_kind && e.entry_kind !== "note" && e.entry_date >= today)
    .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0));
  if (!upcoming.length) return "";
  return `<div class="card upcoming"><strong>Upcoming</strong>
${upcoming.map((e) => `<div class="case-row"><span class="entry-date">${escapeHtml(e.entry_date)} · ${escapeHtml(e.entry_kind)}</span><span>${escapeHtml(truncate(e.fact, 60))}</span></div>`).join("\n")}
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

// drafted (default) | filed | served — a record of what Darius has done
// with this document, never guidance about what he must do or when. The
// richer "mark served" form (method, who, proof of service) lives on the
// document's own detail page; this row only offers the one-field "mark
// filed" quick action, since that's all filing needs before service can
// even be recorded.
function filingStatusLabel(d) {
  if (d.filing_status === "served") return `served${d.served_at ? ` ${escapeHtml(d.served_at)}` : ""}`;
  if (d.filing_status === "filed") return `filed${d.filed_date ? ` ${escapeHtml(d.filed_date)}` : ""}`;
  return "drafted";
}

function renderDocumentRow(base, d) {
  const shared = Boolean(d.shared_at);
  const toggleAction = `${base}/documents/${escapeHtml(d.id)}/${shared ? "unshare" : "share"}`;
  const deleteAction = `${base}/documents/${escapeHtml(d.id)}/delete`;
  const fileAction = `${base}/documents/${escapeHtml(d.id)}/file`;
  const detailHref = `${PREFIX}documents/${escapeHtml(d.id)}`;
  const markFiledForm = d.filing_status === "drafted"
    ? `<form style="display:inline" method="post" action="${fileAction}"><input type="date" name="filedDate" value="${todayStr()}" style="display:inline;width:auto;margin:0"> <button type="submit">Mark filed</button></form> · `
    : "";
  return `<div class="case-row"><span><a href="${escapeHtml(documentOwnerHref(d))}">${escapeHtml(d.title)}</a> · <a href="${detailHref}">notes, recordings &amp; service</a></span><span class="status">${filingStatusLabel(d)} · ${markFiledForm}${shared ? `shared ${escapeHtml(d.shared_at)}` : "not shared"} · <form style="display:inline" method="post" action="${toggleAction}"><button type="submit">${shared ? "Unshare" : "Share"}</button></form> · <form style="display:inline" method="post" action="${deleteAction}"><button type="submit">Delete</button></form></span></div>`;
}

function renderNoteRow(n) {
  return `<div class="card"><span class="entry-date">${escapeHtml(n.created_at)}</span><div>${escapeHtml(n.body)}</div></div>`;
}

// The one place bench-case-summary.js's output is shown — deliberately
// never inline with Darius's own notes above without this label, and
// never in a form that could be mistaken for something he wrote himself.
function renderCaseSummary(base, caseRow) {
  const refreshForm = `<form method="post" action="${base}/summary/refresh"><button type="submit">Refresh summary now</button></form>`;
  if (!caseRow.ai_summary) {
    return `<h2>Case summary</h2>
<p class="hint">Generated automatically from what's on record below — not legal advice, not a prediction, and never a substitute for reading the record yourself. Nothing to summarize yet.</p>
${refreshForm}`;
  }
  return `<h2>Case summary</h2>
<p class="hint">Machine-generated from everything on record below (entries, documents, notes, patterns, glossary) — not legal advice, not a prediction, never Darius's own words. Regenerates automatically as the record changes.${caseRow.ai_summary_updated_at ? ` Last updated ${escapeHtml(caseRow.ai_summary_updated_at)}.` : ""}</p>
<div class="card" style="white-space:pre-wrap">${escapeHtml(caseRow.ai_summary)}</div>
${refreshForm}`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The transcript is Whisper's own read of the audio above it, not
// something Darius typed — tagged "auto-transcribed" the same way an
// upload-read docket entry is, until he corrects it (see the edit form
// below and bench-data.js's editRecordingTranscript), at which point the
// tag drops just like an entry's does on edit.
function renderTranscript(base, r) {
  if (!r.audio_storage_ref) return "";
  if (r.transcript) {
    const tag = r.transcript_source === "manual" ? "" : `<span class="status">auto-transcribed</span>`;
    return `<div class="entry-layer"><span class="layer-name">Transcript</span>${tag}${escapeHtml(r.transcript)}</div>
<details><summary>Correct this transcript</summary>
<form method="post" action="${base}/recordings/${escapeHtml(r.id)}/edit">
<textarea name="transcript" required>${escapeHtml(r.transcript)}</textarea>
<button type="submit">Save correction</button>
</form></details>`;
  }
  if (r.transcript_error) return `<p class="hint">Transcription didn't complete — the audio itself is still saved above.</p>`;
  return `<p class="hint">Transcribing…</p>`;
}

// note (default) | correction | contradiction | update — Darius's own
// explicit choice for what kind of input this actually is, never inferred
// from the note/transcript text. A different axis entirely from
// docket_entries.entry_kind (that's about timing — hearing/deadline vs. a
// plain fact — this is about the input's own nature).
const RECORDING_CONTENT_TYPES = [
  { value: "note", label: "Note" },
  { value: "correction", label: "Correction" },
  { value: "contradiction", label: "Contradiction" },
  { value: "update", label: "Update" },
];
// Named noteContentType, not contentType — blobUploadFields() already
// uses "contentType" for an uploaded file's MIME type (data-blob-content-
// type), and this form can carry both at once.
function contentTypeSelect(id, selected) {
  const options = RECORDING_CONTENT_TYPES.map((k) => `<option value="${k.value}"${k.value === (selected || "note") ? " selected" : ""}>${k.label}</option>`).join("\n");
  return `<label for="${id}">Kind of input</label>
<select id="${id}" name="noteContentType">
${options}
</select>`;
}

// affectedDocuments/relatedEntry are precomputed by the caller
// (handleBenchGet's docDetailMatch) — see listRecordingAffectedDocuments
// and the entries already fetched for the page, rather than this
// function querying anything itself.
function renderRecordingRow(base, r, { affectedDocuments = [], relatedEntry = null } = {}) {
  const audio = r.audio_storage_ref
    ? `<audio controls src="${PREFIX}recordings/${escapeHtml(r.id)}/file" style="width:100%;margin-top:0.5em"></audio>${r.audio_duration_seconds ? `<span class="hint">${formatDuration(r.audio_duration_seconds)}</span>` : ""}`
    : "";
  const contentTag = r.content_type && r.content_type !== "note" ? `<span class="status">${escapeHtml(r.content_type)}</span>` : "";
  const relatedLine = relatedEntry ? `<p class="hint">Relates to: ${escapeHtml(relatedEntry.entry_date)} — ${escapeHtml(truncate(relatedEntry.fact, 60))}</p>` : "";
  const affectedLine = affectedDocuments.length
    ? `<p class="hint">Also affects: ${affectedDocuments.map((d) => `<a href="${PREFIX}documents/${escapeHtml(d.id)}">${escapeHtml(d.title)}</a>`).join(", ")}</p>`
    : "";
  return `<div class="card"><span class="entry-date">${escapeHtml(r.noted_at)}</span>${contentTag}${r.body ? `<div class="entry-layer">${escapeHtml(r.body)}</div>` : ""}${audio}
${renderTranscript(base, r)}
${relatedLine}${affectedLine}
<form method="post" action="${base}/recordings/${escapeHtml(r.id)}/delete"><button type="submit">Delete</button></form>
</div>`;
}

// The reverse view — recordings filed under some OTHER document in this
// case that named this one as also affected (recording_documents), shown
// on this document's own page so its full reach is visible from here too.
function renderAffectingRecordings(affectingRecordings, documentTitleById) {
  if (!affectingRecordings.length) return "";
  return `<h3>Also mentioned in</h3>
<p class="hint">Voice notes filed under another document in this case that named this one as also affected.</p>
${affectingRecordings.map((r) => `<div class="card"><span class="entry-date">${escapeHtml(r.noted_at)}</span><span class="status">${escapeHtml(r.content_type)}</span>${r.body ? `<div class="entry-layer">${escapeHtml(r.body)}</div>` : r.transcript ? `<div class="entry-layer">${escapeHtml(r.transcript)}</div>` : ""}<p class="hint">From <a href="${PREFIX}documents/${escapeHtml(r.document_id)}">${escapeHtml(documentTitleById.get(r.document_id) || "another document")}</a></p></div>`).join("\n")}`;
}

// Filing/service is a record of what Darius has actually done, never a
// deadline or requirement Bench Notes calculates for him — see the
// schema's own comment on documents.filing_status. Three states, each
// showing only the next action that makes sense: mark filed, then mark
// served (with an optional proof-of-service upload — the same streaming
// blob-PUT flow recordings already use), then just the record of both.
function renderFilingSection(base, doc) {
  const fileAction = `${base}/documents/${escapeHtml(doc.id)}/file`;
  const serveAction = `${base}/documents/${escapeHtml(doc.id)}/serve`;
  const proofHref = `${PREFIX}documents/${escapeHtml(doc.id)}/proof-of-service/file`;

  if (doc.filing_status === "drafted") {
    return `<h2>Filing &amp; service</h2>
<p class="hint">Not yet marked filed. This only records what you've done — never a deadline or requirement calculated for you.</p>
<form method="post" action="${fileAction}">
<label for="filedDate">Date filed</label>
<input type="date" id="filedDate" name="filedDate" value="${todayStr()}" required>
<button type="submit">Mark filed</button>
</form>`;
  }

  if (doc.filing_status === "filed") {
    return `<h2>Filing &amp; service</h2>
<p class="hint">Filed ${escapeHtml(doc.filed_date || "")}. Not yet marked served.</p>
<form method="post" action="${serveAction}" data-blob-upload>
<label for="servedAt">Date served</label>
<input type="date" id="servedAt" name="servedAt" value="${todayStr()}" required>
<label for="servedMethod">How</label>
<select id="servedMethod" name="servedMethod">
<option value="mail">Mail</option>
<option value="personal">Personal service</option>
<option value="sheriff">Sheriff / process server</option>
<option value="other">Other</option>
</select>
<label for="servedOn">Who was served (optional)</label>
<input type="text" id="servedOn" name="servedOn" placeholder="e.g. Respondent, Jane Doe">
<label for="proofFile">Proof of service (optional — a receipt, a signed certificate, a sheriff's return)</label>
<input type="file" id="proofFile" data-blob-file>
${blobUploadFields()}
<button type="submit">Mark served</button>
</form>`;
  }

  return `<h2>Filing &amp; service</h2>
<p class="hint">Filed ${escapeHtml(doc.filed_date || "")}. Served ${escapeHtml(doc.served_at || "")}${doc.served_method ? ` by ${escapeHtml(doc.served_method)}` : ""}${doc.served_on ? `, on ${escapeHtml(doc.served_on)}` : ""}.</p>
${doc.proof_of_service_ref ? `<p class="hint"><a href="${proofHref}">Open proof of service</a></p>` : `<p class="hint">No proof of service on file.</p>`}`;
}

// A document's own page — where "record or upload multiple recordings per
// document, at different points in time" actually lives, rather than
// crowding the already form-dense case page with it. Reachable from the
// case page's "notes, recordings & service" link next to each document.
function renderDocumentDetail(caseRow, doc, recordings, { entries = [], otherDocuments = [], affectedByRecording = new Map(), affectingRecordings = [], documentTitleById = new Map() } = {}) {
  const base = `${PREFIX}case/${escapeHtml(caseRow.id)}`;
  const today = todayStr();
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const recordingRows = recordings.length
    ? recordings.map((r) => renderRecordingRow(`${base}/documents/${escapeHtml(doc.id)}`, r, {
        affectedDocuments: affectedByRecording.get(r.id) || [],
        relatedEntry: r.related_entry_id ? entryById.get(r.related_entry_id) : null,
      })).join("\n")
    : `<p class="hint">Nothing recorded yet.</p>`;
  return benchPage(
    doc.title,
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>${escapeHtml(doc.title)}<span class="tag">${escapeHtml(caseRow.title)}</span></h1></header>
<p class="note"><a href="${base}">&larr; Back to ${escapeHtml(caseRow.title)}</a> · <a href="${PREFIX}search">Search everything &rarr;</a></p>
<p class="hint"><a href="${escapeHtml(documentOwnerHref(doc))}">Open the document itself</a></p>

${renderFilingSection(base, doc)}

<h2>Notes &amp; recordings</h2>
<p class="hint">Your own thinking about this document, dated, as many as you like, added whenever something changes — never shared, never entrusted-visible.</p>
${recordingRows}
${renderAffectingRecordings(affectingRecordings, documentTitleById)}

<h3>Add one</h3>
<form method="post" action="${base}/documents/${escapeHtml(doc.id)}/recordings" id="recordingForm" data-blob-upload>
<label for="recordingDate">Date this is about</label>
<input type="date" id="recordingDate" name="notedAt" value="${today}" required>
<label for="recordingBody">Note (optional — type one, or just record and leave this blank)</label>
<textarea id="recordingBody" name="body"></textarea>
${contentTypeSelect("recordingContentType", "note")}
<label for="recordingRelatedEntry">Relates to / corrects (optional)</label>
<select id="recordingRelatedEntry" name="relatedEntryId">
<option value="">None</option>
${entryOptionsList(entries)}
</select>
${otherDocuments.length ? `<label for="recordingAffectedDocs">Also affects (optional — an update or correction that touches more than just this document; hold Ctrl/Cmd to pick more than one)</label>
<select id="recordingAffectedDocs" name="affectedDocumentIds" multiple>
${documentOptionsList(otherDocuments)}
</select>` : ""}
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

// Shared by both the "attach to a timeline entry" select (documents) and
// the "relates to / corrects" select (recordings) — one place that
// decides how an entry is labeled in a dropdown.
function entryOptionsList(entries) {
  return entries
    .map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.entry_date)} — ${escapeHtml(truncate(e.fact, 40))}</option>`)
    .join("\n");
}

function documentOptionsList(documents, selectedIds = []) {
  return documents
    .map((d) => `<option value="${escapeHtml(d.id)}"${selectedIds.includes(d.id) ? " selected" : ""}>${escapeHtml(d.title)}</option>`)
    .join("\n");
}

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
  const entryOptions = entryOptionsList(entries);

  return benchPage(
    caseRow.title,
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>${escapeHtml(caseRow.title)}<span class="tag">${escapeHtml(caseRow.status)}${caseRow.case_number ? ` · ${escapeHtml(caseRow.case_number)}` : ""}${caseRow.court ? ` · ${escapeHtml(caseRow.court)}` : ""}</span></h1></header>
<p class="note"><a href="${PREFIX}">&larr; All cases</a> · <a href="${base}/packet">Filing packet (print/export) &rarr;</a></p>

${renderCaseSummary(base, caseRow)}

${renderUpcoming(entries)}

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
${entryKindSelect("entryKind", "note")}
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

<h2>This court's rules &amp; procedure notes</h2>
<p class="hint">Your own words, from your own court's clerk, self-help center, or local rules — never generated by Bench Notes, and never guidance about what's actually required. A place to keep it in one spot.</p>
${caseRow.local_rules_notes ? `<div class="card" style="white-space:pre-wrap">${escapeHtml(caseRow.local_rules_notes)}</div>` : `<p class="hint">Nothing saved yet.</p>`}
<form method="post" action="${base}/local-rules">
<textarea name="notes" placeholder="Paste or type what you've learned about this court's own requirements...">${escapeHtml(caseRow.local_rules_notes || "")}</textarea>
<button type="submit">Save</button>
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

// A printable index, not a real merged PDF — deliberately: merging the
// documents' own PDF bytes in-Worker would reintroduce the same kind of
// CPU-bound work bench-document-ai.js's own header explains moving off
// this Worker's CPU entirely (see "Runs entirely on the Workers Free
// plan" in README.md). A browser's own Print-to-PDF (Ctrl/Cmd+P), on this
// plain page, costs this Worker nothing and needs no library at all.
function renderFilingPacket(caseRow, documents) {
  const rows = documents.length
    ? documents.map((d) => `<div class="case-row"><span>${escapeHtml(d.title)}</span><span class="status">${filingStatusLabel(d)}</span></div>`).join("\n")
    : `<p class="hint">No documents on file yet.</p>`;
  return benchPage(
    `Filing packet — ${caseRow.title}`,
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>${escapeHtml(caseRow.title)}<span class="tag">Filing packet${caseRow.case_number ? ` · ${escapeHtml(caseRow.case_number)}` : ""}${caseRow.court ? ` · ${escapeHtml(caseRow.court)}` : ""}</span></h1></header>
<p class="note"><a href="${PREFIX}case/${escapeHtml(caseRow.id)}">&larr; Back to ${escapeHtml(caseRow.title)}</a> — use your browser's own Print (Ctrl/Cmd+P) to save this as a PDF.</p>
<h2>Documents</h2>
${rows}`,
  );
}

// Rehearsal for an upcoming hearing OR a design presentation/meeting — one
// shared area, two event kinds, told apart explicitly by session.kind
// (never guessed from wording). A hearing-kind session may link to one of
// Darius's own cases (so its pressure test can draw on that case's own
// flagged patterns); a presentation-kind session never has one. See the
// schema's own comment on prep_sessions for the full reasoning.
function renderPrepList(sessions, cases) {
  const caseTitleById = new Map(cases.map((c) => [c.id, c.title]));
  const rows = sessions.length
    ? sessions.map((s) => {
        const caseTag = s.case_id ? ` · ${escapeHtml(caseTitleById.get(s.case_id) || s.case_id)}` : "";
        return `<div class="case-row"><a href="${PREFIX}prep/${escapeHtml(s.id)}">${escapeHtml(s.title)}</a><span class="status">${escapeHtml(s.kind)}${s.event_date ? ` · ${escapeHtml(s.event_date)}` : ""}${caseTag}</span></div>`;
      }).join("\n")
    : `<p class="hint">Nothing to prepare for yet.</p>`;
  const caseOptions = cases.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)}</option>`).join("\n");

  return benchPage(
    "Prep",
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>Prep<span class="tag">Hearings &amp; presentations</span></h1></header>
<p class="note"><a href="${PREFIX}">&larr; All cases</a></p>
<p class="hint">Rehearsal for a hearing or for a design presentation/meeting — the same area either way, since it's the same kind of pressure either way. A "Generate pressure test" gives you specific, concrete questions or challenges to rehearse answering, grounded only in what's on record (a flagged pattern for a hearing, or what you describe below for a presentation) — never advice on what to say, never a prediction.</p>
${rows}
<h3>Add a prep session</h3>
<form method="post" action="${PREFIX}prep">
<label for="prepKind">Kind</label>
<select id="prepKind" name="kind">
<option value="hearing">Hearing</option>
<option value="presentation">Presentation / meeting</option>
</select>
<label for="prepTitle">Title</label>
<input type="text" id="prepTitle" name="title" required>
<label for="prepCase">Case (hearing prep only — leave blank for a presentation)</label>
<select id="prepCase" name="caseId">
<option value="">(none)</option>
${caseOptions}
</select>
<label for="prepDate">Date (optional)</label>
<input type="date" id="prepDate" name="eventDate">
<label for="prepContext">Context — who's involved, what's at stake, what's been raised before</label>
<textarea id="prepContext" name="context"></textarea>
<button type="submit">Add</button>
</form>`,
  );
}

function renderPrepDetail(session, { caseRow = null, patterns = [], entries = [] } = {}) {
  const base = `${PREFIX}prep/${escapeHtml(session.id)}`;
  const caseLine = caseRow ? `<p class="hint">Case: <a href="${PREFIX}case/${escapeHtml(caseRow.id)}">${escapeHtml(caseRow.title)}</a></p>` : "";
  const patternRows = patterns.length
    ? patterns.map((p) => `<div class="card"><strong>${escapeHtml(p.subject_name)}</strong> <span class="hint">(${escapeHtml(p.subject_type)})</span><div>${escapeHtml(p.description)}</div></div>`).join("\n")
    : "";
  const entryRows = entries.length
    ? entries.map((e) => `<div class="card"><span class="entry-date">${escapeHtml(e.entry_date)}</span><span class="status">${escapeHtml(e.entry_kind)}</span><div class="entry-layer">${escapeHtml(e.fact)}</div></div>`).join("\n")
    : "";
  const pressureTestBlock = session.pressure_test
    ? `<div class="card"><h3>Pressure test</h3><div class="entry-layer">${escapeHtml(session.pressure_test).replace(/\n/g, "<br>")}</div><p class="hint">Generated ${escapeHtml(session.pressure_test_updated_at || "")}</p></div>`
    : `<p class="hint">No pressure test generated yet.</p>`;

  return benchPage(
    session.title,
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>${escapeHtml(session.title)}<span class="tag">${escapeHtml(session.kind)}${session.event_date ? ` · ${escapeHtml(session.event_date)}` : ""}</span></h1></header>
<p class="note"><a href="${PREFIX}prep">&larr; All prep sessions</a></p>
${caseLine}
${session.context ? `<div class="card"><h3>Context</h3><div class="entry-layer">${escapeHtml(session.context)}</div></div>` : ""}
${session.kind === "hearing" ? `<h3>Patterns on record for this case</h3>${patternRows || `<p class="hint">None flagged yet.</p>`}<h3>Upcoming hearings/deadlines on record for this case</h3>${entryRows || `<p class="hint">None on record.</p>`}` : ""}
${pressureTestBlock}
<form method="post" action="${base}/pressure-test"><button type="submit">${session.pressure_test ? "Regenerate" : "Generate"} pressure test</button></form>
<p class="note"><a href="${PREFIX}prep">All prep sessions</a></p>
<form method="post" action="${base}/delete" onsubmit="return confirm('Delete this prep session?')"><button type="submit">Delete</button></form>`,
  );
}

// The curated verse set — Darius's own, built up front rather than left
// to the model. See the schema's own comment on scripture_verses for why
// this table is the entire anti-hallucination boundary for scripture: the
// model only ever picks among these rows (bench-verse.js), it never
// writes verse text itself, and its picked id is always checked against
// this exact list before anything is shown.
function renderScriptureLibrary(verses) {
  const rows = verses.length
    ? verses.map((v) => `<div class="card"><strong>${escapeHtml(v.reference)}</strong> <span class="hint">(${escapeHtml(v.translation)})</span><div class="entry-layer">${escapeHtml(v.text)}</div>${v.tags ? `<p class="hint">Tags: ${escapeHtml(v.tags)}</p>` : ""}<form method="post" action="${PREFIX}scripture/${escapeHtml(v.id)}/delete"><button type="submit">Delete</button></form></div>`).join("\n")
    : `<p class="hint">Nothing curated yet — add a verse below to start seeing a verse of the day on the home page.</p>`;
  return benchPage(
    "Scripture",
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>Scripture<span class="tag">Your curated set</span></h1></header>
<p class="note"><a href="${PREFIX}">&larr; All cases</a> · <a href="${PREFIX}scripture/research">Research &rarr;</a></p>
<p class="hint">Only verses in this list ever show up as the verse of the day or in research below. The model only ever picks among these by id; it's never asked to write out scripture itself, so nothing here can be misquoted or invented. Seeded with 14 starting verses (World English Bible — public domain, modern English), sourced directly from ebible.org rather than assumed — a starting point for your own review, not a finished or authoritative set. Delete any you don't want, and add your own.</p>
${rows}
<h3>Add a verse</h3>
<form method="post" action="${PREFIX}scripture">
<label for="verseReference">Reference</label>
<input type="text" id="verseReference" name="reference" placeholder="e.g. Philippians 4:6-7" required>
<label for="verseTranslation">Translation</label>
<input type="text" id="verseTranslation" name="translation" placeholder="e.g. WEB" required>
<label for="verseText">Text — exactly as you want it shown</label>
<textarea id="verseText" name="text" required></textarea>
<label for="verseTags">Tags (optional, comma-separated — e.g. anxiety, courage, waiting)</label>
<input type="text" id="verseTags" name="tags">
<button type="submit">Add</button>
</form>`,
  );
}

// Deeper research than a single daily pick: a free-text description of
// what's actually pressing right now (not just a word/passage to search
// for), matched against the same curated set and the same
// never-invented-text boundary as the daily verse. Up to several matches,
// each with the model's own stated reason, next to the verse's own real
// text — never a substitute for it.
function renderScriptureResearch(query, matches, error) {
  const rows = matches?.length
    ? matches.map((m) => `<div class="card"><strong>${escapeHtml(m.verse.reference)}</strong> <span class="hint">(${escapeHtml(m.verse.translation)})</span><div class="entry-layer">${escapeHtml(m.verse.text)}</div>${m.reason ? `<p class="hint">${escapeHtml(m.reason)}</p>` : ""}</div>`).join("\n")
    : "";
  return benchPage(
    "Scripture research",
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>Scripture research<span class="tag">Beyond a word or a passage</span></h1></header>
<p class="note"><a href="${PREFIX}scripture">&larr; Your curated set</a></p>
<p class="hint">Describe what's actually pressing right now — a hearing, a presentation, a specific worry — rather than just a word to search for. Matches only ever come from your curated set above, by id; the model never writes scripture text itself.</p>
<form method="get" action="${PREFIX}scripture/research">
<label for="researchQ">What's on your mind</label>
<textarea id="researchQ" name="q">${escapeHtml(query || "")}</textarea>
<button type="submit">Search</button>
</form>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${query ? (rows || `<p class="hint">Nothing matched.</p>`) : ""}`,
  );
}

// Not case-scoped, not AI-generated, not maintained by anyone but Darius —
// see schema/bench-notes.sql's own comment on the resources table for why
// exactly one entry is seeded rather than assumed.
function renderResources(resources) {
  const rows = resources.length
    ? resources.map((r) => `<div class="card"><strong>${escapeHtml(r.name)}</strong>${r.phone ? ` · ${escapeHtml(r.phone)}` : ""}${r.url ? ` · <a href="${escapeHtml(r.url)}">${escapeHtml(r.url)}</a>` : ""}${r.notes ? `<div class="hint">${escapeHtml(r.notes)}</div>` : ""}<form method="post" action="${PREFIX}resources/${escapeHtml(r.id)}/delete"><button type="submit">Delete</button></form></div>`).join("\n")
    : `<p class="hint">Nothing added yet.</p>`;
  return benchPage(
    "Resources",
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>Resources<span class="tag">Your own list</span></h1></header>
<p class="note"><a href="${PREFIX}">&larr; All cases</a></p>
<p class="hint">A place for your own courthouse self-help center, legal aid, and advocacy contacts. Nothing here is written by Bench Notes itself, except the one seeded entry below — checked directly (a web search, not assumed) before being added, since a wrong number in a safety context is a real harm. Everything else is yours to add.</p>
${rows}
<h3>Add one</h3>
<form method="post" action="${PREFIX}resources">
<label for="resName">Name</label>
<input type="text" id="resName" name="name" required>
<label for="resPhone">Phone (optional)</label>
<input type="text" id="resPhone" name="phone">
<label for="resUrl">Link (optional)</label>
<input type="text" id="resUrl" name="url">
<label for="resNotes">Notes (optional)</label>
<textarea id="resNotes" name="notes"></textarea>
<button type="submit">Add</button>
</form>`,
  );
}

// One search box across every case at once — cases, timeline entries,
// documents, voice notes/recordings, glossary, patterns, and notes to the
// entrusted side. contentType/entryKind let Darius browse by category
// alone, with no text at all ("every correction", "every hearing"),
// satisfying "searchable by the type of input" directly rather than only
// through free text. See bench-data.js's searchAll for how matching
// actually works (whole-table fetch, filtered in JS).
function renderSearchResults(query, { contentType, entryKind }, results) {
  const section = (heading, rows, renderRow) => (rows.length ? `<h2>${escapeHtml(heading)} (${rows.length})</h2>${rows.map(renderRow).join("\n")}` : "");
  const filterLinks = `<p class="hint">Browse by type, with or without a search term:
<a href="${PREFIX}search?contentType=correction">Corrections</a> ·
<a href="${PREFIX}search?contentType=contradiction">Contradictions</a> ·
<a href="${PREFIX}search?contentType=update">Updates</a> ·
<a href="${PREFIX}search?entryKind=hearing">Hearings</a> ·
<a href="${PREFIX}search?entryKind=deadline">Deadlines</a> ·
<a href="${PREFIX}search">Clear</a></p>`;
  const form = `<form method="get" action="${PREFIX}search">
<label for="q">Search cases, entries, documents, voice notes, glossary, patterns, notes</label>
<input type="text" id="q" name="q" value="${escapeHtml(query || "")}" placeholder="Search everything...">
${contentType ? `<input type="hidden" name="contentType" value="${escapeHtml(contentType)}">` : ""}
${entryKind ? `<input type="hidden" name="entryKind" value="${escapeHtml(entryKind)}">` : ""}
<button type="submit">Search</button>
</form>
${filterLinks}`;

  if (!results) {
    return benchPage("Search", `<header class="bench-header">${STENOTYPE_ICON()}<h1>Search<span class="tag">Everything, at once</span></h1></header>
<p class="note"><a href="${PREFIX}">&larr; All cases</a></p>
${form}`);
  }

  const body = [
    section("Cases", results.cases, (c) => `<div class="case-row"><a href="${PREFIX}case/${escapeHtml(c.id)}">${escapeHtml(c.title)}</a><span class="status">${escapeHtml(c.status)}${c.case_number ? ` · ${escapeHtml(c.case_number)}` : ""}</span></div>`),
    section("Timeline entries", results.entries, (e) => `<div class="card"><span class="entry-date">${escapeHtml(e.entry_date)}</span>${e.entry_kind && e.entry_kind !== "note" ? `<span class="status">${escapeHtml(e.entry_kind)}</span>` : ""}<div class="entry-layer">${escapeHtml(e.fact)}</div><p class="hint">${escapeHtml(e.case_title || "")} · <a href="${PREFIX}case/${escapeHtml(e.case_id)}">Open case</a></p></div>`),
    section("Documents", results.documents, (d) => `<div class="case-row"><a href="${PREFIX}documents/${escapeHtml(d.id)}">${escapeHtml(d.title)}</a><span class="status">${escapeHtml(d.case_title || "")}</span></div>`),
    section("Voice notes &amp; recordings", results.recordings, (r) => `<div class="card"><span class="entry-date">${escapeHtml(r.noted_at)}</span>${r.content_type && r.content_type !== "note" ? `<span class="status">${escapeHtml(r.content_type)}</span>` : ""}${r.body ? `<div class="entry-layer">${escapeHtml(truncate(r.body, 200))}</div>` : ""}${r.transcript ? `<div class="entry-layer">${escapeHtml(truncate(r.transcript, 200))}</div>` : ""}<p class="hint"><a href="${PREFIX}documents/${escapeHtml(r.document_id)}">${escapeHtml(r.document_title || "document")}</a> · ${escapeHtml(r.case_title || "")}</p></div>`),
    section("Glossary", results.glossary, (g) => `<div class="card"><strong>${escapeHtml(g.term)}</strong><div>${escapeHtml(g.definition)}</div></div>`),
    section("Patterns", results.patterns, (p) => `<div class="card"><strong>${escapeHtml(p.subject_name)}</strong> <span class="hint">(${escapeHtml(p.subject_type)})</span><div>${escapeHtml(p.description)}</div><p class="hint">${escapeHtml(p.case_title || "")}</p></div>`),
    section("Notes to the entrusted side", results.notes, (n) => `<div class="card"><span class="entry-date">${escapeHtml(n.created_at)}</span><div>${escapeHtml(n.body)}</div><p class="hint">${escapeHtml(n.case_title || "")}</p></div>`),
  ].join("\n");
  const hasAny = Object.values(results).some((rows) => rows.length);

  return benchPage("Search", `<header class="bench-header">${STENOTYPE_ICON()}<h1>Search<span class="tag">Everything, at once</span></h1></header>
<p class="note"><a href="${PREFIX}">&larr; All cases</a></p>
${form}
${hasAny ? body : `<p class="hint">Nothing matched.</p>`}`);
}

// --- Routing ---

export async function handleBenchGet(request, env, url) {
  const payload = await requireAccess(request, env);
  if (!payload) return forbidden();

  const path = url.pathname.slice(PREFIX.length);
  try {
    if (path === "") {
      const [cases, grants, upcomingEntries] = await Promise.all([listCases(env), listGrants(env), listUpcomingEntries(env)]);
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
      // listUpcomingEntries already sorts entry_date ascending, so the
      // first one seen per case is the soonest — but "upcoming" still
      // means the date hasn't passed, which is a comparison test-fake-d1.mjs
      // doesn't model, so it's applied here rather than in the query.
      const today = todayStr();
      const upcomingByCase = new Map();
      for (const e of upcomingEntries) {
        if (e.entry_date < today) continue;
        if (!upcomingByCase.has(e.case_id)) upcomingByCase.set(e.case_id, e);
      }
      const dailyVerse = await getOrComputeDailyVerse(env);
      return html(renderCaseList(cases, grants, grantSummaries, upcomingByCase, dailyVerse));
    }

    if (path === "prep") {
      const [sessions, cases] = await Promise.all([listPrepSessions(env), listCases(env)]);
      return html(renderPrepList(sessions, cases));
    }

    const prepDetailMatch = path.match(/^prep\/([^/]+)$/);
    if (prepDetailMatch) {
      const session = await getPrepSession(env, prepDetailMatch[1]);
      if (!session) return notFound();
      let record = {};
      if (session.kind === "hearing" && session.case_id) {
        const [caseRow, patterns, entries] = await Promise.all([
          getCase(env, session.case_id),
          listPatterns(env, session.case_id),
          listEntries(env, session.case_id),
        ]);
        record = { caseRow, patterns, entries: entries.filter((e) => e.entry_kind === "hearing" || e.entry_kind === "deadline") };
      }
      return html(renderPrepDetail(session, record));
    }

    if (path === "scripture") {
      return html(renderScriptureLibrary(await listScriptureVerses(env)));
    }

    if (path === "scripture/research") {
      const query = url.searchParams.get("q") || "";
      if (!query) return html(renderScriptureResearch("", null, null));
      const verses = await listScriptureVerses(env);
      if (!verses.length) return html(renderScriptureResearch(query, [], "Nothing curated yet — add a verse first."));
      const { picks, error } = await selectVerses(env, verses, query, { count: 5 });
      const verseById = new Map(verses.map((v) => [v.id, v]));
      const matches = picks.map((p) => ({ verse: verseById.get(p.verseId), reason: p.reason }));
      return html(renderScriptureResearch(query, matches, error));
    }

    if (path === "resources") {
      return html(renderResources(await listResources(env)));
    }

    if (path === "search") {
      const query = url.searchParams.get("q") || "";
      const contentType = url.searchParams.get("contentType") || "";
      const entryKind = url.searchParams.get("entryKind") || "";
      const results = query || contentType || entryKind ? await searchAll(env, { query, contentType, entryKind }) : null;
      return html(renderSearchResults(query, { contentType, entryKind }, results));
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

    const packetMatch = path.match(/^case\/([^/]+)\/packet$/);
    if (packetMatch) {
      const caseRow = await getCase(env, packetMatch[1]);
      if (!caseRow) return notFound();
      const documents = await listDocuments(env, caseRow.id);
      return html(renderFilingPacket(caseRow, documents));
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

    const proofFileMatch = path.match(/^documents\/([^/]+)\/proof-of-service\/file$/);
    if (proofFileMatch) {
      const doc = await data.getDocument(env.BENCH_NOTES, proofFileMatch[1]);
      if (!doc || !doc.proof_of_service_ref) return notFound();
      const object = await env.BENCH_DOCUMENTS.get(doc.proof_of_service_ref);
      if (!object) return notFound();
      return new Response(object.body, {
        headers: {
          "content-type": doc.proof_of_service_mime_type || "application/octet-stream",
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
      const [recordings, entries, allDocuments, affectingRecordings] = await Promise.all([
        listDocumentRecordings(env, doc.id),
        listEntries(env, caseRow.id),
        listDocuments(env, caseRow.id),
        listDocumentAffectingRecordings(env, doc.id),
      ]);
      const affectedByRecording = new Map(
        await Promise.all(recordings.map(async (r) => [r.id, await listRecordingAffectedDocuments(env, r.id)])),
      );
      return html(renderDocumentDetail(caseRow, doc, recordings, {
        entries,
        otherDocuments: allDocuments.filter((d) => d.id !== doc.id),
        affectedByRecording,
        affectingRecordings,
        documentTitleById: new Map(allDocuments.map((d) => [d.id, d.title])),
      }));
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

export async function handleBenchPost(request, env, url, ctx) {
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

      regenerateCaseSummaryInBackground(env, ctx, caseId);
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
        entryKind: form.get("entryKind"),
      });
      regenerateCaseSummaryInBackground(env, ctx, caseId);
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
        entryKind: form.get("entryKind"),
      });
      regenerateCaseSummaryInBackground(env, ctx, caseId);
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const entryDeleteMatch = path.match(/^case\/([^/]+)\/entries\/([^/]+)\/delete$/);
    if (entryDeleteMatch) {
      const [, caseId, entryId] = entryDeleteMatch;
      if (!(await getCase(env, caseId))) return notFound();
      await deleteEntry(env, entryId);
      regenerateCaseSummaryInBackground(env, ctx, caseId);
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
      regenerateCaseSummaryInBackground(env, ctx, caseId);
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
      regenerateCaseSummaryInBackground(env, ctx, caseId);
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
      regenerateCaseSummaryInBackground(env, ctx, caseId);
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
      regenerateCaseSummaryInBackground(env, ctx, caseId);
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    // A record of what Darius has done, never a deadline calculated for
    // him — see documents.filing_status's own schema comment. Reachable
    // both as a quick action on the case page and from the document's own
    // Filing & service section.
    const documentFileMatch = path.match(/^case\/([^/]+)\/documents\/([^/]+)\/file$/);
    if (documentFileMatch) {
      const [, caseId, docId] = documentFileMatch;
      if (!(await getCase(env, caseId))) return notFound();
      if (!(await data.getDocument(env.BENCH_NOTES, docId))) return notFound();
      await markDocumentFiled(env, docId, form.get("filedDate"));
      regenerateCaseSummaryInBackground(env, ctx, caseId);
      return Response.redirect(`https://darius.life${PREFIX}documents/${docId}`, 303);
    }

    // One step past filed — who was served, how, when, and an optional
    // proof of service, uploaded the same streaming blob-PUT way as any
    // other file here (see handleBenchPut). The blob, if any, has already
    // finished uploading (checked via R2's own head(), no bytes fetched)
    // before this ever runs, same pattern as every other upload path.
    const documentServeMatch = path.match(/^case\/([^/]+)\/documents\/([^/]+)\/serve$/);
    if (documentServeMatch) {
      const [, caseId, docId] = documentServeMatch;
      if (!(await getCase(env, caseId))) return notFound();
      if (!(await data.getDocument(env.BENCH_NOTES, docId))) return notFound();
      const servedAt = form.get("servedAt");
      if (!servedAt) return html(errorPage("Say when this was served."), 400);
      const blobId = form.get("blobId");
      const filename = form.get("filename");
      let proofOfServiceRef = null;
      let proofOfServiceMimeType = null;
      if (blobId && filename) {
        const key = data.benchBlobKey(blobId, filename);
        const head = await env.BENCH_DOCUMENTS.head(key);
        if (!head) return html(errorPage("That proof of service didn't finish uploading — try again."), 400);
        proofOfServiceRef = key;
        proofOfServiceMimeType = form.get("contentType") || "application/octet-stream";
      }
      await markDocumentServed(env, docId, {
        servedAt,
        servedMethod: form.get("servedMethod"),
        servedOn: form.get("servedOn"),
        proofOfServiceRef,
        proofOfServiceMimeType,
      });
      regenerateCaseSummaryInBackground(env, ctx, caseId);
      return Response.redirect(`https://darius.life${PREFIX}documents/${docId}`, 303);
    }

    const recordingDeleteMatch = path.match(/^case\/([^/]+)\/documents\/([^/]+)\/recordings\/([^/]+)\/delete$/);
    if (recordingDeleteMatch) {
      const [, caseId, docId, recordingId] = recordingDeleteMatch;
      if (!(await getCase(env, caseId))) return notFound();
      const recording = await getDocumentRecording(env, recordingId);
      if (!recording || recording.document_id !== docId) return notFound();
      if (recording.audio_storage_ref) await deleteBlobRefs(env, [recording.audio_storage_ref]);
      await deleteDocumentRecording(env, recordingId);
      regenerateCaseSummaryInBackground(env, ctx, caseId);
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

    // Darius's own reference notes, never AI-generated and never fed into
    // the case summary's prompt — see cases.local_rules_notes's own schema
    // comment for why that separation matters. No regeneration triggered:
    // this isn't a fact about the case, just his own procedural notes.
    const localRulesMatch = path.match(/^case\/([^/]+)\/local-rules$/);
    if (localRulesMatch) {
      const caseId = localRulesMatch[1];
      if (!(await getCase(env, caseId))) return notFound();
      await updateCaseLocalRules(env, caseId, form.get("notes"));
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    // A deliberate action Darius is waiting on, unlike every other
    // regenerateCaseSummaryInBackground call site above — so this one
    // awaits the regeneration itself rather than backgrounding it.
    const summaryRefreshMatch = path.match(/^case\/([^/]+)\/summary\/refresh$/);
    if (summaryRefreshMatch) {
      const caseId = summaryRefreshMatch[1];
      if (!(await getCase(env, caseId))) return notFound();
      await regenerateCaseSummary(env, caseId);
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
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

      const recordingId = crypto.randomUUID();
      await addDocumentRecording(env, {
        id: recordingId,
        documentId: docId,
        caseId,
        notedAt,
        body,
        audioStorageRef,
        audioMimeType,
        contentType: form.get("noteContentType"),
        relatedEntryId: form.get("relatedEntryId"),
      });
      // Cross-document links are a separate write, after the recording
      // itself exists — see setRecordingAffectedDocuments's own header.
      const affectedDocumentIds = form.getAll("affectedDocumentIds").filter(Boolean);
      if (affectedDocumentIds.length) await setRecordingAffectedDocuments(env, recordingId, affectedDocumentIds);
      // Audio gets transcribed first, then the case summary regenerates
      // once the transcript is there to inform it — a typed-only note has
      // nothing to transcribe, so it just regenerates directly.
      if (audioStorageRef) transcribeAndRegenerateInBackground(env, ctx, recordingId, caseId);
      else regenerateCaseSummaryInBackground(env, ctx, caseId);
      return Response.redirect(`https://darius.life${PREFIX}documents/${docId}`, 303);
    }

    // Correcting a Whisper transcription mistake — same "auto until Darius
    // takes authorship" pattern as a docket entry's edit clearing its
    // auto-extracted tag. New context, so it regenerates the case summary
    // same as adding one in the first place.
    const recordingEditMatch = path.match(/^case\/([^/]+)\/documents\/([^/]+)\/recordings\/([^/]+)\/edit$/);
    if (recordingEditMatch) {
      const [, caseId, docId, recordingId] = recordingEditMatch;
      if (!(await getCase(env, caseId))) return notFound();
      const recording = await getDocumentRecording(env, recordingId);
      if (!recording || recording.document_id !== docId) return notFound();
      const transcript = form.get("transcript");
      if (!transcript) return html(errorPage("A transcript can't be saved empty — delete the recording instead if it's wrong entirely."), 400);
      await editRecordingTranscript(env, recordingId, transcript);
      regenerateCaseSummaryInBackground(env, ctx, caseId);
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

    if (path === "prep") {
      const kind = form.get("kind");
      const title = form.get("title");
      if (kind !== "hearing" && kind !== "presentation") return html(errorPage("A prep session needs a valid kind."), 400);
      if (!title) return html(errorPage("A prep session needs a title."), 400);
      const caseId = kind === "hearing" ? (form.get("caseId") || null) : null;
      const id = crypto.randomUUID();
      await addPrepSession(env, { id, kind, title, caseId, eventDate: form.get("eventDate"), context: form.get("context") });
      return Response.redirect(`https://darius.life${PREFIX}prep/${id}`, 303);
    }

    // A deliberate action Darius is waiting on, same "await, don't
    // background" contract as the case summary's own /summary/refresh —
    // pressure_test_updated_at should always mean he asked for this just now.
    const pressureTestMatch = path.match(/^prep\/([^/]+)\/pressure-test$/);
    if (pressureTestMatch) {
      const session = await getPrepSession(env, pressureTestMatch[1]);
      if (!session) return notFound();
      let record = {};
      if (session.kind === "hearing" && session.case_id) {
        const [caseRow, patterns, entries] = await Promise.all([
          getCase(env, session.case_id),
          listPatterns(env, session.case_id),
          listEntries(env, session.case_id),
        ]);
        record = { caseRow, patterns, entries: entries.filter((e) => e.entry_kind === "hearing" || e.entry_kind === "deadline") };
      }
      const { pressureTest } = await generatePressureTest(env, session, record);
      if (pressureTest) await updatePrepSessionPressureTest(env, session.id, pressureTest);
      return Response.redirect(`https://darius.life${PREFIX}prep/${session.id}`, 303);
    }

    const prepDeleteMatch = path.match(/^prep\/([^/]+)\/delete$/);
    if (prepDeleteMatch) {
      await deletePrepSession(env, prepDeleteMatch[1]);
      return Response.redirect(`https://darius.life${PREFIX}prep`, 303);
    }

    if (path === "scripture") {
      const reference = form.get("reference");
      const translation = form.get("translation");
      const text = form.get("text");
      if (!reference || !translation || !text) return html(errorPage("A verse needs a reference, translation, and text."), 400);
      await addScriptureVerse(env, { id: crypto.randomUUID(), reference, translation, text, tags: form.get("tags") });
      return Response.redirect(`https://darius.life${PREFIX}scripture`, 303);
    }

    const scriptureDeleteMatch = path.match(/^scripture\/([^/]+)\/delete$/);
    if (scriptureDeleteMatch) {
      await deleteScriptureVerse(env, scriptureDeleteMatch[1]);
      return Response.redirect(`https://darius.life${PREFIX}scripture`, 303);
    }

    // Darius's own "pick again for today" — always recomputes, even though
    // getOrComputeDailyVerse's default (the home page's own lazy load)
    // would otherwise just reuse what's already picked for today.
    if (path === "scripture/daily/refresh") {
      await getOrComputeDailyVerse(env, { force: true });
      return Response.redirect(`https://darius.life${PREFIX}`, 303);
    }

    if (path === "resources") {
      const name = form.get("name");
      if (!name) return html(errorPage("A resource needs a name."), 400);
      await addResource(env, { id: crypto.randomUUID(), name, phone: form.get("phone"), url: form.get("url"), notes: form.get("notes") });
      return Response.redirect(`https://darius.life${PREFIX}resources`, 303);
    }

    const resourceDeleteMatch = path.match(/^resources\/([^/]+)\/delete$/);
    if (resourceDeleteMatch) {
      await deleteResource(env, resourceDeleteMatch[1]);
      return Response.redirect(`https://darius.life${PREFIX}resources`, 303);
    }

    return notFound();
  } catch (e) {
    return html(errorPage(e.message), 502);
  }
}

export const _internal = { renderCaseList, renderCaseDetail, errorPage };
