// Entrusted access is an independent passphrase boundary, never Cloudflare
// Access. Every original-evidence request rechecks the active grant, shared
// entry scope, explicit intake sharing and artifact membership. Private docket
// interpretation layers and private document recordings are never rendered.
import { escapeHtml, headers, benchPage, STENOTYPE_ICON } from "../../shared/bench-style.js";
import { sha256Hex, signSession, verifySession } from "../../shared/bench-crypto.js";
import { listSharedDocuments, listNotesForCases, listSharedEntries, renderEntrustedView } from "../../shared/bench-entrusted-view.js";

import { renderEvidenceText, renderEvidenceAudio, renderEvidenceTranscript } from "../../shared/bench-rich-text.js";
import { getEvidence } from "../../shared/bench-evidence.js";
import { evidenceFileResponse } from "../../shared/evidence-file-response.js";

export const PREFIX = "/entrusted/";
const COOKIE_NAME = "bench_entrusted_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

const html = (body, status = 200) => new Response(body, { status, headers: headers("text/html; charset=utf-8") });
const notFound = () => new Response("Not Found", { status: 404, headers: headers("text/plain; charset=utf-8") });

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function setCookieHeader(value, maxAgeSeconds) {
  return `${COOKIE_NAME}=${value}; Path=${PREFIX}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

// --- Grant and explicitly shared evidence access ---

async function getGrant(env, id) {
  return env.BENCH_NOTES.prepare("SELECT * FROM access_grants WHERE id = ?").bind(id).first();
}

async function findActiveGrantByCodeHash(env, codeHash) {
  return env.BENCH_NOTES.prepare("SELECT * FROM access_grants WHERE code_hash = ? AND revoked_at IS NULL").bind(codeHash).first();
}

async function getSharedEntryForGrant(env, grant, entryId) {
  if (!grant || grant.revoked_at) return null;
  const caseIds = JSON.parse(grant.case_ids_json || "[]");
  const entry = await env.BENCH_NOTES.prepare(
    "SELECT id, case_id, share_number FROM docket_entries WHERE id = ? AND shared_at IS NOT NULL"
  ).bind(entryId).first();
  return entry && caseIds.includes(entry.case_id) ? entry : null;
}

async function getLatestSharedEntryForGrant(env, grant) {
  if (!grant || grant.revoked_at) return null;
  const caseIds = JSON.parse(grant.case_ids_json || "[]");
  if (!caseIds.length) return null;
  const placeholders = caseIds.map(() => "?").join(",");
  return env.BENCH_NOTES.prepare(
    `SELECT id, case_id, share_number FROM docket_entries
     WHERE shared_at IS NOT NULL AND case_id IN (${placeholders})
     ORDER BY share_number DESC, created_at DESC LIMIT 1`
  ).bind(...caseIds).first();
}

// --- Rendering ---

function noteNumber(n) {
  return String(n || 0).padStart(3, "0");
}

function renderEnvelope(grant, entry, error = "") {
  const number = noteNumber(entry.share_number);
  const label = `Bench Note ${number}`;
  let page = benchPage(
    `${label} · Confidential Access`,
    `<main class="envelope">
${STENOTYPE_ICON(260)}
<div class="envelope-kicker"><span>Court record</span><span>Confidential access</span></div>
<h1>Bench Note<span class="note-no">${number}</span></h1>
<div class="access-mark">Confidential Access</div>
<hr class="envelope-rule">
<p class="confidential-copy">A private Bench Note has been shared with you.<br>Its subject and contents remain confidential until access is granted.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${PREFIX}${grant.id}/note/${entry.id}/login" novalidate>
<label for="passphrase">Enter passphrase</label>
<input type="password" id="passphrase" name="passphrase" autocomplete="current-password" autofocus>
<input type="submit" class="entrusted-submit" value="Open Bench Note →" formmethod="post" formaction="${PREFIX}${grant.id}/note/${entry.id}/login">
</form>
<div class="envelope-seal">Private record · Authorized access only</div>
</main>`
  );
  const title = `${label} · Confidential Access`;
  const meta = `
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="Confidential access · darius.life">
<meta property="og:type" content="website">
<meta property="og:image" content="https://confidential.darius.life/entrusted/stenotype.jpg?v=20261004-3">\n<meta property="og:image:secure_url" content="https://confidential.darius.life/entrusted/stenotype.jpg?v=20261004-3">
<meta property="og:image:type" content="image/jpeg">\n<meta property="og:image:width" content="447">
<meta property="og:image:height" content="447">
<meta property="og:image:alt" content="Stenotype machine on a white field">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="Confidential access · darius.life">
<meta name="twitter:image" content="https://confidential.darius.life/entrusted/stenotype.jpg?v=20261004-3">`;
  page = page.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
  return page.replace("</head>", `${meta}\n</head>`);
}
function renderLogin(error) {
  return benchPage(
    "Bench Notes — Entrusted access",
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>Bench Notes<span class="tag">Entrusted access</span></h1></header>
<p class="hint">Documents shared with you. This is a separate, password-protected area — not a view into anything else.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${PREFIX}login">
<label for="passphrase">Passphrase</label>
<input type="password" id="passphrase" name="passphrase" required autofocus>
<button type="submit">Enter</button>
</form>`,
  );
}

