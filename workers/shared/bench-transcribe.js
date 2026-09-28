// Turns a recording's own audio into text, via Cloudflare Workers AI's
// Whisper model, called through the same env.AI binding every other AI
// operation in Bench Notes already uses — no separate service, no separate
// key, and (see bench-document-ai.js's own header for the fuller argument)
// no Workers Paid plan: the model's own inference runs on Cloudflare's
// infrastructure, not this Worker's CPU, and @cf/openai/whisper isn't one
// of the models Cloudflare has restricted to the Paid plan — it draws from
// the same free 10,000-Neuron daily account allocation as everything else
// here.
//
// The transcript is Darius's own spoken words, mechanically converted —
// closer in kind to his typed commentary than to an AI-authored summary —
// but automatic speech recognition still makes mistakes, especially on
// names and case-specific terms, so it's stored and shown as a distinct,
// correctable layer (document_recordings.transcript_source: "auto" until
// he edits it, then "manual" — same pattern as docket_entries.source for
// an auto-extracted fact), never silently merged into his own typed body.
const MODEL = "@cf/openai/whisper";

// Above this, transcription is skipped rather than attempted — Whisper's
// own real limits on input length aren't published, and converting a large
// audio buffer into the plain byte array its API expects is itself real
// CPU work (spreading a Uint8Array into a JS array is O(n)); a personal
// voice note is minutes, not hours, long, so this ceiling is generous for
// the real use case without risking either problem on a much larger file.
export const MAX_TRANSCRIBABLE_BYTES = 25 * 1024 * 1024;

// Takes bytes directly (already read from R2), same convention as
// bench-document-ai.js's extractPdfText — callers decide, via a cheap R2
// head() first, whether fetching that many bytes at all is safe.
export async function transcribeAudio(env, bytes) {
  try {
    const result = await env.AI.run(MODEL, { audio: [...new Uint8Array(bytes)] });
    const text = typeof result?.text === "string" ? result.text.trim() : "";
    return { transcript: text || null, error: text ? null : "The model returned no text." };
  } catch (e) {
    return { transcript: null, error: e.message };
  }
}
