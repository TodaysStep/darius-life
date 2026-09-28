import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePressureTest } from "./bench-prep.js";

function hearingSession(overrides = {}) {
  return { id: "prep-1", kind: "hearing", title: "TRO hearing prep", case_id: "case-1", event_date: "2026-10-15", context: null, ...overrides };
}

function presentationSession(overrides = {}) {
  return { id: "prep-2", kind: "presentation", title: "Q4 brand deck", case_id: null, event_date: "2026-10-02", context: null, ...overrides };
}

test("a hearing-kind session sends case, pattern, and upcoming-entry context to the model", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "1. What if opposing counsel raises the timeline again?" }; } };
  const session = hearingSession({ context: "Judge X has been strict about deadlines." });
  const record = {
    caseRow: { title: "Family matter", case_number: "CV-1", court: "Superior Court" },
    patterns: [{ subject_type: "judge", subject_name: "Judge X", description: "Repeatedly raises timeline objections." }],
    entries: [{ entry_date: "2026-10-01", entry_kind: "deadline", fact: "Response due." }],
  };
  const { pressureTest, error } = await generatePressureTest({ AI: fakeAI }, session, record);
  assert.match(sentPrompt, /Judge X has been strict about deadlines\./);
  assert.match(sentPrompt, /Repeatedly raises timeline objections\./);
  assert.match(sentPrompt, /2026-10-01 \[DEADLINE\]: Response due\./);
  assert.match(sentPrompt, /Family matter \(CV-1\)/);
  assert.match(pressureTest, /timeline/);
  assert.equal(error, null);
});

test("a presentation-kind session sends only its own context, never a case or pattern reference", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "1. What if the client objects to the new typography again?" }; } };
  const session = presentationSession({ context: "Stakeholders rejected the last deck's typography." });
  const { pressureTest } = await generatePressureTest({ AI: fakeAI }, session, {});
  assert.match(sentPrompt, /Stakeholders rejected the last deck's typography\./);
  assert.doesNotMatch(sentPrompt, /Case:/);
  assert.doesNotMatch(sentPrompt, /flagged about the judge/);
  assert.match(pressureTest, /typography/);
});

test("the prompt forbids legal advice, design advice, telling Darius what to say, and predicting the outcome", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };
  await generatePressureTest({ AI: fakeAI }, hearingSession(), { patterns: [], entries: [] });
  assert.match(sentPrompt, /never give legal advice/i);
  assert.match(sentPrompt, /never give design or communication advice/i);
  assert.match(sentPrompt, /never tell them what to say or do/i);
  assert.match(sentPrompt, /never predict the outcome/i);

  sentPrompt = "";
  await generatePressureTest({ AI: fakeAI }, presentationSession(), {});
  assert.match(sentPrompt, /never give legal advice/i);
  assert.match(sentPrompt, /never predict the outcome/i);
});

test("a hearing session with no patterns and no upcoming entries still generates a prompt, plainly noting nothing is flagged yet", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };
  await generatePressureTest({ AI: fakeAI }, hearingSession(), { caseRow: { title: "Family matter" }, patterns: [], entries: [] });
  assert.match(sentPrompt, /No patterns flagged for this case yet\./);
});

test("a model failure never crashes the caller — returns a null pressure test and the error", async () => {
  const fakeAI = { run: async () => { throw new Error("model unavailable"); } };
  const { pressureTest, error } = await generatePressureTest({ AI: fakeAI }, hearingSession(), {});
  assert.equal(pressureTest, null);
  assert.equal(error, "model unavailable");
});

test("an empty response from the model is reported as an error, not silently accepted", async () => {
  const fakeAI = { run: async () => ({ response: "" }) };
  const { pressureTest, error } = await generatePressureTest({ AI: fakeAI }, presentationSession(), {});
  assert.equal(pressureTest, null);
  assert.match(error, /empty response/);
});