// storage_kind "upload" documents are served from this Worker's own R2
// binding (BENCH_DOCUMENTS — the same bucket the working side uses, under
// workers/shared/bench-data.js's benchBlobKey), never from
// storage_ref directly, which for an upload is an internal R2 key, not a URL.
function documentGuestHref(d) {
  return `${PREFIX}documents/${d.id}/file`;
}

function renderPortal(documents, notes, entries, evidenceHtml = "", number = null) {
  return benchPage(
    number == null ? "Bench Notes — Entrusted access" : `Bench Note ${noteNumber(number)}`,
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>${number == null ? "Bench Notes" : `Bench Note ${noteNumber(number)}`}<span class="tag">Entrusted access</span></h1></header>
${renderEntrustedView(documents, notes, entries, { documentHref: documentGuestHref })}
${evidenceHtml}
<div class="ticker"></div>
<form method="post" action="${PREFIX}logout"><button type="submit">Sign out</button></form>`,
  );
}

const parseJson = (value, fallback = {}) => { try { return JSON.parse(value) || fallback; } catch { return fallback; } };
const evidenceHref = (entryId, intakeId, hash) => `${PREFIX}evidence/${encodeURIComponent(entryId)}/${encodeURIComponent(intakeId)}/${encodeURIComponent(hash)}`;

function renderSharedIntake(entryId, record) {
  const { intake, parts, derivations } = record;
  const recovered=parseJson(intake.metadata_json).source_kind==='recovered_file';
  const original = evidenceHref(entryId, intake.id, intake.original_artifact_id);
  const attachments = parts.map(part => {
    const href = evidenceHref(entryId, intake.id, part.artifact_id);
    const derived = derivations.filter(d => d.artifact_id === part.artifact_id).map(d => {
      const provenance = parseJson(d.provenance_json);
      const body = d.kind === "transcript"
        ? renderEvidenceTranscript({ text: d.text_content, source: "auto", segments: (Array.isArray(provenance.segments) ? provenance.segments : []).map(segment => ({speaker: segment.speaker, timestamp: segment.start == null ? null : `${segment.start}s`, text: segment.text})) })
        : renderEvidenceText(d.text_content);
      return `<section><h3>${d.kind === "transcript" ? "Derived transcript" : "Derived text"}</h3><p class="hint">${escapeHtml(d.method)} · ${escapeHtml(d.version)}${provenance.ocr_status ? ` · ${escapeHtml(provenance.ocr_status)}` : ""}</p>${body}<details><summary>Source and derivation</summary><p>SHA-256 ${escapeHtml(part.sha256)}</p>${renderEvidenceText(JSON.stringify(provenance, null, 2))}</details></section>`;
    }).join("\n");
    const media = /^audio\//.test(part.mime_type)
      ? renderEvidenceAudio({ href, title: part.filename })
      : /^image\/(png|jpeg|webp|gif)$/.test(part.mime_type) ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(part.filename)}" style="max-width:100%;height:auto">` : "";
    return `<article class="card"><h3>${escapeHtml(part.filename)}</h3><p>${escapeHtml(part.mime_type)} · ${escapeHtml(part.byte_size)} bytes · ${escapeHtml(part.state)}</p><p><a href="${escapeHtml(href)}">Open original</a> · <a href="${escapeHtml(href)}?download=1">Download original</a></p>${media}${derived || "<p>Derived text is unavailable; the preserved original remains available.</p>"}</article>`;
  }).join("\n");
  return `<section class="shared-intake"><h2>${recovered?'Recovered source evidence':'Shared evidence intake'}</h2><p>${escapeHtml(intake.subject || "Email")}</p><dl>${recovered?'<dt>Source</dt><dd>Recovered uploaded file</dd>':`<dt>From</dt><dd>${escapeHtml(intake.envelope_from)}</dd>`}<dt>Received</dt><dd>${escapeHtml(intake.received_at)}</dd><dt>Source message date</dt><dd>${escapeHtml(intake.sent_at || "Unknown")}</dd></dl><p><a href="${escapeHtml(original)}">${recovered?'Download recovered source file':'Download original email'}</a></p><h3>${recovered?'Recovery record':'Email communication'}</h3>${renderEvidenceText(intake.body_text || "The preserved original contains the communication.")}${attachments}</section>`;
}

