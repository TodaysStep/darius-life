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
