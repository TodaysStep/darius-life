import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDocument, addDocumentRecording, addEntry, addResource, benchBlobKey, deleteCase, deleteDocument,
  deleteDocumentRecording, deleteEntry, deleteResource, editRecordingTranscript, findOrCreateCaseByNumber,
  listCaseBlobRefs, listCaseRecordings, listDocumentBlobRefs, listDocumentRecordings,
  listResources, listUpcomingEntries, markDocumentFiled, markDocumentServed, updateCaseLocalRules, updateEntry,
  updateRecordingTranscript,
} from "./bench-data.js";
import { createFakeD1 } from "./test-fake-d1.mjs";

test("a case number matching an existing case attaches to it, never creating a second one", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: "26FDV03796", status: "open", created_at: "t", updated_at: "t" });

  const found = await findOrCreateCaseByNumber(BENCH_NOTES, "26FDV03796", "would-be-new-id");
  assert.equal(found.id, "case-1");
  assert.equal(tables.cases.length, 1);
});

test("an unrecognized case number creates a new case titled from that number", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  const created = await findOrCreateCaseByNumber(BENCH_NOTES, "26FDV03796", "new-id");
  assert.equal(created.id, "new-id");
  assert.equal(tables.cases.length, 1);
  assert.equal(tables.cases[0].case_number, "26FDV03796");
  assert.equal(tables.cases[0].title, "Case 26FDV03796");
});

test("no case number at all creates a new, dated, untitled case rather than guessing", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  const created = await findOrCreateCaseByNumber(BENCH_NOTES, null, "new-id");
  assert.equal(tables.cases.length, 1);
  assert.equal(tables.cases[0].case_number, null);
  assert.match(created.title, /^Untitled — \d{4}-\d{2}-\d{2}$/);
});

test("two uploads with no case number each get their own case, never silently merged", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  await findOrCreateCaseByNumber(BENCH_NOTES, null, "id-1");
  await findOrCreateCaseByNumber(BENCH_NOTES, null, "id-2");
  assert.equal(tables.cases.length, 2);
});

test("benchBlobKey strips slashes out of the filename — R2 has no directory semantics to traverse, but a stray slash would still create a confusing key shape", () => {
  const key = benchBlobKey("blob-1", "../../etc/passwd");
  assert.equal((key.match(/\//g) || []).length, 2);
  assert.match(key, /^bench-blobs\/blob-1\/[^/]+$/);
});

test("a document can carry any number of dated recordings/notes, listed newest-noted first", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });

  await addDocumentRecording(BENCH_NOTES, { id: "r1", documentId: "doc-1", caseId: "case-1", notedAt: "2026-09-01", body: "First thought." });
  await addDocumentRecording(BENCH_NOTES, { id: "r2", documentId: "doc-1", caseId: "case-1", notedAt: "2026-09-15", body: null, audioStorageRef: "bench-blobs/r2/voice.m4a", audioMimeType: "audio/m4a", audioDurationSeconds: 42 });

  const rows = await listDocumentRecordings(BENCH_NOTES, "doc-1");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "r2");
  assert.equal(rows[0].audio_duration_seconds, 42);
  assert.equal(rows[1].body, "First thought.");
});

test("listCaseRecordings gathers recordings across every document in the case, newest-noted first", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });
  tables.documents.push({ id: "doc-2", case_id: "case-1", case_label: "X", title: "Notice", storage_kind: "upload", storage_ref: "k2", shared_at: null, created_at: "t" });
  tables.documents.push({ id: "doc-3", case_id: "case-2", case_label: "Y", title: "Unrelated", storage_kind: "upload", storage_ref: "k3", shared_at: null, created_at: "t" });

  await addDocumentRecording(BENCH_NOTES, { id: "r1", documentId: "doc-1", caseId: "case-1", notedAt: "2026-09-01", body: "About the motion." });
  await addDocumentRecording(BENCH_NOTES, { id: "r2", documentId: "doc-2", caseId: "case-1", notedAt: "2026-09-15", body: "About the notice." });
  await addDocumentRecording(BENCH_NOTES, { id: "r3", documentId: "doc-3", caseId: "case-2", notedAt: "2026-09-20", body: "A different case entirely." });

  const rows = await listCaseRecordings(BENCH_NOTES, "case-1");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id), ["r2", "r1"]);
});