async function renderLinkedIntakes(env, entryId) {
  const { results } = await env.BENCH_NOTES.prepare("SELECT intake_id FROM evidence_note_links WHERE entry_id = ? AND shared_at IS NOT NULL").bind(entryId).all();
  const sections = [];
  for (const link of results) {
    const record = await getEvidence(env, link.intake_id);
    if (record) sections.push(renderSharedIntake(entryId, record));
  }
  return sections.join("\n");
}

async function handleSharedEvidenceFile(request, env, match) {
  const session = await verifySession(readCookie(request, COOKIE_NAME), env.ENTRUSTED_COOKIE_SECRET);
  if (!session) return notFound();
  const grant = await getGrant(env, session.gid);
  const entry = await getSharedEntryForGrant(env, grant, match[1]);
  if (!entry) return notFound();
  const link = await env.BENCH_NOTES.prepare("SELECT intake_id FROM evidence_note_links WHERE entry_id = ? AND intake_id = ? AND shared_at IS NOT NULL").bind(entry.id, match[2]).first();
  if (!link) return notFound();
  const record = await getEvidence(env, link.intake_id);
  if (!record) return notFound();
  const part = record.parts.find(p => p.artifact_id === match[3]);
  const email = record.intake.original_artifact_id === match[3] && parseJson(record.intake.metadata_json).source_kind !== 'recovered_file';
  if (!email && !part) return notFound();
  const artifact = await env.BENCH_NOTES.prepare("SELECT * FROM evidence_artifacts WHERE id = ?").bind(match[3]).first();
  if (!artifact) return notFound();
  return evidenceFileResponse(request, env, artifact, { mimeType: email ? "message/rfc822" : part.mime_type, filename: email ? "original.eml" : part.filename });
}

// --- Routing ---

// Independently re-derives the exact same shared/scoped document list
// listSharedDocuments already gives the rest of this page, rather than a
// second, hand-written query — the file route gets the identical
// confidentiality guarantee, not a parallel one that could drift from it.
async function findServableDocument(env, session, docId) {
  const grant = await getGrant(env, session.gid);
  if (!grant || grant.revoked_at) return null;
  const caseIds = JSON.parse(grant.case_ids_json || "[]");
  const documents = await listSharedDocuments(env.BENCH_NOTES, caseIds);
  return documents.find((d) => d.id === docId) || null;
}

