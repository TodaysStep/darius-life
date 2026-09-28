// darius.life/bench/api/* — Bench Notes' machine API. The one write surface
// meant for a server-to-server caller (the PosterityOS Founder Command
// Center / publishing desk, or any future automation) rather than a human
// with a browser. It lives on THIS Worker, not the confidential one,
// specifically because the confidential Worker's entire origin is behind
// Cloudflare Access — a server-to-server Bearer-token call has no browser
// session and would never get past that gate. This route is instead its own
// complete auth boundary (a bearer secret, BENCH_API_KEY, checked below),
// the same shape as bench-entrusted.js's passphrase — never the Cloudflare
// Access application, which this file never touches.
//
// Every operation here calls the exact same functions
// (workers/shared/bench-data.js) that the human-facing working-side UI
// (workers/confidential/src/bench-working.js) calls — so a case, entry, or
// document published through this API is immediately the same row the UI
// reads, not a second copy anywhere.
import * as data from "../../shared/bench-data.js";
import { sha256Hex } from "../../shared/bench-crypto.js";

export const PREFIX = "/bench/api/";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
const okEmpty = () => json({ ok: true });
const notFound = () => json({ error: "not_found" }, 404);
const badRequest = (message) => json({ error: "bad_request", message }, 400);
const unauthorized = () => json({ error: "unauthorized" }, 401);

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireApiKey(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer (.+)$/);
  if (!match || !env.BENCH_API_KEY) return false;
  return timingSafeEqual(match[1], env.BENCH_API_KEY);
}

async function caseDetailPayload(db, caseRow) {
  const [entries, documents, notes, glossary, patterns] = await Promise.all([
    data.listEntries(db, caseRow.id),
    data.listDocuments(db, caseRow.id),
    data.listEntrustedNotes(db, caseRow.id),
    data.listGlossary(db, caseRow.id),
    data.listPatterns(db, caseRow.id),
  ]);
  return { case: caseRow, entries, documents, notes, glossary, patterns };
}

