// The entrusted view — one render function, called from two places:
// bench-entrusted.js (a real guest, after passphrase login) and
// bench-working.js's preview (Darius, reading the exact same function with
// the exact same query shape, so "preview" can never drift from "real").
//
// This is also the entire confidentiality boundary for docket_entries: the
// only query in this file that touches that table selects exactly
// id/case_label/entry_date/fact/shared_at, filtered to shared_at IS NOT NULL
// and case_id IN the caller's own case list. recommended_direction,
// commentary, court_takeaways, patterns, and glossary_terms are never
// selected here or anywhere else this module can reach.
import { escapeHtml } from "./bench-style.js";

// New desk notes are scoped to both the named grant and its current case list.
// No draft, withdrawn note, audience list, credential or working layer is read.
export async function listDeskUpdates(db, caseIds, grantId) {
  if (!grantId || !caseIds.length) return [];
  const placeholders = caseIds.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT u.id, u.case_label, u.sender_name, u.subject, u.change_summary, u.body, r.shared_at
     FROM bench_desk_updates u
     JOIN bench_desk_releases r ON r.update_id = u.id
     LEFT JOIN bench_desk_withdrawals w ON w.update_id = u.id
     WHERE w.update_id IS NULL AND u.case_id IN (${placeholders})
     AND EXISTS (SELECT 1 FROM json_each(u.audience_json) WHERE json_extract(value, '$.id') = ?)
     ORDER BY r.shared_at DESC`,
  ).bind(...caseIds, grantId).all();
  return results;
}

export function renderDeskUpdates(updates) {
  if (!updates.length) return "";
  const notes = updates.map(n => `<article class="bench-update" id="bench-note-${escapeHtml(n.id)}" aria-labelledby="subject-${escapeHtml(n.id)}">
<p class="update-eyebrow">A Bench Note for you</p>
<h2 id="subject-${escapeHtml(n.id)}">${escapeHtml(n.subject)}</h2>
<p class="update-byline">Shared by <strong>${escapeHtml(n.sender_name)}</strong><br><time datetime="${escapeHtml(n.shared_at)}">${escapeHtml(n.shared_at.replace("T", " ").replace(/\.\d+Z$/, " UTC"))}</time></p>
<p class="update-case">Regarding ${escapeHtml(n.case_label)}</p>
<h3>What changed</h3><p class="update-summary">${escapeHtml(n.change_summary)}</p>
<div class="update-body">${escapeHtml(n.body)}</div>
</article>`).join("\n");
  return `<section class="bench-updates" aria-label="Updates shared with you">${notes}</section>`;
}

export async function listSharedEntries(db, caseIds) {
  if (caseIds.length === 0) return [];
  const placeholders = caseIds.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT id, case_id, case_label, entry_date, fact FROM docket_entries
     WHERE shared_at IS NOT NULL AND case_id IN (${placeholders}) ORDER BY entry_date DESC`,
  ).bind(...caseIds).all();
  return results;
}

export async function listSharedDocuments(db, caseIds) {
  if (caseIds.length === 0) return [];
  const placeholders = caseIds.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT * FROM documents WHERE shared_at IS NOT NULL AND case_id IN (${placeholders}) ORDER BY case_label, created_at DESC`,
  ).bind(...caseIds).all();
  return results;
}

export async function listNotesForCases(db, caseIds) {
  if (caseIds.length === 0) return [];
  const placeholders = caseIds.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT * FROM entrusted_notes WHERE case_id IN (${placeholders}) ORDER BY created_at DESC`,
  ).bind(...caseIds).all();
  return results;
}

function groupByCaseLabel(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.case_label)) groups.set(row.case_label, []);
    groups.get(row.case_label).push(row);
  }
  return groups;
}