test("updateRecordingTranscript stores the transcript and tags it auto — a Whisper read, not Darius's own typed word", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  await addDocumentRecording(BENCH_NOTES, { id: "r1", documentId: "doc-1", caseId: "case-1", notedAt: "t", audioStorageRef: "bench-blobs/r1/voice.m4a" });

  await updateRecordingTranscript(BENCH_NOTES, "r1", "Filed the response this morning.", null);
  const row = tables.document_recordings[0];
  assert.equal(row.transcript, "Filed the response this morning.");
  assert.equal(row.transcript_error, null);
  assert.equal(row.transcript_source, "auto");
});

test("editRecordingTranscript overwrites a correction and flips the tag to manual, clearing any prior error", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  await addDocumentRecording(BENCH_NOTES, { id: "r1", documentId: "doc-1", caseId: "case-1", notedAt: "t", audioStorageRef: "bench-blobs/r1/voice.m4a" });
  await updateRecordingTranscript(BENCH_NOTES, "r1", "Filed the responze this morning.", null);

  await editRecordingTranscript(BENCH_NOTES, "r1", "Filed the response this morning.");
  const row = tables.document_recordings[0];
  assert.equal(row.transcript, "Filed the response this morning.");
  assert.equal(row.transcript_error, null);
  assert.equal(row.transcript_source, "manual");
});

test("deleting an entry never deletes a document attached to it — it becomes a general document instead", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.docket_entries.push({ id: "entry-1", case_id: "case-1", case_label: "X", entry_date: "t", fact: "F", source: "manual", created_at: "t", updated_at: "t" });
  tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", entry_id: "entry-1", title: "Motion", storage_kind: "link", storage_ref: "https://example.com/x", shared_at: null, created_at: "t" });

  await deleteEntry(BENCH_NOTES, "entry-1");
  assert.equal(tables.docket_entries.length, 0);
  assert.equal(tables.documents.length, 1);
  assert.equal(tables.documents[0].entry_id, null);
});

test("deleting a document also deletes its own recordings, and lists every R2 ref that needs cleanup first", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion", storage_kind: "upload", storage_ref: "bench-blobs/doc-1/motion.pdf", shared_at: null, created_at: "t" });
  tables.document_recordings.push({ id: "r1", document_id: "doc-1", case_id: "case-1", noted_at: "t", body: null, audio_storage_ref: "bench-blobs/r1/voice.m4a", audio_mime_type: "audio/m4a", audio_duration_seconds: 5, created_at: "t" });

  const refs = await listDocumentBlobRefs(BENCH_NOTES, "doc-1");
  assert.deepEqual(new Set(refs), new Set(["bench-blobs/r1/voice.m4a", "bench-blobs/doc-1/motion.pdf"]));

  await deleteDocument(BENCH_NOTES, "doc-1");
  assert.equal(tables.documents.length, 0);
  assert.equal(tables.document_recordings.length, 0);
});

test("a pasted-in link document owns no R2 bytes of its own — only its recordings' audio, if any, need cleanup", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion", storage_kind: "link", storage_ref: "https://example.com/x", shared_at: null, created_at: "t" });
  const refs = await listDocumentBlobRefs(BENCH_NOTES, "doc-1");
  assert.deepEqual(refs, []);
});

test("deleting a recording just removes that one row", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.document_recordings.push({ id: "r1", document_id: "doc-1", case_id: "case-1", noted_at: "t", body: "note", audio_storage_ref: null, created_at: "t" });
  tables.document_recordings.push({ id: "r2", document_id: "doc-1", case_id: "case-1", noted_at: "t", body: "keep", audio_storage_ref: null, created_at: "t" });
  await deleteDocumentRecording(BENCH_NOTES, "r1");
  assert.equal(tables.document_recordings.length, 1);
  assert.equal(tables.document_recordings[0].id, "r2");
});

