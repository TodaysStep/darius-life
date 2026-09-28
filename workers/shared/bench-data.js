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
export async function addEntry(db, { id, caseId, caseLabel, entryDate, fact, recommendedDirection, commentary, courtTakeaways, source }) {
  await db.prepare(
    `INSERT INTO docket_entries (id, case_id, case_label, entry_date, fact, recommended_direction, commentary, court_takeaways, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, caseId, caseLabel, entryDate, fact, recommendedDirection || null, commentary || null, courtTakeaways || null, source || "manual").run();
  await db.prepare("UPDATE cases SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(caseId).run();
}

// source is only touched when the caller explicitly passes it — the machine
// API's PATCH never has, and shouldn't start silently relabeling a row's
// provenance. The working-side edit form does pass it (always "manual"),
// because Darius reviewing and saving an auto-extracted entry is him taking
// authorship of it — the "auto-extracted" tag should stop showing once he's
// done that, not linger on text he's since corrected himself.
export async function updateEntry(db, id, { fact, recommendedDirection, commentary, courtTakeaways, source }) {
  if (source) {
    await db.prepare(
      `UPDATE docket_entries SET fact = ?, recommended_direction = ?, commentary = ?, court_takeaways = ?, source = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).bind(fact, recommendedDirection || null, commentary || null, courtTakeaways || null, source, id).run();
  } else {
    await db.prepare(
      `UPDATE docket_entries SET fact = ?, recommended_direction = ?, commentary = ?, court_takeaways = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).bind(fact, recommendedDirection || null, commentary || null, courtTakeaways || null, id).run();
  }
}

export async function setEntryShared(db, id, shared) {
  await db.prepare(
    `UPDATE docket_entries SET shared_at = ${shared ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : "NULL"} WHERE id = ?`,
  ).bind(id).run();
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
export async function addDocument(db, { id, caseId, caseLabel, entryId, title, storageRef, storageKind = "link", filedDate }) {
  if (storageKind === "link" && !isPublishableStorageRef(storageRef)) throw new Error("storageRef must be an http(s) address.");
  await db.prepare(
    "INSERT INTO documents (id, case_id, case_label, entry_id, title, storage_kind, storage_ref, filed_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, caseId, caseLabel, entryId || null, title, storageKind, storageRef, filedDate || null).run();
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
