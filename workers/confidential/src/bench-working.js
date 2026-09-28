// confidential.darius.life/bench/* — Bench Notes working side. Darius's own
// private docket: cases, dated timeline entries carrying four simultaneous
// layers (fact, recommended direction, his commentary, court takeaways), a
// living glossary, and pattern-spotting on judge/opposing-counsel behavior.
//
// Gated by the pre-existing Cloudflare Access application that already
// protected confidential.darius.life ("confidential legal area," policy
// "Allowed readers") — reused as-is; see workers/confidential/wrangler.toml
// for how its real team domain/AUD were found. requireAccess below is this
// module's own independent re-check of the Access JWT, same defense-in-depth
// pattern as every other gated route in this repo (workers/shared/access.js).
// This module and bench-entrusted.js (a different Worker entirely — see its
// own header) deliberately share no query helper: this file is the only
// place in either Worker that ever reads or writes cases, docket_entries,
// patterns, or glossary_terms. That is what keeps the entrusted side
// structurally unable to reach this data, rather than merely filtered away
// from it.
import { requireAccess } from "../../shared/access.js";
import { escapeHtml, headers, benchPage, STENOTYPE_ICON } from "../../shared/bench-style.js";
import { sha256Hex } from "../../shared/bench-crypto.js";
import * as data from "../../shared/bench-data.js";
import { listSharedDocuments, listNotesForCases, listSharedEntries, renderEntrustedView } from "../../shared/bench-entrusted-view.js";

export const PREFIX = "/bench/";

const forbidden = () => new Response("Forbidden", { status: 403, headers: headers("text/plain; charset=utf-8") });
const notFound = () => new Response("Not Found", { status: 404, headers: headers("text/plain; charset=utf-8") });
const html = (body, status = 200) => new Response(body, { status, headers: headers("text/html; charset=utf-8") });

function errorPage(message) {
  return benchPage("Error", `<h1>Something went wrong</h1><p class="error">Nothing was saved. ${escapeHtml(message)}</p><p class="note"><a href="${PREFIX}">Back to Bench Notes</a></p>`);
}

// --- D1 access — thin adapters over workers/shared/bench-data.js, the one
// place these operations are actually implemented (the machine API at
// workers/private-legal/src/bench-api.js calls the exact same functions —
// no second copy of what "publish," "share," or "revoke" means). ---

const listCases = (env) => data.listCases(env.BENCH_NOTES);
const getCase = (env, id) => data.getCase(env.BENCH_NOTES, id);
const createCase = (env, fields) => data.createCase(env.BENCH_NOTES, fields);
const listEntries = (env, caseId) => data.listEntries(env.BENCH_NOTES, caseId);
const addEntry = (env, fields) => data.addEntry(env.BENCH_NOTES, fields);
const setEntryShared = (env, id, shared) => data.setEntryShared(env.BENCH_NOTES, id, shared);
const listGlossary = (env, caseId) => data.listGlossary(env.BENCH_NOTES, caseId);
const addGlossaryTerm = (env, fields) => data.addGlossaryTerm(env.BENCH_NOTES, fields);
const listPatterns = (env, caseId) => data.listPatterns(env.BENCH_NOTES, caseId);
const addPattern = (env, fields) => data.addPattern(env.BENCH_NOTES, fields);
const listDocuments = (env, caseId) => data.listDocuments(env.BENCH_NOTES, caseId);
const addDocument = (env, fields) => data.addDocument(env.BENCH_NOTES, fields);
const setDocumentShared = (env, id, shared) => data.setDocumentShared(env.BENCH_NOTES, id, shared);
const listEntrustedNotes = (env, caseId) => data.listEntrustedNotes(env.BENCH_NOTES, caseId);
const addEntrustedNote = (env, fields) => data.addEntrustedNote(env.BENCH_NOTES, fields);
const listGrants = (env) => data.listGrants(env.BENCH_NOTES);
const createGrant = (env, fields) => data.createGrant(env.BENCH_NOTES, fields);
const revokeGrant = (env, id) => data.revokeGrant(env.BENCH_NOTES, id);
const updateGrantPassphrase = (env, id, newCodeHash) => data.updateGrantPassphrase(env.BENCH_NOTES, id, newCodeHash);

