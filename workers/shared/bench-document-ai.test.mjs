import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ANALYZABLE_BYTES, analyzeUploadedDocument, classifyDocumentText, extractPdfText } from "./bench-document-ai.js";

test("no text (a scanned image with nothing extractable) is a clean, honest fallback — never a guess", async () => {
  const result = await classifyDocumentText({ AI: { run: async () => { throw new Error("should never be called"); } } }, "", "scan.pdf");
  assert.equal(result.source, "upload-unreadable");
  assert.match(result.fact, /scan\.pdf/);
  assert.equal(result.caseNumber, null);
});

test("a successful read extracts the document type and case number exactly as the model returned them", async () => {
  const fakeAI = {
    run: async () => ({ response: JSON.stringify({ documentType: "Response to a domestic violence restraining order request", caseNumber: "26FDV03796" }) }),
  };
  const result = await classifyDocumentText({ AI: fakeAI }, "some real document text", "motion.pdf");
  assert.equal(result.fact, "Response to a domestic violence restraining order request");
  assert.equal(result.caseNumber, "26FDV03796");
  assert.equal(result.source, "upload-ai");
});

test("the model's own object response (not a JSON string) is accepted too", async () => {
  const fakeAI = { run: async () => ({ response: { documentType: "A notice", caseNumber: null } }) };
  const result = await classifyDocumentText({ AI: fakeAI }, "text", "notice.pdf");
  assert.equal(result.fact, "A notice");
  assert.equal(result.caseNumber, null);
});

test('a literal "null" string, or an empty string, for caseNumber is treated as no case number', async () => {
  const fakeAI = { run: async () => ({ response: JSON.stringify({ documentType: "A letter", caseNumber: "null" }) }) };
  const result = await classifyDocumentText({ AI: fakeAI }, "text", "letter.pdf");
  assert.equal(result.caseNumber, null);
});

test("a model failure (thrown error, or unparseable response) never fabricates a case number or crashes the upload", async () => {
  const throws = { run: async () => { throw new Error("model unavailable"); } };
  const r1 = await classifyDocumentText({ AI: throws }, "text", "a.pdf");
  assert.equal(r1.source, "upload-ai-failed");
  assert.equal(r1.caseNumber, null);

  const garbage = { run: async () => ({ response: "not json at all" }) };
  const r2 = await classifyDocumentText({ AI: garbage }, "text", "b.pdf");
  assert.equal(r2.source, "upload-ai-failed");
  assert.equal(r2.caseNumber, null);
});

test("a non-PDF file is never sent to unpdf at all — extractPdfText returns empty text immediately", async () => {
  const bytes = new TextEncoder().encode("plain text content").buffer;
  const text = await extractPdfText(bytes, "notes.txt", "text/plain");
  assert.equal(text, "");
});

test("a file over the analyzable size limit is never fetched or read — the size check alone decides", async () => {
  const fetchBytes = async () => { throw new Error("should never be called — size check must short-circuit first"); };
  const result = await analyzeUploadedDocument({ AI: { run: async () => { throw new Error("should never be called either"); } } }, "huge.pdf", "application/pdf", MAX_ANALYZABLE_BYTES + 1, fetchBytes);
  assert.equal(result.source, "upload-too-large-to-analyze");
  assert.equal(result.caseNumber, null);
  assert.match(result.fact, /huge\.pdf/);
});

test("a file within the size limit is fetched and analyzed normally", async () => {
  const fakeAI = { run: async () => ({ response: JSON.stringify({ documentType: "A small notice", caseNumber: null }) }) };
  const fetchBytes = async () => new TextEncoder().encode("not actually a pdf, so extraction yields no text").buffer;
  const result = await analyzeUploadedDocument({ AI: fakeAI }, "small.txt", "text/plain", 1024, fetchBytes);
  assert.equal(result.source, "upload-unreadable");
});