// storage_kind "upload" means storage_ref is an internal R2 key, never a
// URL — the caller's own documentHref builds the actual serving address for
// its own side (the working side's Access-gated route, or the entrusted
// side's grant-checked one). storage_kind "link" (the original, and still
// the default for anything written before uploads existed) means storage_ref
// already is the address, validated at write time (bench-data.js).
function renderDocLink(d, documentHref) {
  const href = d.storage_kind === "upload" ? documentHref(d) : d.storage_ref;
  return `<div class="case-row"><a href="${escapeHtml(href)}">${escapeHtml(d.title)}</a>${d.filed_date ? `<span class="status">${escapeHtml(d.filed_date)}</span>` : ""}</div>`;
}

// entry rows reaching this function come only from listSharedEntries's own
// narrow query (id/case_id/case_label/entry_date/fact) — there is no
// commentary/recommended_direction/court_takeaways field to accidentally
// render here even if a caller's row shape changed, because this function
// never references those keys.
function renderEntry(entry, attachedDocs, documentHref) {
  return `<div class="card">
<span class="entry-date">${escapeHtml(entry.entry_date)}</span>
<div class="entry-layer">${escapeHtml(entry.fact)}</div>
${attachedDocs.length ? attachedDocs.map((d) => renderDocLink(d, documentHref)).join("\n") : ""}
</div>`;
}

export function groupsFor(documents, notes, entries) {
  const docGroups = groupByCaseLabel(documents);
  const noteGroups = groupByCaseLabel(notes);
  const entryGroups = groupByCaseLabel(entries);
  const caseLabels = [...new Set([...docGroups.keys(), ...noteGroups.keys(), ...entryGroups.keys()])].sort();
  return { docGroups, noteGroups, entryGroups, caseLabels };
}

// Pure render — no D1 access here at all. `previewBanner`, if given, is
// already-escaped HTML injected at the top (used only by the working side's
// preview; a real entrusted session never sets it). `documentHref(d)`
// builds the actual serving address for an uploaded file (storage_kind
// "upload"); each caller supplies its own, because the working side and the
// entrusted side serve the same bytes from different, differently-gated
// routes. Defaults to the raw (pre-upload-support) behavior.
export function renderEntrustedView(documents, notes, entries, { previewBanner = "", documentHref = (d) => d.storage_ref, updates = [] } = {}) {
  const { docGroups, noteGroups, entryGroups, caseLabels } = groupsFor(documents, notes, entries);

  const sections = caseLabels.length
    ? caseLabels
        .map((label) => {
          const docs = docGroups.get(label) || [];
          const theseNotes = noteGroups.get(label) || [];
          const theseEntries = entryGroups.get(label) || [];
          const generalDocs = docs.filter((d) => !d.entry_id);
          const docsByEntry = new Map();
          for (const d of docs) {
            if (!d.entry_id) continue;
            if (!docsByEntry.has(d.entry_id)) docsByEntry.set(d.entry_id, []);
            docsByEntry.get(d.entry_id).push(d);
          }

          const timeline = theseEntries.length
            ? `<div class="spine">${theseEntries.map((e) => renderEntry(e, docsByEntry.get(e.id) || [], documentHref)).join("\n")}</div>`
            : `<p class="hint">No timeline entries shared yet.</p>`;
          const docRows = generalDocs.length
            ? generalDocs.map((d) => renderDocLink(d, documentHref)).join("\n")
            : `<p class="hint">No general documents shared yet.</p>`;
          const noteRows = theseNotes.map((n) => `<div class="card"><span class="entry-date">${escapeHtml(n.created_at)}</span><div>${escapeHtml(n.body)}</div></div>`).join("\n");

          return `<h2>${escapeHtml(label)}</h2>\n<h3>Timeline</h3>\n${timeline}\n<h3>Documents</h3>\n${docRows}\n${noteRows}`;
        })
        .join("\n<div class=\"ticker\"></div>\n")
    : `<p class="hint">Nothing has been shared with you yet.</p>`;

  return `${previewBanner}${renderDeskUpdates(updates)}${sections}`;
}
