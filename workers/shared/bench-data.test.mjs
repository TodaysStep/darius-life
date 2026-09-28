import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDocumentRecording, benchBlobKey, deleteCase, deleteDocument, deleteDocumentRecording, deleteEntry,
  findOrCreateCaseByNumber, listCaseBlobRefs, listDocumentBlobRefs, listDocumentRecordings,
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
