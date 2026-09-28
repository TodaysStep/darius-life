// darius.life/bench/* — Bench Notes working side. Darius's own private docket:
// cases, dated timeline entries carrying four simultaneous layers (fact,
// recommended direction, his commentary, court takeaways), a living glossary,
// and pattern-spotting on judge/opposing-counsel behavior.
//
// Gated by the same Cloudflare Access application as /legal/private/* and
// /control/* — see src/access.js. This module and bench-entrusted.js
// deliberately share no query helper: this file is the only place in the
// whole Worker that ever reads or writes cases, docket_entries, patterns, or
// glossary_terms. That is what keeps the entrusted side structurally unable
// to reach this data, rather than merely filtered away from it.
import { requireAccess } from "./access.js";
import { escapeHtml, headers, benchPage, STENOTYPE_ICON } from "./bench-style.js";
import { sha256Hex } from "./bench-crypto.js";

export const PREFIX = "/bench/";

const forbidden = () => new Response("Forbidden", { status: 403, headers: headers("text/plain; charset=utf-8") });
const notFound = () => new Response("Not Found", { status: 404, headers: headers("text/plain; charset=utf-8") });
const html = (body, status = 200) => new Response(body, { status, headers: headers("text/html; charset=utf-8") });

function errorPage(message) {
  return benchPage("Error", `<h1>Something went wrong</h1><p class="error">Nothing was saved. ${escapeHtml(message)}</p><p class="note"><a href="${PREFIX}">Back to Bench Notes</a></p>`);
}

// --- D1 access — the only functions in this file that touch the database ---

async function listCases(env) {
  const { results } = await env.BENCH_NOTES.prepare(
    "SELECT id, title, court, case_number, status FROM cases ORDER BY updated_at DESC",
  ).all();
  return results;
}

async function getCase(env, id) {
  return env.BENCH_NOTES.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first();
}

async function createCase(env, { id, title, court, caseNumber }) {
  await env.BENCH_NOTES.prepare(
    "INSERT INTO cases (id, title, court, case_number) VALUES (?, ?, ?, ?)",
  ).bind(id, title, court || null, caseNumber || null).run();
}

async function listEntries(env, caseId) {
  const { results } = await env.BENCH_NOTES.prepare(
    "SELECT * FROM docket_entries WHERE case_id = ? ORDER BY entry_date DESC, created_at DESC",
  ).bind(caseId).all();
  return results;
}

