// Bench Notes' working-side data-access layer — cases, docket_entries,
// glossary_terms, patterns, documents, entrusted_notes, access_grants.
// The single source of truth both the HTML UI (workers/confidential/src/
// bench-working.js) and the machine API (workers/private-legal/src/
// bench-api.js) call — no duplicate implementation of what a "publish,"
// "share," or "revoke" operation actually does to the database. Every
// function takes a D1Database (`db`, i.e. env.BENCH_NOTES) as its first
// argument, same convention as workers/shared/bench-entrusted-view.js.

export async function listCases(db) {
  const { results } = await db.prepare(
    "SELECT id, title, court, case_number, status FROM cases ORDER BY updated_at DESC",
  ).all();
  return results;
}

export async function getCase(db, id) {
  return db.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first();
}

export async function createCase(db, { id, title, court, caseNumber }) {
  await db.prepare(
    "INSERT INTO cases (id, title, court, case_number) VALUES (?, ?, ?, ?)",
  ).bind(id, title, court || null, caseNumber || null).run();
}

// The one place "which case does an upload belong to" is decided — an
// existing case by an exact case_number match, or a new one, titled from
// the number when there is one. Deliberately decoupled from
// bench-document-ai.js: this function never reads a file or calls AI, only
// a case number it's handed, so it's testable (and trustworthy) on its own.
export async function findOrCreateCaseByNumber(db, caseNumber, newCaseId) {
  if (caseNumber) {
    const existing = await db.prepare("SELECT * FROM cases WHERE case_number = ?").bind(caseNumber).first();
    if (existing) return existing;
  }
  const title = caseNumber ? `Case ${caseNumber}` : `Untitled — ${new Date().toISOString().slice(0, 10)}`;
  await createCase(db, { id: newCaseId, title, court: null, caseNumber });
  return { id: newCaseId, title, case_number: caseNumber || null, status: "open" };
}

// Every R2 key anything under this case owns — every upload's own bytes,
// every recording's audio — so the caller can delete each from R2 before
// deleteCase removes the rows that named them. Same non-deleting contract
// as listDocumentBlobRefs: this file only ever touches D1.
export async function listCaseBlobRefs(db, caseId) {
  const { results: docs } = await db.prepare("SELECT id, storage_kind, storage_ref, proof_of_service_ref FROM documents WHERE case_id = ?").bind(caseId).all();
  const documentRefs = docs.filter((d) => d.storage_kind === "upload").map((d) => d.storage_ref);
  const proofRefs = docs.filter((d) => d.proof_of_service_ref).map((d) => d.proof_of_service_ref);
  const docIds = docs.map((d) => d.id);
  let recordingRefs = [];
  if (docIds.length) {
    const placeholders = docIds.map(() => "?").join(",");
    const { results: recordings } = await db.prepare(
      `SELECT audio_storage_ref FROM document_recordings WHERE document_id IN (${placeholders}) AND audio_storage_ref IS NOT NULL`,
    ).bind(...docIds).all();
    recordingRefs = recordings.map((r) => r.audio_storage_ref);
  }
  return [...documentRefs, ...proofRefs, ...recordingRefs];
}

// Removes a case and everything under it — entries, documents, their
// recordings, glossary/pattern/entrusted-note rows scoped to it. Deepest
// first. The caller (bench-working.js) requires Darius to type the case's
// own title back before this is ever called — see its own route for why —
// this function itself performs no confirmation, only the deletion.
export async function deleteCase(db, caseId) {
  const { results: docs } = await db.prepare("SELECT id FROM documents WHERE case_id = ?").bind(caseId).all();
  const docIds = docs.map((d) => d.id);
  if (docIds.length) {
    const placeholders = docIds.map(() => "?").join(",");
    await db.prepare(`DELETE FROM document_recordings WHERE document_id IN (${placeholders})`).bind(...docIds).run();
  }
  await db.prepare("DELETE FROM documents WHERE case_id = ?").bind(caseId).run();
  await db.prepare("DELETE FROM docket_entries WHERE case_id = ?").bind(caseId).run();
  await db.prepare("DELETE FROM glossary_terms WHERE case_id = ?").bind(caseId).run();
  await db.prepare("DELETE FROM patterns WHERE case_id = ?").bind(caseId).run();
  await db.prepare("DELETE FROM entrusted_notes WHERE case_id = ?").bind(caseId).run();
  await db.prepare("DELETE FROM cases WHERE id = ?").bind(caseId).run();
}

