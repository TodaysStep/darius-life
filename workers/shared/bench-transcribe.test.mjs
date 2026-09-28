import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribeAudio } from "./bench-transcribe.js";

test("a successful transcription returns the model's trimmed text", async () => {
  const fakeAI = { run: async () => ({ text: "  Filed the response this morning.  ", word_count: 5, vtt: "", words: [] }) };
  const { transcript, error } = await transcribeAudio({ AI: fakeAI }, new TextEncoder().encode("fake audio bytes"));
  assert.equal(transcript, "Filed the response this morning.");
  assert.equal(error, null);
});

test("the audio bytes are sent to the model as a plain byte array, matching Whisper's own API shape", async () => {
  let sent = null;
  const fakeAI = { run: async (model, payload) => { sent = { model, payload }; return { text: "ok" }; } };
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await transcribeAudio({ AI: fakeAI }, bytes);
  assert.equal(sent.model, "@cf/openai/whisper");
  assert.deepEqual(sent.payload.audio, [1, 2, 3, 4]);
});

test("an empty transcript from the model is reported as an error, not silently accepted", async () => {
  const fakeAI = { run: async () => ({ text: "" }) };
  const { transcript, error } = await transcribeAudio({ AI: fakeAI }, new Uint8Array([1]));
  assert.equal(transcript, null);
  assert.match(error, /no text/);
});

test("a model failure (thrown error, e.g. the daily free Neuron allocation running dry) never crashes the caller", async () => {
  const fakeAI = { run: async () => { throw new Error("out of capacity"); } };
  const { transcript, error } = await transcribeAudio({ AI: fakeAI }, new Uint8Array([1]));
  assert.equal(transcript, null);
  assert.equal(error, "out of capacity");
});