// --- Rendering ---

// summary: { caseTitles: string[], docCount, entryCount } — computed by the
// caller (handleBenchGet), since it requires querying shared docs/entries
// per grant, not something this pure render function should do itself.
function renderGrantRow(g, summary) {
  const status = g.revoked_at ? `revoked ${escapeHtml(g.revoked_at)}` : "active";
  const scope = summary.caseTitles.length ? summary.caseTitles.map(escapeHtml).join(", ") : "no cases";
  const sharedCount = `${summary.docCount} document${summary.docCount === 1 ? "" : "s"}, ${summary.entryCount} timeline entr${summary.entryCount === 1 ? "y" : "ies"} shared`;
  return `<div class="card">
<div class="case-row"><span><strong>${escapeHtml(g.label || g.id)}</strong></span><span class="status">${status}</span></div>
<p class="hint">Sees: ${scope} — ${sharedCount}</p>
<div class="case-row">
${g.revoked_at ? "" : `<a href="${PREFIX}preview/${escapeHtml(g.id)}">Preview their view</a>`}
${g.revoked_at ? "" : `<form style="display:inline" method="post" action="${PREFIX}grants/${escapeHtml(g.id)}/revoke"><button type="submit">Revoke</button></form>`}
</div>
${g.revoked_at ? "" : `<form method="post" action="${PREFIX}grants/${escapeHtml(g.id)}/passphrase">
<label for="newPassphrase-${escapeHtml(g.id)}">Change passphrase</label>
<input type="text" id="newPassphrase-${escapeHtml(g.id)}" name="newPassphrase" required>
<button type="submit">Update</button>
</form>`}
</div>`;
}

