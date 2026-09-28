// Reads an uploaded document's own content to say what it is and find its
// case number, so uploading is the only step Darius has to take — see
// README.md's Bench Notes section. Two functions, deliberately separate:
// extractPdfText (unpdf, not something worth testing here — it isn't this
// repo's code) and classifyDocumentText (env.AI, the part that's actually
// ours and worth testing with a fake AI binding).
//
// The result's `source` is stored on the docket entry (docket_entries.source)
// and shown as a visible tag in the UI — never silently indistinguishable
// from Darius's own typed fact, which the schema's own rule says is never
// inferred or fabricated. An AI-read fact is a different, clearly labeled
// thing: grounded in the document's own text, not invented, but still a
// summary, not testimony.

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_PROMPT_CHARS = 8000;

// Above this, analysis is skipped entirely rather than attempted — pdf.js
// needs to hold a parsed document in memory to read it, on top of whatever
// holding the bytes themselves costs, and a Worker isolate has a hard
// 128 MB ceiling (not per-request — shared, and unforgiving: exceeding it
// gets the whole in-flight request killed, not a catchable error). This
// threshold is deliberately well under that ceiling, not tuned to it.
export const MAX_ANALYZABLE_BYTES = 20 * 1024 * 1024;

// Takes bytes directly (an ArrayBuffer already read from R2 or elsewhere),
// never a File — callers are responsible for deciding whether reading that
// many bytes into memory at all is safe (see MAX_ANALYZABLE_BYTES and how
// the upload finalize route uses it, checking R2's own object size first
// via head(), before ever fetching the bytes).
export async function extractPdfText(bytes, filename, contentType) {
  const isPdf = (contentType || "").includes("pdf") || filename.toLowerCase().endsWith(".pdf");
  if (!isPdf) return "";
  try {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return (text || "").trim();
  } catch {
    // A scanned, image-only PDF (no text layer) or a corrupt file — the
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
  const text = await extractPdfText(bytes, filename, contentType);
  return classifyDocumentText(env, text, filename);
}