test("addEntry defaults entry_kind to note, but stores hearing/deadline explicitly when given", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  await addEntry(BENCH_NOTES, { id: "e1", caseId: "case-1", caseLabel: "X", entryDate: "2026-09-01", fact: "Filed." });
  await addEntry(BENCH_NOTES, { id: "e2", caseId: "case-1", caseLabel: "X", entryDate: "2026-10-15", fact: "Hearing.", entryKind: "hearing" });
  assert.equal(tables.docket_entries[0].entry_kind, "note");
  assert.equal(tables.docket_entries[1].entry_kind, "hearing");
});

test("updateEntry changes entry_kind when given, and defaults to note when omitted — an edit form always submits the field, so this never silently downgrades a hearing behind the caller's back in practice", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  await addEntry(BENCH_NOTES, { id: "e1", caseId: "case-1", caseLabel: "X", entryDate: "2026-10-15", fact: "Hearing.", entryKind: "hearing" });
  await updateEntry(BENCH_NOTES, "e1", { fact: "Hearing, rescheduled.", entryKind: "hearing" });
  assert.equal(tables.docket_entries[0].entry_kind, "hearing");
  assert.equal(tables.docket_entries[0].fact, "Hearing, rescheduled.");
});

test("listUpcomingEntries returns only hearing/deadline entries, soonest first, never plain notes", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  await addEntry(BENCH_NOTES, { id: "e1", caseId: "case-1", caseLabel: "X", entryDate: "2026-09-01", fact: "Just a note.", entryKind: "note" });
  await addEntry(BENCH_NOTES, { id: "e2", caseId: "case-1", caseLabel: "X", entryDate: "2026-10-15", fact: "Hearing.", entryKind: "hearing" });
  await addEntry(BENCH_NOTES, { id: "e3", caseId: "case-1", caseLabel: "X", entryDate: "2026-10-01", fact: "Deadline.", entryKind: "deadline" });
  const rows = await listUpcomingEntries(BENCH_NOTES);
  assert.deepEqual(rows.map((r) => r.id), ["e3", "e2"]);
});

test("addDocument with a filedDate up front starts filing_status at filed, not the usual drafted default", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  await addDocument(BENCH_NOTES, { id: "d1", caseId: "case-1", caseLabel: "X", title: "Motion", storageRef: "https://example.com/x", filedDate: "2026-09-01" });
  await addDocument(BENCH_NOTES, { id: "d2", caseId: "case-1", caseLabel: "X", title: "Draft", storageRef: "https://example.com/y" });
  assert.equal(tables.documents[0].filing_status, "filed");
  assert.equal(tables.documents[1].filing_status, "drafted");
});

test("markDocumentFiled sets filing_status and filed_date", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.documents.push({ id: "d1", case_id: "case-1", case_label: "X", title: "Motion", storage_kind: "link", storage_ref: "https://example.com/x", shared_at: null, filing_status: "drafted", created_at: "t" });
  await markDocumentFiled(BENCH_NOTES, "d1", "2026-09-15");
  assert.equal(tables.documents[0].filing_status, "filed");
  assert.equal(tables.documents[0].filed_date, "2026-09-15");
});

test("markDocumentServed sets filing_status, service details, and an optional proof of service", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.documents.push({ id: "d1", case_id: "case-1", case_label: "X", title: "Motion", storage_kind: "link", storage_ref: "https://example.com/x", shared_at: null, filing_status: "filed", filed_date: "2026-09-15", created_at: "t" });
  await markDocumentServed(BENCH_NOTES, "d1", { servedAt: "2026-09-20", servedMethod: "mail", servedOn: "Respondent, Jane Doe", proofOfServiceRef: "bench-blobs/proof-1/receipt.pdf", proofOfServiceMimeType: "application/pdf" });
  const row = tables.documents[0];
  assert.equal(row.filing_status, "served");
  assert.equal(row.served_at, "2026-09-20");
  assert.equal(row.served_method, "mail");
  assert.equal(row.served_on, "Respondent, Jane Doe");
  assert.equal(row.proof_of_service_ref, "bench-blobs/proof-1/receipt.pdf");
});

