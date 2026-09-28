// Pressure-testing for an upcoming hearing or an upcoming design
// presentation/meeting — one shared module, two event kinds. See the
// schema's own comment on prep_sessions for why hearing prep and
// presentation prep live in one area: Darius is both a self-represented
// litigant and a presentation designer, and the system tells the two
// apart explicitly (session.kind), never by guessing from wording.
//
// The hard boundary, enforced in the prompt itself, not just described
// here: this never gives legal advice, never gives design or
// communication advice, never tells Darius what to say or do, and never
// predicts an outcome. Its only job is to hand back specific, concrete
// questions or challenges to rehearse answering — grounded only in what's
// already on record (a flagged pattern, a prior contradiction, or the
// audience/stakes Darius himself described), never anything invented
// beyond that. Same "organizing aid, never authority" boundary as
// bench-case-summary.js, and the same general-purpose (not legal, not
// design) Cloudflare Workers AI model underneath.
//
// Called synchronously, only on Darius's own explicit "Generate pressure
// test" action (bench-working.js) — never in the background, and never
// automatically on page load, so pressure_test_updated_at always means he
// asked for this just now.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_RECORD_CHARS = 8000;

function serializeHearingRecord({ session, caseRow, patterns, entries }) {
  const lines = [];
  lines.push(`Hearing: ${session.title}`);
  if (session.event_date) lines.push(`Date: ${session.event_date}`);
  if (caseRow) {
    lines.push(`Case: ${caseRow.title}${caseRow.case_number ? ` (${caseRow.case_number})` : ""}`);
    if (caseRow.court) lines.push(`Court: ${caseRow.court}`);
  }
  if (session.context) lines.push(`\nDarius's own notes on this hearing:\n${session.context}`);

  if (patterns.length) {
    lines.push("\nPatterns Darius has flagged about the judge or opposing counsel in this case:");
    for (const p of patterns) lines.push(`- ${p.subject_type} ${p.subject_name}: ${p.description}`);
  } else {
    lines.push("\n(No patterns flagged for this case yet.)");
  }

  const flagged = entries.filter((e) => e.entry_kind === "hearing" || e.entry_kind === "deadline");
  if (flagged.length) {
    lines.push("\nUpcoming hearings/deadlines already on record for this case:");
    for (const e of flagged) lines.push(`- ${e.entry_date} [${e.entry_kind.toUpperCase()}]: ${e.fact}`);
  }

  return lines.join("\n");
}

function serializePresentationRecord({ session }) {
  const lines = [];
  lines.push(`Presentation/meeting: ${session.title}`);
  if (session.event_date) lines.push(`Date: ${session.event_date}`);
  lines.push(session.context
    ? `\nDarius's own description of the audience, stakes, and content:\n${session.context}`
    : "\n(No further description on record yet.)");
  return lines.join("\n");
}

function buildPrompt(session, record) {
  const isHearing = session.kind === "hearing";
  const body = (isHearing ? serializeHearingRecord(record) : serializePresentationRecord(record)).slice(0, MAX_RECORD_CHARS);
  const domainLine = isHearing
    ? "You are helping a self-represented person prepare for a court hearing."
    : "You are helping a presentation designer prepare for a design presentation or a client/stakeholder meeting.";
  const groundingLine = isHearing
    ? "Draw the questions from the flagged patterns and record below — for example, if a pattern shows the judge has repeatedly raised a particular objection, anticipate that objection again."
    : "Draw the questions from the audience, stakes, and content described below — for example, if a stakeholder objection or a tough tradeoff is mentioned, anticipate that challenge again.";

  return `${domainLine} You must never give legal advice, never give design or communication advice, never tell them what to say or do, and never predict the outcome. Your only job is to anticipate hard questions or challenges to rehearse answering, based only on what is written below — never anything invented or guessed beyond it.

${groundingLine}

List 4-8 specific, concrete questions or challenges to rehearse answering — not generic advice, not a script of what to say back. If the record below is too sparse to produce anything grounded, say that plainly instead of inventing generic questions with nothing behind them.

The record:
"""
${body}
"""`;
}

// session: a prep_sessions row. record: { caseRow, patterns, entries } for
// a hearing-kind session (entries/patterns default to [] if omitted — a
// presentation-kind session never has any); ignored for a
// presentation-kind session, which draws only on session.context.
export async function generatePressureTest(env, session, record = {}) {
  const { caseRow = null, patterns = [], entries = [] } = record;
  try {
    const prompt = buildPrompt(session, { session, caseRow, patterns, entries });
    const result = await env.AI.run(MODEL, { messages: [{ role: "user", content: prompt }] });
    const text = typeof result?.response === "string" ? result.response.trim() : "";
    return { pressureTest: text || null, error: text ? null : "The model returned an empty response." };
  } catch (e) {
    return { pressureTest: null, error: e.message };
  }
}