function renderCaseList(cases, grants, grantSummaries) {
  const rows = cases.length
    ? cases.map((c) => `<div class="case-row"><a href="${PREFIX}case/${escapeHtml(c.id)}">${escapeHtml(c.title)}</a><span class="status">${escapeHtml(c.status)}${c.case_number ? ` · ${escapeHtml(c.case_number)}` : ""}</span></div>`).join("\n")
    : `<p class="hint">No cases yet — add one below.</p>`;
  const grantRows = grants.length ? grants.map((g) => renderGrantRow(g, grantSummaries.get(g.id))).join("\n") : `<p class="hint">No entrusted access granted yet.</p>`;
  const caseCheckboxes = cases.map((c) => `<label class="opt"><input type="checkbox" name="caseIds" value="${escapeHtml(c.id)}"> ${escapeHtml(c.title)}</label>`).join("\n");

  return benchPage(
    "Bench Notes",
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>Bench Notes<span class="tag">Working docket — private</span></h1></header>
<p class="hint">Your own case timelines. Nothing here is visible to anyone on the entrusted side unless you explicitly share a document.</p>
${rows}
<div class="ticker"></div>
<h2>Add a case</h2>
<form method="post" action="${PREFIX}">
<label for="title">Case title</label>
<input type="text" id="title" name="title" required>
<label for="court">Court</label>
<input type="text" id="court" name="court">
<label for="caseNumber">Case number</label>
<input type="text" id="caseNumber" name="caseNumber">
<button type="submit">Add case</button>
</form>

<h2>Entrusted access — management</h2>
<p class="hint">Everything currently live on the entrusted side (<a href="/bench-entrusted/">/bench-entrusted/</a>, a structurally separate area, not this login): who has a passphrase, what they can see, and what's actually been shared with them.</p>
${grantRows}
<h3>Add a guest</h3>
<form method="post" action="${PREFIX}grants">
<label for="grantLabel">Label (for your own reference)</label>
<input type="text" id="grantLabel" name="grantLabel" placeholder="e.g. Attorney — family case">
<label for="passphrase">Passphrase to give them</label>
<input type="text" id="passphrase" name="passphrase" required>
<label>Which cases can they see</label>
<fieldset>${caseCheckboxes || '<p class="hint">Add a case first.</p>'}</fieldset>
<button type="submit">Grant access</button>
</form>`,
  );
}

function renderEntry(base, e, attachedDocs) {
  const layer = (name, value) => (value ? `<div class="entry-layer"><span class="layer-name">${name}</span>${escapeHtml(value)}</div>` : "");
  const shared = Boolean(e.shared_at);
  const toggleAction = `${base}/entries/${escapeHtml(e.id)}/${shared ? "unshare" : "share"}`;
  return `<div class="card">
<div class="case-row"><span class="entry-date">${escapeHtml(e.entry_date)}</span><span class="status">${shared ? `shared ${escapeHtml(e.shared_at)}` : "not shared"} · <form style="display:inline" method="post" action="${toggleAction}"><button type="submit">${shared ? "Unshare" : "Share"}</button></form></span></div>
<div class="entry-layer"><span class="layer-name">Fact</span>${escapeHtml(e.fact)}</div>
${layer("Recommended direction", e.recommended_direction)}
${layer("Commentary", e.commentary)}
${layer("Court takeaways", e.court_takeaways)}
${attachedDocs.length ? attachedDocs.map((d) => renderDocumentRow(base, d)).join("\n") : ""}
</div>`;
}

function renderGlossaryTerm(g) {
  return `<div class="card"><strong>${escapeHtml(g.term)}</strong><div>${escapeHtml(g.definition)}</div></div>`;
}

function renderPattern(p) {
  return `<div class="card"><strong>${escapeHtml(p.subject_name)}</strong> <span class="hint">(${escapeHtml(p.subject_type)})</span><div>${escapeHtml(p.description)}</div></div>`;
}

function renderDocumentRow(base, d) {
  const shared = Boolean(d.shared_at);
  const toggleAction = `${base}/documents/${escapeHtml(d.id)}/${shared ? "unshare" : "share"}`;
  return `<div class="case-row"><span>${escapeHtml(d.title)}${d.filed_date ? ` <span class="hint">(${escapeHtml(d.filed_date)})</span>` : ""}</span><span class="status">${shared ? `shared ${escapeHtml(d.shared_at)}` : "not shared"} · <form style="display:inline" method="post" action="${toggleAction}"><button type="submit">${shared ? "Unshare" : "Share"}</button></form></span></div>`;
}

function renderNoteRow(n) {
  return `<div class="card"><span class="entry-date">${escapeHtml(n.created_at)}</span><div>${escapeHtml(n.body)}</div></div>`;
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function renderCaseDetail(caseRow, entries, glossary, patterns, documents, notes) {
  const base = `${PREFIX}case/${escapeHtml(caseRow.id)}`;
  const docsByEntry = new Map();
  const generalDocs = [];
  for (const d of documents) {
    if (d.entry_id) {
      if (!docsByEntry.has(d.entry_id)) docsByEntry.set(d.entry_id, []);
      docsByEntry.get(d.entry_id).push(d);
    } else generalDocs.push(d);
  }
  const entryOptions = entries
    .map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.entry_date)} — ${escapeHtml(truncate(e.fact, 40))}</option>`)
    .join("\n");

  return benchPage(
    caseRow.title,
    `<header class="bench-header">${STENOTYPE_ICON(40)}<h1>${escapeHtml(caseRow.title)}<span class="tag">${escapeHtml(caseRow.status)}${caseRow.case_number ? ` · ${escapeHtml(caseRow.case_number)}` : ""}${caseRow.court ? ` · ${escapeHtml(caseRow.court)}` : ""}</span></h1></header>
<p class="note"><a href="${PREFIX}">&larr; All cases</a></p>

<h2>Timeline</h2>
<p class="hint">Chronological, dated. Each entry can be shared to the entrusted side on its own — sharing shows only the date and the fact, never your recommended direction, commentary, or court takeaways.</p>
${entries.length ? `<div class="spine">${entries.map((e) => renderEntry(base, e, docsByEntry.get(e.id) || [])).join("\n")}</div>` : `<p class="hint">No entries yet.</p>`}
<div class="ticker"></div>
<h2>Add a docket entry</h2>
<form method="post" action="${base}/entries">
<label for="entryDate">Date</label>
<input type="date" id="entryDate" name="entryDate" required>
<label for="fact">Fact — what happened</label>
<textarea id="fact" name="fact" required></textarea>
<label for="recommendedDirection">Recommended direction (optional)</label>
<textarea id="recommendedDirection" name="recommendedDirection"></textarea>
<label for="commentary">Commentary (optional)</label>
<textarea id="commentary" name="commentary"></textarea>
<label for="courtTakeaways">Court takeaways (optional)</label>
<textarea id="courtTakeaways" name="courtTakeaways"></textarea>
<button type="submit">Add entry</button>
</form>

<h2>Documents</h2>
<p class="hint">The files themselves live wherever you're storing them (the document viewer, R2). This is only the reference — and the switch that shares it to the entrusted side, which never happens on its own. A document tied to a timeline entry (below) shows under that entry instead of here.</p>
${generalDocs.length ? generalDocs.map((d) => renderDocumentRow(base, d)).join("\n") : `<p class="hint">No general documents added yet.</p>`}
<form method="post" action="${base}/documents">
<label for="docTitle">Title</label>
<input type="text" id="docTitle" name="docTitle" required>
<label for="storageRef">Where it lives (a link or reference)</label>
<input type="text" id="storageRef" name="storageRef" required>
<label for="filedDate">Filed date (optional)</label>
<input type="date" id="filedDate" name="filedDate">
<label for="entryId">Attach to a timeline entry (optional)</label>
<select id="entryId" name="entryId">
<option value="">General — not tied to one entry</option>
${entryOptions}
</select>
<button type="submit">Add document</button>
</form>

<h2>Notes to the entrusted side</h2>
<p class="hint">Sent to whoever holds a passphrase scoped to this case, immediately — not the same as your own commentary above, which never leaves this page.</p>
${notes.length ? notes.map(renderNoteRow).join("\n") : `<p class="hint">No notes sent yet.</p>`}
<form method="post" action="${base}/notes">
<label for="noteBody">Note</label>
<textarea id="noteBody" name="noteBody" required></textarea>
<button type="submit">Send note</button>
</form>

<h2>Glossary</h2>
${glossary.length ? glossary.map(renderGlossaryTerm).join("\n") : `<p class="hint">No terms yet.</p>`}
<form method="post" action="${base}/glossary">
<label for="term">Term</label>
<input type="text" id="term" name="term" required>
<label for="definition">Definition</label>
<textarea id="definition" name="definition" required></textarea>
<button type="submit">Add term</button>
</form>

<h2>Patterns</h2>
${patterns.length ? patterns.map(renderPattern).join("\n") : `<p class="hint">No patterns flagged yet.</p>`}
<form method="post" action="${base}/patterns">
<label for="subjectType">Who</label>
<select id="subjectType" name="subjectType">
  <option value="judge">Judge</option>
  <option value="opposing-counsel">Opposing counsel</option>
  <option value="other">Other</option>
</select>
<label for="subjectName">Name</label>
<input type="text" id="subjectName" name="subjectName" required>
<label for="description">What you're noticing</label>
<textarea id="description" name="description" required></textarea>
<button type="submit">Flag pattern</button>
</form>`,
  );
}