export async function handleBenchEntrustedGet(request, env, url) {
  const path = url.pathname.slice(PREFIX.length);

  if (path === "stenotype.jpg") {
    const object = await env.BENCH_DOCUMENTS.get("bench/identity/stenotype-approved.jpg");
    if (!object) return notFound();
    return new Response(object.body, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=31536000, immutable",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  if (path === "preview.svg") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="447" height="447" viewBox="0 0 447 447"><rect width="447" height="447" fill="white"/><image href="/entrusted/stenotype.jpg?v=20261004-3" x="0" y="0" width="447" height="447" preserveAspectRatio="xMidYMid meet"/></svg>`;
    return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400, immutable", "x-robots-tag": "noindex, nofollow" } });
  }
  const evidenceMatch = path.match(/^evidence\/([^/]+)\/([^/]+)\/([a-f0-9]{64})$/);
  if (evidenceMatch) return handleSharedEvidenceFile(request, env, evidenceMatch);
  const fileMatch = path.match(/^documents\/([^/]+)\/file$/);
  if (fileMatch) {
    const token = readCookie(request, COOKIE_NAME);
    const session = await verifySession(token, env.ENTRUSTED_COOKIE_SECRET);
    if (!session) return notFound();
    const doc = await findServableDocument(env, session, fileMatch[1]);
    if (!doc || doc.storage_kind !== "upload") return notFound();
    const object = await env.BENCH_DOCUMENTS.get(doc.storage_ref);
    if (!object) return notFound();
    const size = object.size ?? (await object.arrayBuffer()).byteLength;
    return evidenceFileResponse(request, env, { object_key: doc.storage_ref, byte_size: size }, { mimeType: object.httpMetadata?.contentType || "application/octet-stream", filename: doc.title });
  }

  const noteLink = path.match(/^([^/]+)(?:\/note\/([^/]+))?$/);
  if (noteLink) {
    const grant = await getGrant(env, noteLink[1]);
    if (!grant || grant.revoked_at) return notFound();
    const entry = noteLink[2]
      ? await getSharedEntryForGrant(env, grant, noteLink[2])
      : await getLatestSharedEntryForGrant(env, grant);
    if (!entry) return notFound();

    // Legacy grant-only links become durable aliases for the newest shared
    // note in that grant, so links already handed out continue to work.
    if (!noteLink[2]) {
      return Response.redirect(`https://${url.host}${PREFIX}${grant.id}/note/${entry.id}`, 302);
    }

    const token = readCookie(request, COOKIE_NAME);
    const session = await verifySession(token, env.ENTRUSTED_COOKIE_SECRET);
    if (!session || session.gid !== grant.id) return html(renderEnvelope(grant, entry));

    const caseIds = JSON.parse(grant.case_ids_json || "[]");
    const [documents, entries, evidenceHtml] = await Promise.all([
      listSharedDocuments(env.BENCH_NOTES, caseIds),
      listSharedEntries(env.BENCH_NOTES, caseIds),
      renderLinkedIntakes(env, entry.id),
    ]);
    return html(renderPortal(documents.filter(d => d.entry_id === entry.id), [], entries.filter(e => e.id === entry.id), evidenceHtml, entry.share_number));
  }

  if (path !== "") return notFound();

  const token = readCookie(request, COOKIE_NAME);
  const session = await verifySession(token, env.ENTRUSTED_COOKIE_SECRET);
  if (!session) return html(renderLogin());

  const grant = await getGrant(env, session.gid);
  if (!grant || grant.revoked_at) {
    return new Response(renderLogin("Your access has been revoked."), {
      status: 200,
      headers: { ...headers("text/html; charset=utf-8"), "set-cookie": setCookieHeader("", 0) },
    });
  }

  const caseIds = JSON.parse(grant.case_ids_json || "[]");
  const [documents, notes, entries] = await Promise.all([
    listSharedDocuments(env.BENCH_NOTES, caseIds),
    listNotesForCases(env.BENCH_NOTES, caseIds),
    listSharedEntries(env.BENCH_NOTES, caseIds),
  ]);
  return html(renderPortal(documents, notes, entries));
}

export async function handleBenchEntrustedPost(request, env, url) {
  const path = url.pathname.slice(PREFIX.length);

  const noteLogin = path.match(/^([^/]+)\/note\/([^/]+)\/login$/);
  if (noteLogin) {
    const grant = await getGrant(env, noteLogin[1]);
    const entry = await getSharedEntryForGrant(env, grant, noteLogin[2]);
    if (!grant || !entry) return notFound();
    const form = await request.formData();
    const passphrase = form.get("passphrase");
    if (!passphrase) return html(renderEnvelope(grant, entry, "Enter a passphrase."), 400);
    const matchedGrant = await findActiveGrantByCodeHash(env, await sha256Hex(passphrase));
    if (!matchedGrant || matchedGrant.id !== grant.id) {
      return html(renderEnvelope(grant, entry, "That passphrase isn't recognized."), 401);
    }
    const token = await signSession({ gid: grant.id }, env.ENTRUSTED_COOKIE_SECRET, SESSION_TTL_SECONDS);
    return new Response(null, {
      status: 303,
      headers: {
        location: `https://${url.host}${PREFIX}${grant.id}/note/${entry.id}`,
        "set-cookie": setCookieHeader(token, SESSION_TTL_SECONDS),
      },
    });
  }

  if (path === "login") {
    const form = await request.formData();
    const passphrase = form.get("passphrase");
    if (!passphrase) return html(renderLogin("Enter a passphrase."), 400);
    const grant = await findActiveGrantByCodeHash(env, await sha256Hex(passphrase));
    if (!grant) return html(renderLogin("That passphrase isn't recognized."), 401);
    const token = await signSession({ gid: grant.id }, env.ENTRUSTED_COOKIE_SECRET, SESSION_TTL_SECONDS);
    return new Response(null, {
      status: 303,
      headers: { location: `${url.origin}${PREFIX}`, "set-cookie": setCookieHeader(token, SESSION_TTL_SECONDS) },
    });
  }

  if (path === "logout") {
    return new Response(null, {
      status: 303,
      headers: { location: `${url.origin}${PREFIX}`, "set-cookie": setCookieHeader("", 0) },
    });
  }

  return notFound();
}

export const _internal = { renderLogin, renderPortal };
