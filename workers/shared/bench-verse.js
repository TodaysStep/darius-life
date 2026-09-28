// Scripture verse-of-the-day selection, and the deeper research behind
// it — grounded strictly in a curated, closed set Darius has personally
// approved (see the schema's own comment on scripture_verses for why).
//
// This module is the entire anti-hallucination boundary for scripture in
// this app: the model is only ever handed the verses already in that set
// (id, reference, translation, tags — never asked to produce verse text
// itself), it returns an id, and that id is always checked against the
// same list before anything is trusted here. bench-working.js then reads
// the verse's actual text back from the database by the validated id,
// never from anything the model said directly. A response naming an id
// outside the given set, or no valid id at all, is treated as no match —
// never a made-up fallback and never a partial quote.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DAY_MS = 24 * 60 * 60 * 1000;
const AGENDA_WINDOW_DAYS = 7;

// Pure — takes what's already been fetched (data.listUpcomingEntries,
// data.listPrepSessions) and today's own date string (YYYY-MM-DD), and
// boils it down to the handful of lines selectVerses actually needs:
// nothing case-wide or site-wide, only what's due soon enough to matter
// for today's pick. Same "date math happens in the caller, not pushed
// into a query" convention as bench-working.js's own renderUpcoming.
export function buildTodayAgenda(entries, prepSessions, today) {
  const cutoffMs = new Date(`${today}T00:00:00Z`).getTime() + AGENDA_WINDOW_DAYS * DAY_MS;
  const withinWindow = (dateStr) => {
    if (!dateStr || dateStr < today) return false;
    return new Date(`${dateStr}T00:00:00Z`).getTime() <= cutoffMs;
  };

  const lines = [];
  const dueEntries = entries.filter((e) => withinWindow(e.entry_date));
  if (dueEntries.length) {
    lines.push("Hearings/deadlines in the next 7 days:");
    for (const e of dueEntries) lines.push(`- ${e.entry_date} [${e.entry_kind.toUpperCase()}]: ${e.fact}`);
  }

  const dueSessions = prepSessions.filter((s) => withinWindow(s.event_date));
  if (dueSessions.length) {
    lines.push(`${lines.length ? "\n" : ""}Prep sessions in the next 7 days:`);
    for (const s of dueSessions) lines.push(`- ${s.event_date} [${s.kind.toUpperCase()}]: ${s.title}`);
  }

  return lines.join("\n");
}

function buildPrompt(agenda, verses, count) {
  const list = verses.map((v) => `${v.id}: ${v.reference} (tags: ${v.tags || "none"})`).join("\n");
  const askLine = count === 1
    ? "Choose the single best-matching verse"
    : `Choose up to ${count} best-matching verses, most relevant first`;
  const responseShape = count === 1
    ? `{"id": "<one id from the list above>", "reason": "<one sentence, grounded in the agenda above>"}`
    : `{"picks": [{"id": "<id>", "reason": "<one sentence>"}, ...]}`;

  return `You are helping a self-represented person and presentation designer pick scripture to read before a day that may include a court hearing, a design presentation, or both.

${askLine} from this exact list, based only on what today's agenda below actually contains. Never invent a verse, never pick one outside this list, and never quote, paraphrase, or otherwise write out a verse's own text — you are only choosing an id, not writing scripture.

Verses available (id: reference):
${list}

Today's agenda:
"""
${agenda || "(Nothing specific is on record for the next 7 days.)"}
"""

Respond with strict JSON only, no other text: ${responseShape}`;
}

function parseResponse(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

// verses: the curated set (data.listScriptureVerses's own rows) — the
// only ones the model is ever shown or allowed to return. agenda:
// buildTodayAgenda's own output, or any other plain-text summary of what
// today is actually about — a research query works the same way. Returns
// { picks: [{ verseId, reason }], error } — picks only ever names an id
// actually present in `verses`; a hallucinated, missing, or malformed
// response yields zero picks and an error, never a guess.
export async function selectVerses(env, verses, agenda, { count = 1 } = {}) {
  if (!verses.length) return { picks: [], error: null }; // nothing to choose from — not a failure
  try {
    const prompt = buildPrompt(agenda, verses, count);
    const result = await env.AI.run(MODEL, { messages: [{ role: "user", content: prompt }] });
    const text = typeof result?.response === "string" ? result.response.trim() : "";
    const parsed = text ? parseResponse(text) : null;
    if (!parsed) {
      return { picks: [], error: text ? "The model's response could not be read as a verse pick." : "The model returned an empty response." };
    }

    const validIds = new Set(verses.map((v) => v.id));
    const rawPicks = count === 1
      ? (parsed.id ? [{ id: parsed.id, reason: parsed.reason }] : [])
      : (Array.isArray(parsed.picks) ? parsed.picks : []);
    const picks = rawPicks
      .filter((p) => p && validIds.has(p.id))
      .map((p) => ({ verseId: p.id, reason: typeof p.reason === "string" ? p.reason : null }));
    return { picks, error: picks.length ? null : "The model didn't name a verse from the curated list." };
  } catch (e) {
    return { picks: [], error: e.message };
  }
}