// --- Routing ---

export async function handleBenchGet(request, env, url) {
  const payload = await requireAccess(request, env);
  if (!payload) return forbidden();

  const path = url.pathname.slice(PREFIX.length);
  try {
    if (path === "") {
      const [cases, grants] = await Promise.all([listCases(env), listGrants(env)]);
      const caseTitleById = new Map(cases.map((c) => [c.id, c.title]));
      const grantSummaries = new Map();
      await Promise.all(
        grants.map(async (g) => {
          const caseIds = JSON.parse(g.case_ids_json || "[]");
          const [docs, entries] = await Promise.all([
            listSharedDocuments(env.BENCH_NOTES, caseIds),
            listSharedEntries(env.BENCH_NOTES, caseIds),
          ]);
          grantSummaries.set(g.id, {
            caseTitles: caseIds.map((id) => caseTitleById.get(id) || id),
            docCount: docs.length,
            entryCount: entries.length,
          });
        }),
      );
      return html(renderCaseList(cases, grants, grantSummaries));
    }

    const previewMatch = path.match(/^preview\/([^/]+)$/);
    if (previewMatch) {
      const grant = await env.BENCH_NOTES.prepare("SELECT * FROM access_grants WHERE id = ?").bind(previewMatch[1]).first();
      if (!grant || grant.revoked_at) return notFound();
      const caseIds = JSON.parse(grant.case_ids_json || "[]");
      const [documents, notes, entries] = await Promise.all([
        listSharedDocuments(env.BENCH_NOTES, caseIds),
        listNotesForCases(env.BENCH_NOTES, caseIds),
        listSharedEntries(env.BENCH_NOTES, caseIds),
      ]);
      const banner = `<div class="preview-banner"><span>Previewing as: <strong>${escapeHtml(grant.label || grant.id)}</strong> — read-only, no session created</span><a href="${PREFIX}">&larr; Back to your view</a></div>`;
      return html(
        benchPage(
          "Preview — Bench Notes",
          `<header class="bench-header">${STENOTYPE_ICON()}<h1>Bench Notes<span class="tag">Entrusted access (preview)</span></h1></header>${renderEntrustedView(documents, notes, entries, { previewBanner: banner })}`,
        ),
      );
    }

    const caseMatch = path.match(/^case\/([^/]+)$/);
    if (caseMatch) {
      const caseRow = await getCase(env, caseMatch[1]);
      if (!caseRow) return notFound();
      const [entries, glossary, patterns, documents, notes] = await Promise.all([
        listEntries(env, caseRow.id),
        listGlossary(env, caseRow.id),
        listPatterns(env, caseRow.id),
        listDocuments(env, caseRow.id),
        listEntrustedNotes(env, caseRow.id),
      ]);
      return html(renderCaseDetail(caseRow, entries, glossary, patterns, documents, notes));
    }
    return notFound();
  } catch (e) {
    return html(errorPage(e.message), 502);
  }
}

