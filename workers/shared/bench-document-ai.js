// Reads an uploaded document's own content to say what it is and find its
// case number, so uploading is the only step Darius has to take — see
// README.md's Bench Notes section. Two functions, deliberately separate:
// extractPdfText (Cloudflare Workers AI's own toMarkdown utility, called
// through the same env.AI binding classifyDocumentText already uses — not
// something worth testing here, since it isn't this repo's code) and
// classifyDocumentText (the part that's actually ours and worth testing
// with a fake AI binding).
//
// extractPdfText used to shell out to unpdf, parsing the PDF's own bytes
// in-process. That's real CPU work (decompression, content-stream
// tokenizing) — and Workers on the Free plan get a hard, non-configurable
// 10 ms CPU-time budget per request (Paid: 30s default, up to 5 min; the
// override that raises it, `[limits] cpu_ms`, only takes effect on Paid).
// A large or dense PDF could plausibly blow that 10 ms on Free, doing this
// in-Worker — turning "upload a document" into something that silently
// needs a paid plan to reliably finish. Calling env.AI.toMarkdown() instead
// moves the actual parsing onto Cloudflare's own AI infrastructure: from
// this Worker's perspective it's a network call (I/O wait, not CPU time),
// billed in Neurons under the same free 10,000/day account allocation
// classifyDocumentText already draws from — no Workers Paid plan required,
// same as the rest of this file.
//
// The result's `source` is stored on the docket entry (docket_entries.source)
// and shown as a visible tag in the UI — never silently indistinguishable
// from Darius's own typed fact, which the schema's own rule says is never
// inferred or fabricated. An AI-read fact is a different, clearly labeled
// thing: grounded in the document's own text, not invented, but still a
// summary, not testimony.

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_PROMPT_CHARS = 8000;

// Above this, analysis is skipped entirely rather than attempted — reading
// this many bytes into memory to hand to toMarkdown, on top of whatever the
// request itself already holds, risks the same 128 MB per-isolate memory
// ceiling every other upload path in this file respects (shared across the
// whole isolate, not per-request, and unforgiving: exceeding it kills the
// in-flight request outright, not a catchable error). This threshold is
// deliberately well under that ceiling, not tuned to it.
export const MAX_ANALYZABLE_BYTES = 20 * 1024 * 1024;

// Takes bytes directly (an ArrayBuffer already read from R2 or elsewhere),
// never a File — callers are responsible for deciding whether reading that
// many bytes into memory at all is safe (see MAX_ANALYZABLE_BYTES and how
// the upload finalize route uses it, checking R2's own object size first
// via head(), before ever fetching the bytes).
export async function extractPdfText(env, bytes, filename, contentType) {
  const isPdf = (contentType || "").includes("pdf") || filename.toLowerCase().endsWith(".pdf");
  if (!isPdf) return "";
  try {
    const [result] = await env.AI.toMarkdown([
      { name: filename, blob: new Blob([bytes], { type: "application/pdf" }) },
    ]);
    if (!result || result.format === "error") return "";
    return (result.data || "").trim();
  } catch {
    // A scanned, image-only PDF (no text layer), a corrupt file, or the
    // account's free Neuron allocation running dry for the day — the
    // upload still proceeds; see classifyDocumentText's no-text branch.
    return "";
  }
}

function buildPrompt(text) {
  return `You are reading the text of one legal document. Based only on the text below, respond with a JSON object with exactly two keys.
"documentType": one short, plain sentence naming what kind of document this is.
"caseNumber": the case number exactly as written in the document, or null if none appears anywhere in the text. Never invent one that isn't actually written.

Document text:
"""
${text.slice(0, MAX_PROMPT_CHARS)}
"""`;
}

function cleanCaseNumber(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed.slice(0, 100);
}

export async function classifyDocumentText(env, text, filename) {
  if (!text) {
    return {
      fact: `Document uploaded: ${filename}. Its content couldn't be read automatically — this may be a scanned image with no extractable text.`,
      caseNumber: null,
      source: "upload-unreadable",
    };
  }

  try {
    const result = await env.AI.run(MODEL, {
      messages: [{ role: "user", content: buildPrompt(text) }],
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            documentType: { type: "string" },
            caseNumber: { type: ["string", "null"] },
          },
          required: ["documentType", "caseNumber"],
        },
      },
    });
    const parsed = typeof result?.response === "string" ? JSON.parse(result.response) : result?.response;
    const documentType = typeof parsed?.documentType === "string" ? parsed.documentType.trim() : "";
    return {
      fact: documentType ? documentType.slice(0, 500) : `Document uploaded: ${filename}.`,
      caseNumber: cleanCaseNumber(parsed?.caseNumber),
      source: "upload-ai",
    };
  } catch {
    return {
      fact: `Document uploaded: ${filename}. Automatic analysis failed.`,
      caseNumber: null,
      source: "upload-ai-failed",
    };
  }
}

// size is the object's size as R2 already reports it (head(), no bytes
// fetched yet) — analysis is skipped, honestly and cheaply, before ever
// reading a byte, for anything over MAX_ANALYZABLE_BYTES. fetchBytes is
// called only once that decision says it's safe to.
export async function analyzeUploadedDocument(env, filename, contentType, size, fetchBytes) {
  if (size > MAX_ANALYZABLE_BYTES) {
    return {
      fact: `Document uploaded: ${filename}. Too large to read automatically (over ${Math.floor(MAX_ANALYZABLE_BYTES / (1024 * 1024))} MB) — add your own notes on the case page.`,
      caseNumber: null,
      source: "upload-too-large-to-analyze",
    };
  }
  const bytes = await fetchBytes();
  const text = await extractPdfText(env, bytes, filename, contentType);
  return classifyDocumentText(env, text, filename);
}
