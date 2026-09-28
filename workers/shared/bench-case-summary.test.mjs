import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCase } from "./bench-case-summary.js";

function emptyRecord(overrides = {}) {
  return {
    caseRow: { title: "Family matter", case_number: "CV-1", court: "Superior Court", status: "open" },
    entries: [],
    documents: [],
    notes: [],
    patterns: [],
    glossary: [],
    recordings: [],
    ...overrides,
  };
}

test("a case with nothing on record yet is not summarized at all — never a hallucinated summary of an empty case", async () => {
  const fakeAI = { run: async () => { throw new Error("should never be called"); } };
  const { summary, error } = await summarizeCase({ AI: fakeAI }, emptyRecord());
  assert.equal(summary, null);
  assert.equal(error, null);
});

test("a case with at least one entry is sent to the model and its response is returned", async () => {
  const fakeAI = { run: async (model, opts) => ({ response: "1. Overview\nA family matter, open, no further detail on record yet." }) };
  const record = emptyRecord({ entries: [{ entry_date: "2026-09-28", fact: "Filed initial petition.", recommended_direction: null, commentary: null, court_takeaways: null }] });
  const { summary, error } = await summarizeCase({ AI: fakeAI }, record);
  assert.match(summary, /Overview/);
  assert.equal(error, null);
});

test("the prompt explicitly forbids legal advice, predictions, and speculation — checked directly against what's actually sent to the model", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };
  const record = emptyRecord({ entries: [{ entry_date: "2026-09-28", fact: "Filed initial petition.", recommended_direction: null, commentary: null, court_takeaways: null }] });
  await summarizeCase({ AI: fakeAI }, record);
  assert.match(sentPrompt, /never give legal advice/i);
  assert.match(sentPrompt, /never predict/i);
  assert.match(sentPrompt, /never.*(inferred or guessed|speculate)/i);
});

test("the founder's own private commentary and recommended direction are included in what's sent to the model — this stays working-side, same trust boundary document text already crosses", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };
  const record = emptyRecord({
    entries: [{ entry_date: "2026-09-28", fact: "Hearing held.", recommended_direction: "File a response by Friday.", commentary: "SECRET-STRATEGY-NOTE", court_takeaways: "Continuance granted." }],
  });
  await summarizeCase({ AI: fakeAI }, record);
  assert.match(sentPrompt, /SECRET-STRATEGY-NOTE/);
  assert.match(sentPrompt, /File a response by Friday\./);
  assert.match(sentPrompt, /Continuance granted\./);
});

test("a model failure never crashes the caller — returns a null summary and the error, not a thrown exception", async () => {
  const fakeAI = { run: async () => { throw new Error("model unavailable"); } };
  const record = emptyRecord({ entries: [{ entry_date: "t", fact: "F", recommended_direction: null, commentary: null, court_takeaways: null }] });
  const { summary, error } = await summarizeCase({ AI: fakeAI }, record);
  assert.equal(summary, null);
  assert.equal(error, "model unavailable");
});

test("documents alone (no entries yet) are still enough to summarize", async () => {
  const fakeAI = { run: async () => ({ response: "Overview: one document on file." }) };
  const record = emptyRecord({ documents: [{ title: "Motion.pdf", filed_date: "2026-09-28" }] });
  const { summary } = await summarizeCase({ AI: fakeAI }, record);
  assert.match(summary, /Overview/);
});

test("a voice note's transcript reaches the model, so the summary can actually improve as recordings are added", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };
  const record = emptyRecord({
    documents: [{ title: "Motion.pdf", filed_date: "2026-09-28" }],
    recordings: [{ noted_at: "2026-09-29", body: null, transcript: "TRANSCRIBED-VOICE-NOTE-CONTENT" }],
  });
  await summarizeCase({ AI: fakeAI }, record);
  assert.match(sentPrompt, /TRANSCRIBED-VOICE-NOTE-CONTENT/);
});

test("a recording with no typed body and no transcript yet (transcription still pending, or failed) adds nothing to the prompt", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };
  const record = emptyRecord({
    documents: [{ title: "Motion.pdf", filed_date: "2026-09-28" }],
    recordings: [{ noted_at: "2026-09-29", body: null, transcript: null }],
  });
  await summarizeCase({ AI: fakeAI }, record);
  assert.doesNotMatch(sentPrompt, /Voice notes/);
});

test("a hearing/deadline entry is tagged explicitly in the prompt, distinct from an ordinary note", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };
  const record = emptyRecord({
    entries: [
      { entry_date: "2026-10-15", fact: "Hearing on temporary orders.", entry_kind: "hearing", recommended_direction: null, commentary: null, court_takeaways: null },
      { entry_date: "2026-10-01", fact: "Response due.", entry_kind: "deadline", recommended_direction: null, commentary: null, court_takeaways: null },
      { entry_date: "2026-09-20", fact: "Filed initial petition.", entry_kind: "note", recommended_direction: null, commentary: null, court_takeaways: null },
    ],
  });
  await summarizeCase({ AI: fakeAI }, record);
  assert.match(sentPrompt, /2026-10-15 \[HEARING\]: Hearing on temporary orders\./);
  assert.match(sentPrompt, /2026-10-01 \[DEADLINE\]: Response due\./);
  assert.match(sentPrompt, /2026-09-20: Filed initial petition\./);
});

test("a document's filing/service status is stated exactly as given, never implied beyond it", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };
  const record = emptyRecord({
    documents: [
      { title: "Motion.pdf", filing_status: "drafted" },
      { title: "Response.pdf", filing_status: "filed", filed_date: "2026-09-15" },
      { title: "Notice.pdf", filing_status: "served", served_at: "2026-09-20" },
    ],
  });
  await summarizeCase({ AI: fakeAI }, record);
  assert.match(sentPrompt, /Motion\.pdf \(drafted, not yet filed\)/);
  assert.match(sentPrompt, /Response\.pdf \(filed 2026-09-15\)/);
  assert.match(sentPrompt, /Notice\.pdf \(served 2026-09-20\)/);
});

test("a correction/contradiction recording is tagged explicitly in the prompt, distinct from a plain voice note", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };
  const record = emptyRecord({
    documents: [{ title: "Motion.pdf" }],
    recordings: [
      { noted_at: "2026-09-28", content_type: "correction", body: "Actually the hearing is on the 15th." },
      { noted_at: "2026-09-29", content_type: "contradiction", body: "This conflicts with what I said before." },
      { noted_at: "2026-09-30", content_type: "note", body: "Just a plain thought." },
    ],
  });
  await summarizeCase({ AI: fakeAI }, record);
  assert.match(sentPrompt, /2026-09-28 \[CORRECTION\]: Actually the hearing is on the 15th\./);
  assert.match(sentPrompt, /2026-09-29 \[CONTRADICTION\]: This conflicts with what I said before\./);
  assert.match(sentPrompt, /2026-09-30: Just a plain thought\./);
});

test("the prompt tells the model never to resolve a contradiction itself, only to report that one exists", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };
  const record = emptyRecord({ documents: [{ title: "Motion.pdf" }] });
  await summarizeCase({ AI: fakeAI }, record);
  assert.match(sentPrompt, /[Nn]ever silently resolve a contradiction/);
});