export async function handleBenchApi(request, env, url) {
  if (!requireApiKey(request, env)) return unauthorized();

  const db = env.BENCH_NOTES;
  const path = url.pathname.slice(PREFIX.length);
  const method = request.method;
  let body = {};
  if (method === "POST" || method === "PATCH") {
    try {
      body = await request.json();
    } catch {
      return badRequest("Body must be valid JSON.");
    }
  }

  try {
    if (path === "cases" && method === "GET") return json({ cases: await data.listCases(db) });

    if (path === "cases" && method === "POST") {
      if (!body.title) return badRequest("title is required.");
      const id = crypto.randomUUID();
      await data.createCase(db, { id, title: body.title, court: body.court, caseNumber: body.caseNumber });
      return json({ id }, 201);
    }

    const caseMatch = path.match(/^cases\/([^/]+)$/);
    if (caseMatch && method === "GET") {
      const caseRow = await data.getCase(db, caseMatch[1]);
      if (!caseRow) return notFound();
      return json(await caseDetailPayload(db, caseRow));
    }

    const entriesMatch = path.match(/^cases\/([^/]+)\/entries$/);
    if (entriesMatch && method === "POST") {
      const caseRow = await data.getCase(db, entriesMatch[1]);
      if (!caseRow) return notFound();
      if (!body.entryDate || !body.fact) return badRequest("entryDate and fact are required.");
      const id = crypto.randomUUID();
      await data.addEntry(db, {
        id, caseId: caseRow.id, caseLabel: caseRow.title, entryDate: body.entryDate, fact: body.fact,
        recommendedDirection: body.recommendedDirection, commentary: body.commentary, courtTakeaways: body.courtTakeaways,
        entryKind: body.entryKind,
      });
      return json({ id }, 201);
    }

    const entryMatch = path.match(/^entries\/([^/]+)$/);
    if (entryMatch && method === "PATCH") {
      const entry = await data.getEntry(db, entryMatch[1]);
      if (!entry) return notFound();
      await data.updateEntry(db, entry.id, {
        fact: body.fact ?? entry.fact,
        recommendedDirection: body.recommendedDirection ?? entry.recommended_direction,
        commentary: body.commentary ?? entry.commentary,
        courtTakeaways: body.courtTakeaways ?? entry.court_takeaways,
        entryKind: body.entryKind ?? entry.entry_kind,
      });
      return okEmpty();
    }

    const entryShareMatch = path.match(/^entries\/([^/]+)\/(share|unshare)$/);
    if (entryShareMatch && method === "POST") {
      const entry = await data.getEntry(db, entryShareMatch[1]);
      if (!entry) return notFound();
      await data.setEntryShared(db, entry.id, entryShareMatch[2] === "share");
      return okEmpty();
    }

    const documentsMatch = path.match(/^cases\/([^/]+)\/documents$/);
    if (documentsMatch && method === "POST") {
      const caseRow = await data.getCase(db, documentsMatch[1]);
      if (!caseRow) return notFound();
      if (!body.title || !body.storageRef) return badRequest("title and storageRef are required.");
      if (!data.isPublishableStorageRef(body.storageRef)) return badRequest("storageRef must be an http(s) address.");
      const id = crypto.randomUUID();
      await data.addDocument(db, {
        id, caseId: caseRow.id, caseLabel: caseRow.title, entryId: body.entryId,
        title: body.title, storageRef: body.storageRef, filedDate: body.filedDate,
      });
      return json({ id }, 201);
    }

    const documentShareMatch = path.match(/^documents\/([^/]+)\/(share|unshare)$/);
    if (documentShareMatch && method === "POST") {
      const doc = await data.getDocument(db, documentShareMatch[1]);
      if (!doc) return notFound();
      await data.setDocumentShared(db, doc.id, documentShareMatch[2] === "share");
      return okEmpty();
    }

    const notesMatch = path.match(/^cases\/([^/]+)\/notes$/);
    if (notesMatch && method === "POST") {
      const caseRow = await data.getCase(db, notesMatch[1]);
      if (!caseRow) return notFound();
      if (!body.body) return badRequest("body is required.");
      const id = crypto.randomUUID();
      await data.addEntrustedNote(db, { id, caseId: caseRow.id, caseLabel: caseRow.title, body: body.body });
      return json({ id }, 201);
    }

    if (path === "grants" && method === "GET") return json({ grants: await data.listGrants(db) });

    if (path === "grants" && method === "POST") {
      if (!body.passphrase || body.passphrase.length < 6) return badRequest("passphrase must be at least 6 characters.");
      if (!Array.isArray(body.caseIds) || body.caseIds.length === 0) return badRequest("caseIds must be a non-empty array.");
      const id = crypto.randomUUID();
      await data.createGrant(db, { id, codeHash: await sha256Hex(body.passphrase), caseIds: body.caseIds, label: body.label });
      return json({ id }, 201);
    }

    const revokeMatch = path.match(/^grants\/([^/]+)\/revoke$/);
    if (revokeMatch && method === "POST") {
      if (!(await data.getGrant(db, revokeMatch[1]))) return notFound();
      await data.revokeGrant(db, revokeMatch[1]);
      return okEmpty();
    }

    const passphraseMatch = path.match(/^grants\/([^/]+)\/passphrase$/);
    if (passphraseMatch && method === "POST") {
      if (!(await data.getGrant(db, passphraseMatch[1]))) return notFound();
      if (!body.newPassphrase || body.newPassphrase.length < 6) return badRequest("newPassphrase must be at least 6 characters.");
      await data.updateGrantPassphrase(db, passphraseMatch[1], await sha256Hex(body.newPassphrase));
      return okEmpty();
    }

    return notFound();
  } catch (e) {
    // Never echo the raw exception back to the caller — a D1/SQLite error can
    // name tables, columns or constraints. The full message still goes to
    // Cloudflare's own Worker logs (console.error), just not to the response.
    console.error("bench-api internal error:", e);
    return json({ error: "internal_error" }, 500);
  }
}

export const _internal = { requireApiKey, timingSafeEqual };