test("a document's proof of service is included in the R2 refs to clean up, alongside its own bytes and its recordings' audio", async () => {
  const { BENCH_NOTES } = createFakeD1();
  const db = BENCH_NOTES;
  await addDocument(db, { id: "d1", caseId: "case-1", caseLabel: "X", title: "Motion", storageKind: "upload", storageRef: "bench-blobs/d1/motion.pdf" });
  await markDocumentServed(db, "d1", { servedAt: "t", proofOfServiceRef: "bench-blobs/proof-1/receipt.pdf" });
  const refs = await listDocumentBlobRefs(db, "d1");
  assert.deepEqual(new Set(refs), new Set(["bench-blobs/d1/motion.pdf", "bench-blobs/proof-1/receipt.pdf"]));
  const caseRefs = await listCaseBlobRefs(db, "case-1");
  assert.deepEqual(new Set(caseRefs), new Set(["bench-blobs/d1/motion.pdf", "bench-blobs/proof-1/receipt.pdf"]));
});

test("updateCaseLocalRules stores Darius's own reference notes for the case's court", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  await updateCaseLocalRules(BENCH_NOTES, "case-1", "Self-help center says: 3 copies, one for the clerk.");
  assert.equal(tables.cases[0].local_rules_notes, "Self-help center says: 3 copies, one for the clerk.");
});

test("resources: add, list (oldest first), and delete — a plain Darius-curated list", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  await addResource(BENCH_NOTES, { id: "r1", name: "National Domestic Violence Hotline", phone: "1-800-799-7233", url: "https://www.thehotline.org" });
  await addResource(BENCH_NOTES, { id: "r2", name: "County self-help center" });
  const rows = await listResources(BENCH_NOTES);
  assert.deepEqual(rows.map((r) => r.id), ["r1", "r2"]);

  await deleteResource(BENCH_NOTES, "r1");
  assert.equal(tables.resources.length, 1);
  assert.equal(tables.resources[0].id, "r2");
});

test("deleting a case removes every entry, document, recording, glossary term, pattern, and note under it", async () => {
  const { BENCH_NOTES, tables } = createFakeD1();
  tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: "CV-1", status: "open", created_at: "t", updated_at: "t" });
  tables.docket_entries.push({ id: "entry-1", case_id: "case-1", case_label: "X", entry_date: "t", fact: "F", source: "manual", created_at: "t", updated_at: "t" });
  tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion", storage_kind: "upload", storage_ref: "bench-blobs/doc-1/motion.pdf", shared_at: null, created_at: "t" });
  tables.document_recordings.push({ id: "r1", document_id: "doc-1", case_id: "case-1", noted_at: "t", body: null, audio_storage_ref: "bench-blobs/r1/voice.m4a", created_at: "t" });
  tables.glossary_terms.push({ id: "g1", case_id: "case-1", term: "TRO", definition: "...", created_at: "t", updated_at: "t" });
  tables.patterns.push({ id: "p1", case_id: "case-1", subject_type: "judge", subject_name: "X", description: "...", entries_json: "[]", created_at: "t", updated_at: "t" });
  tables.entrusted_notes.push({ id: "n1", case_id: "case-1", case_label: "X", body: "...", created_at: "t" });
  // A global glossary term (case_id null) must survive deleting this case.
  tables.glossary_terms.push({ id: "g2", case_id: null, term: "Global", definition: "...", created_at: "t", updated_at: "t" });

  const refs = await listCaseBlobRefs(BENCH_NOTES, "case-1");
  assert.deepEqual(new Set(refs), new Set(["bench-blobs/doc-1/motion.pdf", "bench-blobs/r1/voice.m4a"]));

  await deleteCase(BENCH_NOTES, "case-1");
  assert.equal(tables.cases.length, 0);
  assert.equal(tables.docket_entries.length, 0);
  assert.equal(tables.documents.length, 0);
  assert.equal(tables.document_recordings.length, 0);
  assert.equal(tables.patterns.length, 0);
  assert.equal(tables.entrusted_notes.length, 0);
  assert.equal(tables.glossary_terms.length, 1);
  assert.equal(tables.glossary_terms[0].id, "g2");
});
