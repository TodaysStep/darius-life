// confidential.darius.life/entrusted/* — Bench Notes entrusted side (the section for everybody else; the working side, /bench/*, is Darius's own). Documents and
// shared timeline entries, manually shared, one universal passphrase per
// grant, revocable. This is a SIBLING path to /bench/*, not a subpath of it,
// on the same hostname and Worker as the working side. This module never queries cases, patterns, or
// glossary_terms at all, and its only access to docket_entries is through
// listSharedEntries in workers/shared/bench-entrusted-view.js — a single
// hardcoded query that can only ever return fact/entry_date for entries
// Darius has explicitly shared, never recommended_direction, commentary, or
// court_takeaways. The rendering itself (renderEntrustedView) is the exact
// same function the working side's preview calls, so a preview can never
// drift from what a real guest sees. There is no Cloudflare Access gate
// here: guests have no Access identity, so this module is its own complete
// authentication boundary.
import { escapeHtml, headers, benchPage, STENOTYPE_ICON } from "../../shared/bench-style.js";
import { sha256Hex, signSession, verifySession } from "../../shared/bench-crypto.js";
import { listSharedDocuments, listNotesForCases, listSharedEntries, renderEntrustedView } from "../../shared/bench-entrusted-view.js";

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

// --- D1 access — access_grants is the only table this file itself ever
// queries; documents/entrusted_notes/docket_entries all go through the
// shared, hardcoded query functions imported above. ---

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
<form method="post" action="${PREFIX}${grant.id}/note/${entry.id}/login">
<label for="passphrase">Enter passphrase</label>
<input type="password" id="passphrase" name="passphrase" autocomplete="current-password" required autofocus>
<input type="submit" class="entrusted-submit" value="Open Bench Note →" formmethod="post">
</form>
<div class="envelope-seal">Private record · Authorized access only</div>
</main>`
  );
  const title = `${label} · Confidential Access`;
  const meta = `
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="Confidential access · darius.life">
<meta property="og:type" content="website">
<meta property="og:image" content="https://confidential.darius.life/entrusted/stenotype.jpg?v=20261004-3">
<meta property="og:image:type" content="image/jpeg">\n<meta property="og:image:width" content="447">
<meta property="og:image:height" content="447">
<meta property="og:image:alt" content="Stenotype machine on a white field">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="Confidential access · darius.life">
<meta name="twitter:image" content="https://confidential.darius.life/entrusted/stenotype.jpg?v=20261004-3">`;
  page = page.replace(/<title>[^<]*<\\/title>/, `<title>${escapeHtml(title)}</title>`);
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
// binding (PRIVATE_LEGAL — the same bucket the working side uses, under
// workers/shared/bench-data.js's benchBlobKey), never from
// storage_ref directly, which for an upload is an internal R2 key, not a URL.
function documentGuestHref(d) {
  return `${PREFIX}documents/${d.id}/file`;
}

function renderPortal(documents, notes, entries) {
  return benchPage(
    "Bench Notes — Entrusted access",
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>Bench Notes<span class="tag">Entrusted access</span></h1></header>
${renderEntrustedView(documents, notes, entries, { documentHref: documentGuestHref })}
<div class="ticker"></div>
<form method="post" action="${PREFIX}logout"><button type="submit">Sign out</button></form>`,
  );
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

  if (path === "preview.svg") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920"><rect width="1080" height="1920" fill="white"/><image href="https://darius.life/assets/bench/stenotype.jpg" x="150" y="430" width="780" height="780" preserveAspectRatio="xMidYMid meet"/></svg>`;
    return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400, immutable", "x-robots-tag": "noindex, nofollow" } });
  }
  const fileMatch = path.match(/^documents\/([^/]+)\/file$/);
  if (fileMatch) {
    const token = readCookie(request, COOKIE_NAME);
    const session = await verifySession(token, env.ENTRUSTED_COOKIE_SECRET);
    if (!session) return notFound();
    const doc = await findServableDocument(env, session, fileMatch[1]);
    if (!doc || doc.storage_kind !== "upload") return notFound();
    const object = await env.BENCH_DOCUMENTS.get(doc.storage_ref);
    if (!object) return notFound();
    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType || "application/octet-stream",
        "content-disposition": `inline; filename="${doc.title.replace(/"/g, "")}"`,
        "cache-control": "private, no-store",
      },
    });
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
    const [documents, notes, entries] = await Promise.all([
      listSharedDocuments(env.BENCH_NOTES, caseIds),
      listNotesForCases(env.BENCH_NOTES, caseIds),
      listSharedEntries(env.BENCH_NOTES, caseIds),
    ]);
    return html(renderPortal(documents, notes, entries));
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
      headers: { location: `https://darius.life${PREFIX}`, "set-cookie": setCookieHeader(token, SESSION_TTL_SECONDS) },
    });
  }

  if (path === "logout") {
    return new Response(null, {
      status: 303,
      headers: { location: `https://darius.life${PREFIX}`, "set-cookie": setCookieHeader("", 0) },
    });
  }

  return notFound();
}

export const _internal = { renderLogin, renderPortal };
