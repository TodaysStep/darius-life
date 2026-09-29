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

// --- Rendering ---

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

  const fileMatch = path.match(/^documents\/([^/]+)\/file$/);
  if (fileMatch) {
    const token = readCookie(request, COOKIE_NAME);
    const session = await verifySession(token, env.ENTRUSTED_COOKIE_SECRET);
    if (!session) return notFound();
    const doc = await findServableDocument(env, session, fileMatch[1]);
    if (!doc || doc.storage_kind !== "upload") return notFound();
    const object = await env.PRIVATE_LEGAL.get(doc.storage_ref);
    if (!object) return notFound();
    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType || "application/octet-stream",
        "content-disposition": `inline; filename="${doc.title.replace(/"/g, "")}"`,
        "cache-control": "private, no-store",
      },
    });
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
