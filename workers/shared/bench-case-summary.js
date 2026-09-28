// Synthesizes a case's own record — every timeline entry, document, note,
// pattern and glossary term already on file — into one running summary,
// regenerated in the background (see bench-working.js's regenerateCaseSummary
// and its call sites) whenever a write changes what's on record. This is
// the case-wide counterpart to bench-document-ai.js's per-document read:
// that one reads a single file once, at upload; this one re-reads the
// whole case every time something changes, so it can actually improve as
// more of the record accumulates, the way a person re-reading their own
// notes would.
//
// The hard boundary, enforced in the prompt itself, not just described
// here: this never gives legal advice, never predicts an outcome, never
// says who is right. Its only job is accurate synthesis of what is already
// written down. Cloudflare Workers AI is a general-purpose model, not a
// legal one — treat its output as an organizing aid, never as authority,
// and the UI never presents it as anything else (see renderCaseDetail's
// own label).
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_PROMPT_CHARS = 12000;

function serializeCase({ caseRow, entries, documents, notes, patterns, glossary, recordings = [] }) {
  const lines = [];
  lines.push(`Case: ${caseRow.title}`);
  if (caseRow.case_number) lines.push(`Case number: ${caseRow.case_number}`);
  if (caseRow.court) lines.push(`Court: ${caseRow.court}`);
  lines.push(`Status: ${caseRow.status}`);

  lines.push("\nTimeline entries (chronological facts and the founder's own notes about them):");
  if (!entries.length) lines.push("(none yet)");
  for (const e of entries) {
    // entry_kind is explicit, never inferred from the fact's own wording —
    // the founder (or an edit) tagged this as a hearing/deadline himself,
    // on a date he already entered. Surfaced directly so "noted for
    // attention" below doesn't have to guess it from prose.
    const kindTag = e.entry_kind && e.entry_kind !== "note" ? ` [${e.entry_kind.toUpperCase()}]` : "";
    lines.push(`- ${e.entry_date}${kindTag}: ${e.fact}`);
    if (e.recommended_direction) lines.push(`  Recommended direction: ${e.recommended_direction}`);
    if (e.commentary) lines.push(`  Founder's commentary: ${e.commentary}`);
    if (e.court_takeaways) lines.push(`  Court takeaways: ${e.court_takeaways}`);
  }

  lines.push("\nDocuments on file:");
  if (!documents.length) lines.push("(none yet)");
  for (const d of documents) {
    // filing_status is what the founder has actually done, never a
    // deadline or requirement Bench Notes calculated — see documents.
    // filing_status's own schema comment.
    const status = d.filing_status === "served"
      ? `served${d.served_at ? ` ${d.served_at}` : ""}`
      : d.filing_status === "filed"
        ? `filed${d.filed_date ? ` ${d.filed_date}` : ""}`
        : "drafted, not yet filed";
    lines.push(`- ${d.title} (${status})`);
  }

  // Darius's own words, whether typed or spoken and transcribed (Whisper,
  // via bench-transcribe.js) — a voice note not yet transcribed, or one
  // with neither a typed body nor a transcript, has nothing to add here.
  // content_type is explicit, same rule as entry_kind above: the founder's
  // own tag, never inferred from the words themselves, and surfaced
  // directly so a correction or a flagged contradiction is never silently
  // folded into the narrative as if it were just another plain note.
  const recordingLines = recordings
    .map((r) => ({ date: r.noted_at, kind: r.content_type, content: r.body || r.transcript }))
    .filter((r) => r.content);
  if (recordingLines.length) {
    lines.push("\nVoice notes and recordings about specific documents (the founder's own words, dated):");
    for (const r of recordingLines) {
      const kindTag = r.kind && r.kind !== "note" ? ` [${r.kind.toUpperCase()}]` : "";
      lines.push(`- ${r.date}${kindTag}: ${r.content}`);
    }
  }

  if (notes.length) {
    lines.push("\nNotes sent to the entrusted side:");
    for (const n of notes) lines.push(`- ${n.body}`);
  }
  if (patterns.length) {
    lines.push("\nPatterns the founder has flagged:");
    for (const p of patterns) lines.push(`- ${p.subject_type} ${p.subject_name}: ${p.description}`);
  }
  if (glossary.length) {
    lines.push("\nGlossary terms defined for this case:");
    for (const g of glossary) lines.push(`- ${g.term}: ${g.definition}`);
  }

  return lines.join("\n").slice(0, MAX_PROMPT_CHARS);
}

function buildPrompt(record) {
  return `You are helping a self-represented person keep track of their own legal case. You are not a lawyer. You must never give legal advice, never recommend a course of action, never predict who will win or lose, and never speculate about anything not written in the record below. Your only job is an accurate, neutral, organized summary of what is already on record.

Write the summary in this structure:
1. Overview — case number, court, status, and what kind of matter this appears to be, based only on what's written.
2. Chronological summary — what has happened, in order, based on the timeline entries.
3. Documents on file — a short list, including each one's own filing/service status exactly as given (drafted, filed, or served). Never state or imply a document is filed or served unless its status says so.
4. Corrections and contradictions — list every voice note tagged [CORRECTION] or [CONTRADICTION] below, exactly as written, next to what it corrects or conflicts with if that's stated. Never silently resolve a contradiction or decide which version is right — only report that one exists. Never fold a correction into the chronological summary above as if it had always been the fact; note that the record was corrected instead.
5. Upcoming — every entry explicitly tagged [HEARING] or [DEADLINE] below, with its date, in order. Never a date you calculated yourself, and never anything not tagged that way.

If the record is too sparse to say much yet, say that plainly instead of padding it out. Do not add a disclaimer of your own — the person reading this already knows it's a generated summary, not legal advice.

The record:
"""
${serializeCase(record)}
"""`;
}

export async function summarizeCase(env, record) {
  if (!record.entries.length && !record.documents.length) {
    return { summary: null, error: null }; // nothing to summarize yet — not a failure
  }
  try {
    const result = await env.AI.run(MODEL, { messages: [{ role: "user", content: buildPrompt(record) }] });
    const text = typeof result?.response === "string" ? result.response.trim() : "";
    return { summary: text || null, error: text ? null : "The model returned an empty response." };
  } catch (e) {
    return { summary: null, error: e.message };
  }
}