async function addEntry(env, { id, caseId, entryDate, fact, recommendedDirection, commentary, courtTakeaways }) {
  await env.BENCH_NOTES.prepare(
    `INSERT INTO docket_entries (id, case_id, entry_date, fact, recommended_direction, commentary, court_takeaways)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, caseId, entryDate, fact, recommendedDirection || null, commentary || null, courtTakeaways || null).run();
  await env.BENCH_NOTES.prepare("UPDATE cases SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(caseId).run();
}

async function listGlossary(env, caseId) {
  const { results } = await env.BENCH_NOTES.prepare(
    "SELECT * FROM glossary_terms WHERE case_id = ? OR case_id IS NULL ORDER BY term COLLATE NOCASE",
  ).bind(caseId).all();
  return results;
}

async function addGlossaryTerm(env, { id, caseId, term, definition }) {
  await env.BENCH_NOTES.prepare(
    "INSERT INTO glossary_terms (id, case_id, term, definition) VALUES (?, ?, ?, ?)",
  ).bind(id, caseId, term, definition).run();
}

async function listPatterns(env, caseId) {
  const { results } = await env.BENCH_NOTES.prepare(
    "SELECT * FROM patterns WHERE case_id = ? ORDER BY updated_at DESC",
  ).bind(caseId).all();
  return results;
}

async function addPattern(env, { id, caseId, subjectType, subjectName, description }) {
  await env.BENCH_NOTES.prepare(
    "INSERT INTO patterns (id, case_id, subject_type, subject_name, description) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, caseId, subjectType, subjectName, description).run();
}

// Documents are the one working-side-managed table the entrusted side also
// reads — Darius adds a reference here (the file itself lives in the Lovable
// document viewer or R2; storage_ref just points at it) and explicitly shares
// it. Nothing is shared automatically.
async function listDocuments(env, caseId) {
  const { results } = await env.BENCH_NOTES.prepare(
    "SELECT * FROM documents WHERE case_id = ? ORDER BY created_at DESC",
  ).bind(caseId).all();
  return results;
}

async function addDocument(env, { id, caseId, caseLabel, title, storageRef, filedDate }) {
  await env.BENCH_NOTES.prepare(
    "INSERT INTO documents (id, case_id, case_label, title, storage_ref, filed_date) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, caseId, caseLabel, title, storageRef, filedDate || null).run();
}

async function setDocumentShared(env, id, shared) {
  await env.BENCH_NOTES.prepare(
    `UPDATE documents SET shared_at = ${shared ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : "NULL"} WHERE id = ?`,
  ).bind(id).run();
}

// Entrusted notes — occasional notes Darius writes directly TO the entrusted
// side. Distinct from commentary (working-side, never shared): these are
// written knowing a guest will read them, and go out immediately, not behind
// a share toggle.
async function listEntrustedNotes(env, caseId) {
  const { results } = await env.BENCH_NOTES.prepare(
    "SELECT * FROM entrusted_notes WHERE case_id = ? ORDER BY created_at DESC",
  ).bind(caseId).all();
  return results;
}

async function addEntrustedNote(env, { id, caseId, caseLabel, body }) {
  await env.BENCH_NOTES.prepare(
    "INSERT INTO entrusted_notes (id, case_id, case_label, body) VALUES (?, ?, ?, ?)",
  ).bind(id, caseId, caseLabel, body).run();
}

// Entrusted access grants — the single universal passphrase per grant, scoped
// to specific cases, revocable. Creating/revoking a grant is a working-side
// admin action; bench-entrusted.js only ever reads a grant by its code_hash.
async function listGrants(env) {
  const { results } = await env.BENCH_NOTES.prepare(
    "SELECT id, label, case_ids_json, created_at, revoked_at FROM access_grants ORDER BY created_at DESC",
  ).all();
  return results;
}

async function createGrant(env, { id, codeHash, caseIds, label }) {
  await env.BENCH_NOTES.prepare(
    "INSERT INTO access_grants (id, code_hash, case_ids_json, label) VALUES (?, ?, ?, ?)",
  ).bind(id, codeHash, JSON.stringify(caseIds), label || null).run();
}

async function revokeGrant(env, id) {
  await env.BENCH_NOTES.prepare(
    "UPDATE access_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL",
  ).bind(id).run();
}

// --- Rendering ---

function renderGrantRow(g) {
  const caseIds = JSON.parse(g.case_ids_json || "[]");
  const status = g.revoked_at ? `revoked ${escapeHtml(g.revoked_at)}` : "active";
  return `<div class="case-row"><span>${escapeHtml(g.label || g.id)} <span class="hint">(${caseIds.length} case${caseIds.length === 1 ? "" : "s"})</span></span><span class="status">${status}${!g.revoked_at ? ` · <form style="display:inline" method="post" action="${PREFIX}grants/${escapeHtml(g.id)}/revoke"><button type="submit">Revoke</button></form>` : ""}</span></div>`;
}

function renderCaseList(cases, grants) {
  const rows = cases.length
    ? cases.map((c) => `<div class="case-row"><a href="${PREFIX}case/${escapeHtml(c.id)}">${escapeHtml(c.title)}</a><span class="status">${escapeHtml(c.status)}${c.case_number ? ` · ${escapeHtml(c.case_number)}` : ""}</span></div>`).join("\n")
    : `<p class="hint">No cases yet — add one below.</p>`;
  const grantRows = grants.length ? grants.map(renderGrantRow).join("\n") : `<p class="hint">No entrusted access granted yet.</p>`;
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

<h2>Entrusted access</h2>
<p class="hint">Documents-only, password-protected guests — a structurally separate area at <a href="/bench-entrusted/">/bench-entrusted/</a>. Not the same login as this page.</p>
${grantRows}
<form method="post" action="${PREFIX}grants">
<label for="grantLabel">Label (for your own reference)</label>
<input type="text" id="grantLabel" name="grantLabel" placeholder="e.g. Attorney — family case">
<label for="passphrase">Passphrase to give them</label>
<input type="text" id="passphrase" name="passphrase" required>
<label>Which cases can they see documents for</label>
<fieldset>${caseCheckboxes || '<p class="hint">Add a case first.</p>'}</fieldset>
<button type="submit">Grant access</button>
</form>`,
  );
}

