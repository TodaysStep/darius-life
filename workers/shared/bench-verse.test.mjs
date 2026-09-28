import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTodayAgenda, selectVerses } from "./bench-verse.js";

function verses() {
  return [
    { id: "v1", reference: "Philippians 4:6-7", translation: "WEB", text: "In nothing be anxious...", tags: "anxiety,peace" },
    { id: "v2", reference: "Joshua 1:9", translation: "WEB", text: "Be strong and courageous...", tags: "courage" },
  ];
}

test("buildTodayAgenda includes hearings/deadlines and prep sessions within the next 7 days, and excludes anything past that window", () => {
  const entries = [
    { entry_date: "2026-10-01", entry_kind: "deadline", fact: "Response due." },   // 3 days out — in window
    { entry_date: "2026-10-20", entry_kind: "hearing", fact: "Far-off hearing." }, // outside window
    { entry_date: "2026-09-20", entry_kind: "hearing", fact: "Already past." },    // in the past
  ];
  const prepSessions = [
    { event_date: "2026-10-02", kind: "presentation", title: "Q4 brand deck" }, // in window
    { event_date: "2026-11-01", kind: "hearing", title: "Far-off prep" },       // outside window
  ];
  const agenda = buildTodayAgenda(entries, prepSessions, "2026-09-28");
  assert.match(agenda, /2026-10-01 \[DEADLINE\]: Response due\./);
  assert.match(agenda, /2026-10-02 \[PRESENTATION\]: Q4 brand deck/);
  assert.doesNotMatch(agenda, /Far-off hearing/);
  assert.doesNotMatch(agenda, /Already past/);
  assert.doesNotMatch(agenda, /Far-off prep/);
});

test("buildTodayAgenda with nothing due in the next 7 days returns an empty string, never a fabricated agenda", () => {
  const agenda = buildTodayAgenda([], [], "2026-09-28");
  assert.equal(agenda, "");
});

test("selectVerses returns the AI's chosen id and reason when the id is actually in the curated list", async () => {
  const fakeAI = { run: async () => ({ response: '{"id": "v2", "reason": "Today includes a hearing; this speaks to courage before it."}' }) };
  const { picks, error } = await selectVerses({ AI: fakeAI }, verses(), "Hearings/deadlines in the next 7 days:\n- 2026-10-01 [HEARING]: X");
  assert.equal(error, null);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].verseId, "v2");
  assert.match(picks[0].reason, /courage/);
});

test("an id the AI invents outside the curated list is dropped, never trusted — this is the entire anti-hallucination boundary", async () => {
  const fakeAI = { run: async () => ({ response: '{"id": "v99-does-not-exist", "reason": "Sounds relevant."}' }) };
  const { picks, error } = await selectVerses({ AI: fakeAI }, verses(), "");
  assert.equal(picks.length, 0);
  assert.match(error, /curated list/);
});

test("the verse's own text is never asked for or trusted from the model — only an id and a reason", async () => {
  let sentPrompt = "";
  const fakeAI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: '{"id": "v1", "reason": "Fits the anxiety of the day."}' }; } };
  await selectVerses({ AI: fakeAI }, verses(), "");
  assert.match(sentPrompt, /never quote, paraphrase, or otherwise write out a verse's own text/);
  assert.doesNotMatch(sentPrompt, /In nothing be anxious/); // the curated text itself is never sent either — only id/reference/tags
});

test("a response that isn't valid JSON is treated as no match, not a crash", async () => {
  const fakeAI = { run: async () => ({ response: "Sure! I'd pick Joshua 1:9 because it's a great verse about courage." }) };
  const { picks, error } = await selectVerses({ AI: fakeAI }, verses(), "");
  assert.equal(picks.length, 0);
  assert.ok(error);
});

test("an empty curated verse set is not a failure — nothing to choose from, so nothing is called", async () => {
  const fakeAI = { run: async () => { throw new Error("should never be called"); } };
  const { picks, error } = await selectVerses({ AI: fakeAI }, [], "anything");
  assert.deepEqual(picks, []);
  assert.equal(error, null);
});

test("a model failure never crashes the caller", async () => {
  const fakeAI = { run: async () => { throw new Error("model unavailable"); } };
  const { picks, error } = await selectVerses({ AI: fakeAI }, verses(), "");
  assert.deepEqual(picks, []);
  assert.equal(error, "model unavailable");
});

test("selectVerses with count > 1 asks for multiple picks and validates each one independently", async () => {
  const fakeAI = { run: async () => ({ response: '{"picks": [{"id": "v1", "reason": "Fits anxiety."}, {"id": "bogus-id", "reason": "Nope."}, {"id": "v2", "reason": "Fits courage."}]}' }) };
  const { picks, error } = await selectVerses({ AI: fakeAI }, verses(), "", { count: 3 });
  assert.equal(error, null);
  assert.deepEqual(picks.map((p) => p.verseId), ["v1", "v2"]);
});
