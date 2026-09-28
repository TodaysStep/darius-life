import { test } from "node:test";
import assert from "node:assert/strict";
import { addDocumentRecording, benchBlobKey, findOrCreateCaseByNumber, listDocumentRecordings } from "./bench-data.js";
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