function renderEntry(e) {
  const layer = (name, value) => (value ? `<div class="entry-layer"><span class="layer-name">${name}</span>${escapeHtml(value)}</div>` : "");
  return `<div class="card">
<span class="entry-date">${escapeHtml(e.entry_date)}</span>
<div class="entry-layer"><span class="layer-name">Fact</span>${escapeHtml(e.fact)}</div>
${layer("Recommended direction", e.recommended_direction)}
${layer("Commentary", e.commentary)}
${layer("Court takeaways", e.court_takeaways)}
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

function renderCaseDetail(caseRow, entries, glossary, patterns, documents, notes) {
  const base = `${PREFIX}case/${escapeHtml(caseRow.id)}`;
  return benchPage(
    caseRow.title,
    `<header class="bench-header">${STENOTYPE_ICON(40)}<h1>${escapeHtml(caseRow.title)}<span class="tag">${escapeHtml(caseRow.status)}${caseRow.case_number ? ` · ${escapeHtml(caseRow.case_number)}` : ""}${caseRow.court ? ` · ${escapeHtml(caseRow.court)}` : ""}</span></h1></header>
<p class="note"><a href="${PREFIX}">&larr; All cases</a></p>

<h2>Documents</h2>
<p class="hint">The files themselves live wherever you're storing them (the document viewer, R2). This is only the reference — and the switch that shares it to the entrusted side, which never happens on its own.</p>
${documents.length ? documents.map((d) => renderDocumentRow(base, d)).join("\n") : `<p class="hint">No documents added yet.</p>`}
<form method="post" action="${base}/documents">
<label for="docTitle">Title</label>
<input type="text" id="docTitle" name="docTitle" required>
<label for="storageRef">Where it lives (a link or reference)</label>
<input type="text" id="storageRef" name="storageRef" required>
<label for="filedDate">Filed date (optional)</label>
<input type="date" id="filedDate" name="filedDate">
<button type="submit">Add document</button>
</form>

<h2>Notes to the entrusted side</h2>
<p class="hint">Sent to whoever holds a passphrase scoped to this case, immediately — not the same as your own commentary below, which never leaves this page.</p>
${notes.length ? notes.map(renderNoteRow).join("\n") : `<p class="hint">No notes sent yet.</p>`}
<form method="post" action="${base}/notes">
<label for="noteBody">Note</label>
<textarea id="noteBody" name="noteBody" required></textarea>
<button type="submit">Send note</button>
</form>

<h2>Timeline</h2>
${entries.length ? entries.map(renderEntry).join("\n") : `<p class="hint">No entries yet.</p>`}
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
      return html(renderCaseList(cases, grants));
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
      if (!(await getCase(env, caseId))) return notFound();
      const entryDate = form.get("entryDate");
      const fact = form.get("fact");
      if (!entryDate || !fact) return html(errorPage("A docket entry needs a date and a fact."), 400);
      await addEntry(env, {
        id: crypto.randomUUID(),
        caseId,
        entryDate,
        fact,
        recommendedDirection: form.get("recommendedDirection"),
        commentary: form.get("commentary"),
        courtTakeaways: form.get("courtTakeaways"),
      });
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
      await addDocument(env, { id: crypto.randomUUID(), caseId, caseLabel: caseRow.title, title, storageRef, filedDate: form.get("filedDate") });
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

    return notFound();
  } catch (e) {
    return html(errorPage(e.message), 502);
  }
}

export const _internal = { renderCaseList, renderCaseDetail, errorPage };