// bench-case-summary.js's own synthesis, regenerated in the background —
// see bench-working.js's regenerateCaseSummary and its call sites.
export async function updateCaseSummary(db, caseId, summary) {
  await db.prepare(
    "UPDATE cases SET ai_summary = ?, ai_summary_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).bind(summary, caseId).run();
}

// Darius's own reference notes for this case's court, entirely his own
// words — never AI-generated, unlike ai_summary above. See the schema's
// own comment on cases.local_rules_notes for why that distinction matters.
export async function updateCaseLocalRules(db, caseId, notes) {
  await db.prepare("UPDATE cases SET local_rules_notes = ? WHERE id = ?").bind(notes || null, caseId).run();
}

export async function listEntries(db, caseId) {
  const { results } = await db.prepare(
    "SELECT * FROM docket_entries WHERE case_id = ? ORDER BY entry_date DESC, created_at DESC",
  ).bind(caseId).all();
  return results;
}

export async function getEntry(db, id) {
  return db.prepare("SELECT * FROM docket_entries WHERE id = ?").bind(id).first();
}

// source distinguishes how a fact reached this table: 'manual' (Darius typed
// it — the default, and the only value that existed before uploads could
// fill this in for him) vs. 'upload-ai' / 'upload-unreadable' /
// 'upload-ai-failed' (workers/shared/bench-document-ai.js's own read of an
// uploaded document — never silently presented as the same thing as
// Darius's own typed fact; the UI tags anything non-manual visibly).
// entryKind: note (default, a chronological fact) | hearing | deadline —
// never inferred, same "explicit or default, never guessed" rule as
// source below. Drives bench-working.js's "Upcoming" banner: any hearing
// or deadline entry whose date hasn't passed yet.
export async function addEntry(db, { id, caseId, caseLabel, entryDate, fact, recommendedDirection, commentary, courtTakeaways, source, entryKind }) {
  await db.prepare(
    `INSERT INTO docket_entries (id, case_id, case_label, entry_date, fact, recommended_direction, commentary, court_takeaways, source, entry_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, caseId, caseLabel, entryDate, fact, recommendedDirection || null, commentary || null, courtTakeaways || null, source || "manual", entryKind || "note").run();
  await db.prepare("UPDATE cases SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(caseId).run();
}

// source is only touched when the caller explicitly passes it — the machine
// API's PATCH never has, and shouldn't start silently relabeling a row's
// provenance. The working-side edit form does pass it (always "manual"),
// because Darius reviewing and saving an auto-extracted entry is him taking
// authorship of it — the "auto-extracted" tag should stop showing once he's
// done that, not linger on text he's since corrected himself.
export async function updateEntry(db, id, { fact, recommendedDirection, commentary, courtTakeaways, source, entryKind }) {
  const entryKindValue = entryKind || "note";
  if (source) {
    await db.prepare(
      `UPDATE docket_entries SET fact = ?, recommended_direction = ?, commentary = ?, court_takeaways = ?, source = ?, entry_kind = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).bind(fact, recommendedDirection || null, commentary || null, courtTakeaways || null, source, entryKindValue, id).run();
  } else {
    await db.prepare(
      `UPDATE docket_entries SET fact = ?, recommended_direction = ?, commentary = ?, court_takeaways = ?, entry_kind = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).bind(fact, recommendedDirection || null, commentary || null, courtTakeaways || null, entryKindValue, id).run();
  }
}

export async function setEntryShared(db, id, shared) {
  await db.prepare(
    `UPDATE docket_entries SET shared_at = ${shared ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : "NULL"} WHERE id = ?`,
  ).bind(id).run();
}

// Deleting an entry never deletes a document attached to it — a real PDF
// isn't collateral damage for removing the wrong docket line. Any document
// pointing at this entry becomes a general case document instead (same
// meaning as if it had never been attached to one).
export async function deleteEntry(db, id) {
  await db.prepare("UPDATE documents SET entry_id = NULL WHERE entry_id = ?").bind(id).run();
  await db.prepare("DELETE FROM docket_entries WHERE id = ?").bind(id).run();
}

// Every hearing/deadline entry across every case, for the case list page's
// "Upcoming" tag per case — bench-working.js filters to entry_date >= today
// and picks the soonest per case itself (date comparison isn't pushed into
// SQL here, so this stays testable against the plain equality/IN matching
// test-fake-d1.mjs actually implements).
export async function listUpcomingEntries(db) {
  const { results } = await db.prepare(
    "SELECT * FROM docket_entries WHERE entry_kind IN (?, ?) ORDER BY entry_date ASC",
  ).bind("hearing", "deadline").all();
  return results;
}

export async function listGlossary(db, caseId) {
  const { results } = await db.prepare(
    "SELECT * FROM glossary_terms WHERE case_id = ? OR case_id IS NULL ORDER BY term COLLATE NOCASE",
  ).bind(caseId).all();
  return results;
}

export async function addGlossaryTerm(db, { id, caseId, term, definition }) {
  await db.prepare(
    "INSERT INTO glossary_terms (id, case_id, term, definition) VALUES (?, ?, ?, ?)",
  ).bind(id, caseId, term, definition).run();
}

export async function listPatterns(db, caseId) {
  const { results } = await db.prepare(
    "SELECT * FROM patterns WHERE case_id = ? ORDER BY updated_at DESC",
  ).bind(caseId).all();
  return results;
}

export async function addPattern(db, { id, caseId, subjectType, subjectName, description }) {
  await db.prepare(
    "INSERT INTO patterns (id, case_id, subject_type, subject_name, description) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, caseId, subjectType, subjectName, description).run();
}

// Documents are the one working-side-managed table the entrusted side also
// reads — Darius (or now the publishing desk, on his behalf) adds a
// reference here (the file itself lives in the Lovable document viewer or
// R2; storage_ref just points at it) and explicitly shares it. Nothing is
// shared automatically.
export async function listDocuments(db, caseId) {
  const { results } = await db.prepare(
    "SELECT * FROM documents WHERE case_id = ? ORDER BY created_at DESC",
  ).bind(caseId).all();
  return results;
}

export async function getDocument(db, id) {
  return db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
}

// storage_ref ends up in an href on the entrusted/preview page
// (bench-entrusted-view.js escapes the HTML but does not, and should not have
// to, second-guess the URL scheme). A javascript:/data:/vbscript: reference
// would still execute on click despite the escaping, so http(s)-only is
// enforced once here, for every caller (the human form and the machine API
// alike), rather than trusted at the edge.
export function isPublishableStorageRef(ref) {
  try {
    return new URL(ref).protocol === "http:" || new URL(ref).protocol === "https:";
  } catch {
    return false;
  }
}

// A directly uploaded file's storage_ref is a server-generated R2 key
// (benchBlobKey below), never attacker- or founder-influenced text, so
// the http(s) check — which exists for pasted-in links — doesn't apply to it.
// A filedDate given up front means Darius already knows this was filed —
// filing_status starts at "filed" rather than the usual "drafted" default,
// so the case page doesn't show a redundant "mark filed" action for
// something he's already told it was filed.
export async function addDocument(db, { id, caseId, caseLabel, entryId, title, storageRef, storageKind = "link", filedDate }) {
  if (storageKind === "link" && !isPublishableStorageRef(storageRef)) throw new Error("storageRef must be an http(s) address.");
  await db.prepare(
    "INSERT INTO documents (id, case_id, case_label, entry_id, title, storage_kind, storage_ref, filed_date, filing_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, caseId, caseLabel, entryId || null, title, storageKind, storageRef, filedDate || null, filedDate ? "filed" : "drafted").run();
}

// The one place an R2 key is shaped for anything Bench Notes stores as
// bytes — a document, or a recording attached to one — so every route that
// writes or reads R2 agrees on the same key for the same id. blobId is
// generated by the caller before the bytes are even sent (see the streaming
// blob-upload route in bench-working.js), so this never needs to invent one.
export function benchBlobKey(blobId, filename) {
  const safeName = (filename || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-100);
  return `bench-blobs/${blobId}/${safeName}`;
}

export async function setDocumentShared(db, id, shared) {
  await db.prepare(
    `UPDATE documents SET shared_at = ${shared ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : "NULL"} WHERE id = ?`,
  ).bind(id).run();
}

// The paper-filing lifecycle, tracked explicitly rather than inferred from
// filed_date alone — a record of what Darius has done, never guidance
// about what he should file or when. filedDate is optional: he may know
// he filed something today without knowing the court's own stamped date
// yet, and can fill that in once he has it (calling this again just
// overwrites both fields, which is fine — it's idempotent).
export async function markDocumentFiled(db, id, filedDate) {
  await db.prepare(
    "UPDATE documents SET filing_status = ?, filed_date = ? WHERE id = ?",
  ).bind("filed", filedDate || null, id).run();
}

// Same idea as markDocumentFiled, one step further — who was served, how,
// and when, plus an optional proof of service (an R2 key if uploaded,
// mirroring storage_ref's own convention, never a raw URL from user text
// without the same http(s) validation storage_ref itself gets — see
// isPublishableStorageRef and how bench-working.js's serve route uses it).
export async function markDocumentServed(db, id, { servedAt, servedMethod, servedOn, proofOfServiceRef, proofOfServiceMimeType }) {
  await db.prepare(
    `UPDATE documents SET filing_status = ?, served_at = ?, served_method = ?, served_on = ?,
     proof_of_service_ref = ?, proof_of_service_mime_type = ? WHERE id = ?`,
  ).bind("served", servedAt || null, servedMethod || null, servedOn || null, proofOfServiceRef || null, proofOfServiceMimeType || null, id).run();
}

// Every R2 key a document owns — its own bytes (if it's an upload; a
// pasted-in link owns no bytes here) plus every recording attached to it —
// so the caller can delete each one from R2 before these rows disappear.
// Never deletes from R2 itself: this file only ever touches D1.
export async function listDocumentBlobRefs(db, documentId) {
  const doc = await db.prepare("SELECT storage_kind, storage_ref, proof_of_service_ref FROM documents WHERE id = ?").bind(documentId).first();
  const { results: recordings } = await db.prepare(
    "SELECT audio_storage_ref FROM document_recordings WHERE document_id = ? AND audio_storage_ref IS NOT NULL",
  ).bind(documentId).all();
  const refs = recordings.map((r) => r.audio_storage_ref);
  if (doc && doc.storage_kind === "upload") refs.push(doc.storage_ref);
  if (doc?.proof_of_service_ref) refs.push(doc.proof_of_service_ref);
  return refs;
}

export async function deleteDocument(db, id) {
  await db.prepare("DELETE FROM document_recordings WHERE document_id = ?").bind(id).run();
  await db.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
}

// Recordings (and/or typed notes) about one specific document, dated,
// any number of them — Darius adding his thinking about a document as it
// develops over time, not one note fixed at upload. Working-side only,
// like commentary; never shared, never entrusted-visible. audio is
// optional (a recording can be a typed note with no audio, or audio with
// no separate note — body and audioStorageRef are independently optional,
// though a row with neither is pointless and the route rejects that).
export async function listDocumentRecordings(db, documentId) {
  const { results } = await db.prepare(
    "SELECT * FROM document_recordings WHERE document_id = ? ORDER BY noted_at DESC, created_at DESC",
  ).bind(documentId).all();
  return results;
}

export async function addDocumentRecording(db, { id, documentId, caseId, notedAt, body, audioStorageRef, audioMimeType, audioDurationSeconds }) {
  await db.prepare(
    `INSERT INTO document_recordings (id, document_id, case_id, noted_at, body, audio_storage_ref, audio_mime_type, audio_duration_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, documentId, caseId, notedAt, body || null, audioStorageRef || null, audioMimeType || null, audioDurationSeconds || null).run();
}

export async function getDocumentRecording(db, id) {
  return db.prepare("SELECT * FROM document_recordings WHERE id = ?").bind(id).first();
}

export async function deleteDocumentRecording(db, id) {
  await db.prepare("DELETE FROM document_recordings WHERE id = ?").bind(id).run();
}

// Every recording across every document in a case, for bench-case-summary.js
// to draw on — so a voice note's own content (typed body, or a Whisper
// transcript once one exists) helps the case summary improve as it's
// added, the same way a new document or timeline entry already does.
export async function listCaseRecordings(db, caseId) {
  const { results } = await db.prepare(
    "SELECT * FROM document_recordings WHERE case_id = ? ORDER BY noted_at DESC, created_at DESC",
  ).bind(caseId).all();
  return results;
}

// bench-transcribe.js's own write, after it runs against a recording's
// audio — see bench-working.js's transcribeRecordingInBackground. Never
// touches transcript_source: that's set once, by whichever of this
// function or editRecordingTranscript wrote most recently.
export async function updateRecordingTranscript(db, id, transcript, error) {
  await db.prepare(
    "UPDATE document_recordings SET transcript = ?, transcript_error = ?, transcript_source = ? WHERE id = ?",
  ).bind(transcript, error, "auto", id).run();
}

// Darius correcting a transcription mistake — same "auto until a human
// takes authorship" pattern as docket_entries.source flipping to "manual"
// on entry edit. Clears transcript_error, since a saved correction is by
// definition not a failed transcription anymore.
export async function editRecordingTranscript(db, id, transcript) {
  await db.prepare(
    "UPDATE document_recordings SET transcript = ?, transcript_error = ?, transcript_source = ? WHERE id = ?",
  ).bind(transcript, null, "manual", id).run();
}

// Entrusted notes — occasional notes Darius (or the desk, on his behalf)
// writes directly TO the entrusted side. Distinct from commentary
// (working-side, never shared): these are written knowing a guest will
// read them, and go out immediately, not behind a share toggle.
export async function listEntrustedNotes(db, caseId) {
  const { results } = await db.prepare(
    "SELECT * FROM entrusted_notes WHERE case_id = ? ORDER BY created_at DESC",
  ).bind(caseId).all();
  return results;
}

export async function addEntrustedNote(db, { id, caseId, caseLabel, body }) {
  await db.prepare(
    "INSERT INTO entrusted_notes (id, case_id, case_label, body) VALUES (?, ?, ?, ?)",
  ).bind(id, caseId, caseLabel, body).run();
}

// A plain, Darius-curated list — not case-scoped, not AI-generated, not
// maintained by anyone but him. Seeded once (see schema/bench-notes.sql's
// own comment) with the one entry verified directly rather than assumed;
// everything else is his to add.
export async function listResources(db) {
  const { results } = await db.prepare("SELECT * FROM resources ORDER BY created_at ASC").all();
  return results;
}

export async function addResource(db, { id, name, phone, url, notes }) {
  await db.prepare(
    "INSERT INTO resources (id, name, phone, url, notes) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, name, phone || null, url || null, notes || null).run();
}

export async function deleteResource(db, id) {
  await db.prepare("DELETE FROM resources WHERE id = ?").bind(id).run();
}

// Entrusted access grants — the single universal passphrase per grant,
// scoped to specific cases, revocable.
export async function listGrants(db) {
  const { results } = await db.prepare(
    "SELECT id, label, case_ids_json, created_at, revoked_at FROM access_grants ORDER BY created_at DESC",
  ).all();
  return results;
}

export async function getGrant(db, id) {
  return db.prepare("SELECT * FROM access_grants WHERE id = ?").bind(id).first();
}

export async function createGrant(db, { id, codeHash, caseIds, label }) {
  await db.prepare(
    "INSERT INTO access_grants (id, code_hash, case_ids_json, label) VALUES (?, ?, ?, ?)",
  ).bind(id, codeHash, JSON.stringify(caseIds), label || null).run();
}

export async function revokeGrant(db, id) {
  await db.prepare(
    "UPDATE access_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL",
  ).bind(id).run();
}

export async function updateGrantPassphrase(db, id, newCodeHash) {
  await db.prepare("UPDATE access_grants SET code_hash = ? WHERE id = ?").bind(newCodeHash, id).run();
}