export async function handleBenchPost(request, env, url) {
  const payload = await requireAccess(request, env);
  if (!payload) return forbidden();

  const path = url.pathname.slice(PREFIX.length);
  const form = await request.formData();

  try {
    if (path === "") {
      const title = form.get("title");
      if (!title) return html(errorPage("A case needs a title."), 400);
      const id = crypto.randomUUID();
      await createCase(env, { id, title, court: form.get("court"), caseNumber: form.get("caseNumber") });
      return Response.redirect(`https://darius.life${PREFIX}case/${id}`, 303);
    }

    const entriesMatch = path.match(/^case\/([^/]+)\/entries$/);
    if (entriesMatch) {
      const caseId = entriesMatch[1];
      const caseRow = await getCase(env, caseId);
      if (!caseRow) return notFound();
      const entryDate = form.get("entryDate");
      const fact = form.get("fact");
      if (!entryDate || !fact) return html(errorPage("A docket entry needs a date and a fact."), 400);
      await addEntry(env, {
        id: crypto.randomUUID(),
        caseId,
        caseLabel: caseRow.title,
        entryDate,
        fact,
        recommendedDirection: form.get("recommendedDirection"),
        commentary: form.get("commentary"),
        courtTakeaways: form.get("courtTakeaways"),
      });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const entryShareMatch = path.match(/^case\/([^/]+)\/entries\/([^/]+)\/(share|unshare)$/);
    if (entryShareMatch) {
      const [, caseId, entryId, action] = entryShareMatch;
      if (!(await getCase(env, caseId))) return notFound();
      await setEntryShared(env, entryId, action === "share");
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const glossaryMatch = path.match(/^case\/([^/]+)\/glossary$/);
    if (glossaryMatch) {
      const caseId = glossaryMatch[1];
      if (!(await getCase(env, caseId))) return notFound();
      const term = form.get("term");
      const definition = form.get("definition");
      if (!term || !definition) return html(errorPage("A glossary entry needs a term and a definition."), 400);
      await addGlossaryTerm(env, { id: crypto.randomUUID(), caseId, term, definition });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const patternsMatch = path.match(/^case\/([^/]+)\/patterns$/);
    if (patternsMatch) {
      const caseId = patternsMatch[1];
      if (!(await getCase(env, caseId))) return notFound();
      const subjectType = form.get("subjectType");
      const subjectName = form.get("subjectName");
      const description = form.get("description");
      if (!subjectName || !description) return html(errorPage("A pattern needs a name and a description."), 400);
      await addPattern(env, { id: crypto.randomUUID(), caseId, subjectType: subjectType || "other", subjectName, description });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const documentsMatch = path.match(/^case\/([^/]+)\/documents$/);
    if (documentsMatch) {
      const caseId = documentsMatch[1];
      const caseRow = await getCase(env, caseId);
      if (!caseRow) return notFound();
      const title = form.get("docTitle");
      const storageRef = form.get("storageRef");
      if (!title || !storageRef) return html(errorPage("A document needs a title and where it lives."), 400);
      await addDocument(env, { id: crypto.randomUUID(), caseId, caseLabel: caseRow.title, entryId: form.get("entryId"), title, storageRef, filedDate: form.get("filedDate") });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const shareMatch = path.match(/^case\/([^/]+)\/documents\/([^/]+)\/(share|unshare)$/);
    if (shareMatch) {
      const [, caseId, docId, action] = shareMatch;
      if (!(await getCase(env, caseId))) return notFound();
      await setDocumentShared(env, docId, action === "share");
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    const notesMatch = path.match(/^case\/([^/]+)\/notes$/);
    if (notesMatch) {
      const caseId = notesMatch[1];
      const caseRow = await getCase(env, caseId);
      if (!caseRow) return notFound();
      const body = form.get("noteBody");
      if (!body) return html(errorPage("A note needs a body."), 400);
      await addEntrustedNote(env, { id: crypto.randomUUID(), caseId, caseLabel: caseRow.title, body });
      return Response.redirect(`https://darius.life${PREFIX}case/${caseId}`, 303);
    }

    if (path === "grants") {
      const passphrase = form.get("passphrase");
      if (!passphrase || passphrase.length < 6) return html(errorPage("Passphrase must be at least 6 characters."), 400);
      const caseIds = form.getAll("caseIds");
      const codeHash = await sha256Hex(passphrase);
      await createGrant(env, { id: crypto.randomUUID(), codeHash, caseIds, label: form.get("grantLabel") });
      return Response.redirect(`https://darius.life${PREFIX}`, 303);
    }

    const revokeMatch = path.match(/^grants\/([^/]+)\/revoke$/);
    if (revokeMatch) {
      await revokeGrant(env, revokeMatch[1]);
      return Response.redirect(`https://darius.life${PREFIX}`, 303);
    }

    const passphraseMatch = path.match(/^grants\/([^/]+)\/passphrase$/);
    if (passphraseMatch) {
      const newPassphrase = form.get("newPassphrase");
      if (!newPassphrase || newPassphrase.length < 6) return html(errorPage("Passphrase must be at least 6 characters."), 400);
      await updateGrantPassphrase(env, passphraseMatch[1], await sha256Hex(newPassphrase));
      return Response.redirect(`https://darius.life${PREFIX}`, 303);
    }

    return notFound();
  } catch (e) {
    return html(errorPage(e.message), 502);
  }
}

export const _internal = { renderCaseList, renderCaseDetail, errorPage };
