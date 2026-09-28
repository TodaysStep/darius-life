// darius.life/bench-entrusted/* — Bench Notes entrusted side. Documents-only,
// manually shared, one universal passphrase per grant, revocable. This is a
// SIBLING path to /bench/*, not a subpath of it (see wrangler.toml), and this
// module is deliberately isolated: it has no import of, and no query against,
// cases, docket_entries, patterns, or glossary_terms — the working side's
// confidential tables. The only tables it ever touches are access_grants
// (to check a passphrase and confirm it hasn't been revoked), documents, and
// entrusted_notes — both of the latter only rows Darius has explicitly
// shared. There is no Cloudflare Access gate here: guests have no Access
// identity, so this module is its own complete authentication boundary.
import { escapeHtml, headers, benchPage, STENOTYPE_ICON } from "./bench-style.js";
import { sha256Hex, signSession, verifySession } from "./bench-crypto.js";

export const PREFIX = "/bench-entrusted/";
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

// --- D1 access — the only functions in this file, and the only tables this
// whole module is allowed to know about: access_grants, documents, entrusted_notes ---

async function getGrant(env, id) {
  return env.BENCH_NOTES.prepare("SELECT * FROM access_grants WHERE id = ?").bind(id).first();
}

async function findActiveGrantByCodeHash(env, codeHash) {
  return env.BENCH_NOTES.prepare("SELECT * FROM access_grants WHERE code_hash = ? AND revoked_at IS NULL").bind(codeHash).first();
}

async function listSharedDocuments(env, caseIds) {
  if (caseIds.length === 0) return [];
  const placeholders = caseIds.map(() => "?").join(",");
  const { results } = await env.BENCH_NOTES.prepare(
    `SELECT * FROM documents WHERE shared_at IS NOT NULL AND case_id IN (${placeholders}) ORDER BY case_label, created_at DESC`,
  ).bind(...caseIds).all();
  return results;
}

async function listNotesForCases(env, caseIds) {
  if (caseIds.length === 0) return [];
  const placeholders = caseIds.map(() => "?").join(",");
  const { results } = await env.BENCH_NOTES.prepare(
    `SELECT * FROM entrusted_notes WHERE case_id IN (${placeholders}) ORDER BY created_at DESC`,
  ).bind(...caseIds).all();
  return results;
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

function groupByCaseLabel(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.case_label)) groups.set(row.case_label, []);
    groups.get(row.case_label).push(row);
  }
  return groups;
}

function renderPortal(documents, notes) {
  const docGroups = groupByCaseLabel(documents);
  const noteGroups = groupByCaseLabel(notes);
  const caseLabels = [...new Set([...docGroups.keys(), ...noteGroups.keys()])].sort();

  const sections = caseLabels.length
    ? caseLabels
        .map((label) => {
          const docs = docGroups.get(label) || [];
          const theseNotes = noteGroups.get(label) || [];
          const docRows = docs.length
            ? docs.map((d) => `<div class="case-row"><a href="${escapeHtml(d.storage_ref)}">${escapeHtml(d.title)}</a>${d.filed_date ? `<span class="status">${escapeHtml(d.filed_date)}</span>` : ""}</div>`).join("\n")
            : `<p class="hint">No documents shared yet.</p>`;
          const noteRows = theseNotes.map((n) => `<div class="card"><span class="entry-date">${escapeHtml(n.created_at)}</span><div>${escapeHtml(n.body)}</div></div>`).join("\n");
          return `<h2>${escapeHtml(label)}</h2>\n${docRows}\n${noteRows}`;
        })
        .join("\n<div class=\"ticker\"></div>\n")
    : `<p class="hint">Nothing has been shared with you yet.</p>`;

  return benchPage(
    "Bench Notes — Entrusted access",
    `<header class="bench-header">${STENOTYPE_ICON()}<h1>Bench Notes<span class="tag">Entrusted access</span></h1></header>
${sections}
<div class="ticker"></div>
<form method="post" action="${PREFIX}logout"><button type="submit">Sign out</button></form>`,
  );
}

// --- Routing ---

export async function handleBenchEntrustedGet(request, env, url) {
  const path = url.pathname.slice(PREFIX.length);
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
  const [documents, notes] = await Promise.all([listSharedDocuments(env, caseIds), listNotesForCases(env, caseIds)]);
  return html(renderPortal(documents, notes));
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

export const _internal = { renderLogin, renderPortal, groupByCaseLabel };
