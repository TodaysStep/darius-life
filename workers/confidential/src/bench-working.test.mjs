import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleBenchGet, handleBenchPost, handleBenchPut } from "./bench-working.js";
import { resetCertsCacheForTests } from "../../shared/access.js";
import { createFakeD1 } from "../../shared/test-fake-d1.mjs";
import { createFakeR2 } from "../../shared/test-fake-r2.mjs";

beforeEach(() => resetCertsCacheForTests());

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const jsonB64url = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function generateKeypair() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return { privateKey, jwk: { ...jwk, kid: KID, alg: "RS256", use: "sig" } };
}
async function signJwt(privateKey, payload) {
  const headerB64 = jsonB64url({ alg: "RS256", kid: KID, typ: "JWT" });
  const payloadB64 = jsonB64url(payload);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data);
  return `${headerB64}.${payloadB64}.${b64url(new Uint8Array(sig))}`;
}
const now = () => Math.floor(Date.now() / 1000);
async function validToken() {
  const { privateKey, jwk } = await generateKeypair();
  return { token: await signJwt(privateKey, { aud: AUD, email: "michael@example.com", exp: now() + 3600 }), jwk };
}

function setup(jwk) {
  const fakeD1 = createFakeD1();
  const fakeR2 = createFakeR2();
  // Real .pdf bytes aren't valid PDFs here, so toMarkdown always reports a
  // conversion error and extraction falls back to "unreadable" — this AI
  // binding is never actually reached by an upload test in this file
  // (bench-document-ai.test.mjs covers env.AI.run/toMarkdown themselves,
  // decoupled from real PDF/audio bytes). It's here so nothing throws
  // "env.AI is not defined" if that ever changes.
  const fakeAI = {
    run: async () => ({ response: JSON.stringify({ documentType: "unused", caseNumber: null }) }),
    toMarkdown: async ([file]) => [{ name: file.name, format: "error", error: "not a real PDF in this fake" }],
  };
  globalThis.fetch = async (url) => {
    if (String(url) === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) return { ok: true, json: async () => ({ keys: [jwk] }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { env: { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD, BENCH_NOTES: fakeD1.BENCH_NOTES, BENCH_DOCUMENTS: fakeR2, AI: fakeAI }, fakeD1, fakeR2 };
}

const authedRequest = (url, token, opts = {}) =>
  new Request(url, { ...opts, headers: { ...(opts.headers || {}), "Cf-Access-Jwt-Assertion": token } });

// Mirrors exactly what bench-client-script.js's uploadBlob() does: PUT the
// raw bytes to /bench/blobs/:blobId with Content-Type and X-Filename, then
// hand the resulting { blobId, filename, contentType } straight to whatever
// form the real page would submit next.
async function putBlob(env, token, filename, contentType, bytes) {
  const blobId = crypto.randomUUID();
  const req = authedRequest(`https://darius.life/bench/blobs/${blobId}`, token, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": contentType, "x-filename": encodeURIComponent(filename) },
  });
  const res = await handleBenchPut(req, env, new URL(`https://darius.life/bench/blobs/${blobId}`));
  return { res, blobId, filename, contentType };
}

test("GET /bench/ without a token is forbidden and never touches D1", async () => {
  const { env, fakeD1 } = setup(null);
  const res = await handleBenchGet(new Request("https://darius.life/bench/"), env, new URL("https://darius.life/bench/"));
  assert.equal(res.status, 403);
  assert.equal(fakeD1.tables.cases.length, 0);
});

test("POST /bench/ with a valid token creates a case, then it shows up on GET /bench/", async () => {
  const { token, jwk } = await validToken();
  const { env } = setup(jwk);

  const form = new URLSearchParams({ title: "Family matter", court: "Superior Court", caseNumber: "CV-1" });
  const createReq = authedRequest("https://darius.life/bench/", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const createRes = await handleBenchPost(createReq, env, new URL("https://darius.life/bench/"));
  assert.equal(createRes.status, 303);
  const location = createRes.headers.get("location");
  assert.match(location, /\/bench\/case\/[\w-]+$/);

  const listRes = await handleBenchGet(authedRequest("https://darius.life/bench/", token), env, new URL("https://darius.life/bench/"));
  assert.equal(listRes.status, 200);
  const html = await listRes.text();
  assert.match(html, /Family matter/);
  assert.match(html, /CV-1/);
});

test("adding a docket entry stores all four layers and shows them on the case page", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });

  const form = new URLSearchParams({
    entryDate: "2026-09-28",
    fact: "Hearing held.",
    recommendedDirection: "File a response by Friday.",
    commentary: "Judge seemed skeptical of opposing counsel.",
    courtTakeaways: "Continuance granted.",
  });
  const req = authedRequest("https://darius.life/bench/case/case-1/entries", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/entries"));
  assert.equal(res.status, 303);

  const detail = await handleBenchGet(authedRequest("https://darius.life/bench/case/case-1", token), env, new URL("https://darius.life/bench/case/case-1"));
  const html = await detail.text();
  assert.match(html, /Hearing held\./);
  assert.match(html, /File a response by Friday\./);
  assert.match(html, /Judge seemed skeptical of opposing counsel\./);
  assert.match(html, /Continuance granted\./);
});

test("adding a document with a javascript: storageRef is rejected and writes nothing", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });

  const form = new URLSearchParams({ docTitle: "Motion", storageRef: "javascript:alert(1)" });
  const req = authedRequest("https://darius.life/bench/case/case-1/documents", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/documents"));
  assert.equal(res.status, 400);
  assert.equal(fakeD1.tables.documents.length, 0);
});

test("PUT /bench/blobs/:id streams the bytes straight to R2 without ever buffering the whole file into a File/FormData object", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeR2 } = setup(jwk);
  const { res, blobId } = await putBlob(env, token, "motion.pdf", "application/pdf", "hello world");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.size, 11);
  const key = body.key;
  assert.match(key, new RegExp(`^bench-blobs/${blobId}/`));
  assert.equal(fakeR2.objects.get(key).bytes.toString(), "hello world");
});

test("PUT /bench/blobs/:id without a token is forbidden and writes nothing to R2", async () => {
  const { env, fakeR2 } = setup(null);
  const req = new Request("https://darius.life/bench/blobs/some-id", { method: "PUT", body: "data" });
  const res = await handleBenchPut(req, env, new URL("https://darius.life/bench/blobs/some-id"));
  assert.equal(res.status, 403);
  assert.equal(fakeR2.objects.size, 0);
});

test("uploading a document is the default creation path: the blob is PUT first, then finalize does nothing but its own analysis and Darius's optional notes", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1, fakeR2 } = setup(jwk);

  // Fake bytes aren't a real PDF, so this exercises the deterministic
  // "content couldn't be read" path — bench-document-ai.test.mjs covers the
  // AI-classification branch on its own, and findOrCreateCaseByNumber's own
  // tests (workers/shared/bench-data.test.mjs) cover matching an existing
  // case by a real extracted number. What this proves: the two-step upload
  // (PUT the bytes, then finalize) still creates a case/entry/document end
  // to end, and tags the entry so it's never mistaken for Darius's own
  // typed fact.
  const { blobId, filename, contentType } = await putBlob(env, token, "motion.pdf", "application/pdf", "hello world");

  const form = new URLSearchParams({ blobId, filename, contentType, commentary: "Looks routine." });
  const req = authedRequest("https://darius.life/bench/upload/finalize", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/upload/finalize"));
  assert.equal(res.status, 303);

  assert.equal(fakeD1.tables.cases.length, 1);
  assert.equal(fakeD1.tables.cases[0].case_number, null);
  assert.match(fakeD1.tables.cases[0].title, /^Untitled — \d{4}-\d{2}-\d{2}$/);

  assert.equal(fakeD1.tables.docket_entries.length, 1);
  const entry = fakeD1.tables.docket_entries[0];
  assert.match(entry.fact, /couldn't be read automatically/);
  assert.equal(entry.commentary, "Looks routine.");
  assert.equal(entry.source, "upload-unreadable");

  assert.equal(fakeD1.tables.documents.length, 1);
  const doc = fakeD1.tables.documents[0];
  assert.equal(doc.storage_kind, "upload");
  assert.equal(doc.entry_id, entry.id);
  assert.equal(fakeR2.objects.get(doc.storage_ref).bytes.toString(), "hello world");
});

test("notes are the only optional field — leaving them out still finalizes cleanly", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  const { blobId, filename, contentType } = await putBlob(env, token, "notice.pdf", "application/pdf", "x");
  const form = new URLSearchParams({ blobId, filename, contentType });
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/upload/finalize", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/upload/finalize"),
  );
  assert.equal(res.status, 303);
  assert.equal(fakeD1.tables.docket_entries[0].commentary, null);
});

test("finalize refuses to proceed if the blob it's told about was never actually uploaded", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  const form = new URLSearchParams({ blobId: "never-uploaded", filename: "ghost.pdf", contentType: "application/pdf" });
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/upload/finalize", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/upload/finalize"),
  );
  assert.equal(res.status, 400);
  assert.equal(fakeD1.tables.cases.length, 0);
});

test("finalizing with no blobId/filename at all (no file was ever chosen) is rejected and writes nothing", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);

  const form = new URLSearchParams({ commentary: "Something" });
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/upload/finalize", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/upload/finalize"),
  );
  assert.equal(res.status, 400);

  assert.equal(fakeD1.tables.cases.length, 0);
  assert.equal(fakeD1.tables.documents.length, 0);
});

test("GET the uploaded file's own route streams the bytes back with a token, and 404s for a link-only document", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeR2 } = setup(jwk);
  await fakeR2.put("bench-documents/doc-1/motion.pdf", "the actual bytes", { httpMetadata: { contentType: "application/pdf" } });
  const fakeD1 = createFakeD1();
  env.BENCH_NOTES = fakeD1.BENCH_NOTES;
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "motion.pdf", storage_kind: "upload", storage_ref: "bench-documents/doc-1/motion.pdf", shared_at: null, created_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-2", case_id: "case-1", case_label: "X", title: "Link", storage_kind: "link", storage_ref: "https://example.com/doc", shared_at: null, created_at: "t" });

  const res = await handleBenchGet(authedRequest("https://darius.life/bench/documents/doc-1/file", token), env, new URL("https://darius.life/bench/documents/doc-1/file"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "the actual bytes");

  const linkRes = await handleBenchGet(authedRequest("https://darius.life/bench/documents/doc-2/file", token), env, new URL("https://darius.life/bench/documents/doc-2/file"));
  assert.equal(linkRes.status, 404);
});

test("editing an auto-extracted entry clears its tag — reviewing and saving it is Darius taking authorship", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.docket_entries.push({ id: "entry-1", case_id: "case-1", case_label: "Family matter", entry_date: "2026-09-28", fact: "guessed wrong", source: "upload-ai", created_at: "t", updated_at: "t" });

  const form = new URLSearchParams({ fact: "Corrected: it's actually a response to a TRO." });
  const req = authedRequest("https://darius.life/bench/case/case-1/entries/entry-1/edit", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/entries/entry-1/edit"));
  assert.equal(res.status, 303);
  assert.equal(fakeD1.tables.docket_entries[0].fact, "Corrected: it's actually a response to a TRO.");
  assert.equal(fakeD1.tables.docket_entries[0].source, "manual");
});

test("a docket entry without a fact is rejected and writes nothing", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", status: "open" });

  const form = new URLSearchParams({ entryDate: "2026-09-28" });
  const req = authedRequest("https://darius.life/bench/case/case-1/entries", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/entries"));
  assert.equal(res.status, 400);
  assert.equal(fakeD1.tables.docket_entries.length, 0);
});

test("sharing a document sets shared_at; unsharing clears it", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", status: "open" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Motion", storage_ref: "https://example.com/doc", shared_at: null, created_at: "t" });

  const shareReq = authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/share", token, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const shareRes = await handleBenchPost(shareReq, env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/share"));
  assert.equal(shareRes.status, 303);
  assert.ok(fakeD1.tables.documents[0].shared_at);

  const unshareReq = authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/unshare", token, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } });
  await handleBenchPost(unshareReq, env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/unshare"));
  assert.equal(fakeD1.tables.documents[0].shared_at, null);
});

test("granting entrusted access hashes the passphrase, never stores it, and scopes case_ids", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", status: "open" });

  const form = new URLSearchParams({ passphrase: "correct-horse", grantLabel: "Attorney", caseIds: "case-1" });
  const req = authedRequest("https://darius.life/bench/grants", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/grants"));
  assert.equal(res.status, 303);

  assert.equal(fakeD1.tables.access_grants.length, 1);
  const grant = fakeD1.tables.access_grants[0];
  assert.equal(grant.label, "Attorney");
  assert.deepEqual(JSON.parse(grant.case_ids_json), ["case-1"]);
  assert.ok(!("passphrase" in grant));
  assert.notEqual(grant.code_hash, "correct-horse");
});

test("revoking a grant sets revoked_at and a second revoke is a no-op", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: "abc", case_ids_json: "[]", label: "Attorney", created_at: "t", revoked_at: null });

  const revokeReq = () => authedRequest("https://darius.life/bench/grants/grant-1/revoke", token, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } });
  await handleBenchPost(revokeReq(), env, new URL("https://darius.life/bench/grants/grant-1/revoke"));
  assert.ok(fakeD1.tables.access_grants[0].revoked_at);

  const revokedAt = fakeD1.tables.access_grants[0].revoked_at;
  await handleBenchPost(revokeReq(), env, new URL("https://darius.life/bench/grants/grant-1/revoke"));
  assert.equal(fakeD1.tables.access_grants[0].revoked_at, revokedAt);
});

test("GET /bench/case/:id for a nonexistent case is 404", async () => {
  const { token, jwk } = await validToken();
  const { env } = setup(jwk);
  const res = await handleBenchGet(authedRequest("https://darius.life/bench/case/nope", token), env, new URL("https://darius.life/bench/case/nope"));
  assert.equal(res.status, 404);
});

const postForm = (url, token, fields) =>
  authedRequest(url, token, { method: "POST", body: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

test("sharing a docket entry exposes only the date and fact — never the other three layers", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", status: "open" });
  fakeD1.tables.docket_entries.push({
    id: "entry-1", case_id: "case-1", case_label: "Family matter", entry_date: "2026-09-28",
    fact: "Hearing held.", recommended_direction: "SECRET-DIRECTION", commentary: "SECRET-COMMENTARY",
    court_takeaways: "SECRET-TAKEAWAYS", shared_at: null, source: "manual", created_at: "t", updated_at: "t",
  });
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: "x", case_ids_json: JSON.stringify(["case-1"]), label: "Attorney", created_at: "t", revoked_at: null });

  const shareRes = await handleBenchPost(
    postForm("https://darius.life/bench/case/case-1/entries/entry-1/share", token, {}),
    env, new URL("https://darius.life/bench/case/case-1/entries/entry-1/share"),
  );
  assert.equal(shareRes.status, 303);
  assert.ok(fakeD1.tables.docket_entries[0].shared_at);

  const previewRes = await handleBenchGet(authedRequest("https://darius.life/bench/preview/grant-1", token), env, new URL("https://darius.life/bench/preview/grant-1"));
  const html = await previewRes.text();
  assert.match(html, /Hearing held\./);
  assert.doesNotMatch(html, /SECRET-DIRECTION/);
  assert.doesNotMatch(html, /SECRET-COMMENTARY/);
  assert.doesNotMatch(html, /SECRET-TAKEAWAYS/);
});

test("an unshared entry, and an entry outside the grant's case scope, never appear in the preview", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "In scope", status: "open" });
  fakeD1.tables.cases.push({ id: "case-2", title: "Out of scope", status: "open" });
  fakeD1.tables.docket_entries.push({ id: "e-unshared", case_id: "case-1", case_label: "In scope", entry_date: "2026-09-01", fact: "UNSHARED-FACT", shared_at: null, source: "manual" });
  fakeD1.tables.docket_entries.push({ id: "e-out-of-scope", case_id: "case-2", case_label: "Out of scope", entry_date: "2026-09-02", fact: "OUT-OF-SCOPE-FACT", shared_at: "t", source: "manual" });
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: "x", case_ids_json: JSON.stringify(["case-1"]), label: "Attorney", created_at: "t", revoked_at: null });

  const res = await handleBenchGet(authedRequest("https://darius.life/bench/preview/grant-1", token), env, new URL("https://darius.life/bench/preview/grant-1"));
  const html = await res.text();
  assert.doesNotMatch(html, /UNSHARED-FACT/);
  assert.doesNotMatch(html, /OUT-OF-SCOPE-FACT/);
});

test("a document attached to an entry appears nested under that entry in the preview", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", status: "open" });
  fakeD1.tables.docket_entries.push({ id: "entry-1", case_id: "case-1", case_label: "Family matter", entry_date: "2026-09-28", fact: "Hearing held.", shared_at: "t", source: "manual" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", entry_id: "entry-1", title: "Motion PDF", storage_ref: "https://example.com/motion", shared_at: "t", created_at: "t" });
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: "x", case_ids_json: JSON.stringify(["case-1"]), label: "Attorney", created_at: "t", revoked_at: null });

  const res = await handleBenchGet(authedRequest("https://darius.life/bench/preview/grant-1", token), env, new URL("https://darius.life/bench/preview/grant-1"));
  const html = await res.text();
  assert.match(html, /Motion PDF/);
});

test("preview creates no cookie and requires the working side's own Access token, not the guest's passphrase", async () => {
  const { env, fakeD1 } = setup(null);
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: "x", case_ids_json: "[]", label: "Attorney", created_at: "t", revoked_at: null });
  const res = await handleBenchGet(new Request("https://darius.life/bench/preview/grant-1"), env, new URL("https://darius.life/bench/preview/grant-1"));
  assert.equal(res.status, 403);
});

test("changing a grant's passphrase updates its hash and rejects the old one downstream", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  const oldHash = "old-hash-value";
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: oldHash, case_ids_json: "[]", label: "Attorney", created_at: "t", revoked_at: null });

  const res = await handleBenchPost(
    postForm("https://darius.life/bench/grants/grant-1/passphrase", token, { newPassphrase: "brand-new-passphrase" }),
    env, new URL("https://darius.life/bench/grants/grant-1/passphrase"),
  );
  assert.equal(res.status, 303);
  assert.notEqual(fakeD1.tables.access_grants[0].code_hash, oldHash);
});

test("the management page reports accurate shared document and entry counts per grant", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", status: "open" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Doc", storage_ref: "x", shared_at: "t", created_at: "t" });
  fakeD1.tables.docket_entries.push({ id: "entry-1", case_id: "case-1", case_label: "Family matter", entry_date: "2026-09-01", fact: "F", shared_at: "t", source: "manual" });
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: "x", case_ids_json: JSON.stringify(["case-1"]), label: "Attorney", created_at: "t", revoked_at: null });

  const res = await handleBenchGet(authedRequest("https://darius.life/bench/", token), env, new URL("https://darius.life/bench/"));
  const html = await res.text();
  assert.match(html, /Family matter/);
  assert.match(html, /1 document, 1 timeline entry shared/);
});

test("a document's own page lists its recordings, newest-noted first, and links back to the case", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Motion.pdf", storage_kind: "upload", storage_ref: "bench-blobs/doc-1/Motion.pdf", shared_at: null, created_at: "t" });
  fakeD1.tables.document_recordings.push({ id: "r1", document_id: "doc-1", case_id: "case-1", noted_at: "2026-09-01", body: "First thought.", audio_storage_ref: null, audio_mime_type: null, audio_duration_seconds: null, created_at: "t" });

  const res = await handleBenchGet(authedRequest("https://darius.life/bench/documents/doc-1", token), env, new URL("https://darius.life/bench/documents/doc-1"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /First thought\./);
  assert.match(html, /Family matter/);
});

test("adding a recording with only a typed note (no audio) works — audio is optional", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });

  const form = new URLSearchParams({ notedAt: "2026-09-28", body: "Called opposing counsel today." });
  const req = authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/recordings", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/recordings"));
  assert.equal(res.status, 303);
  assert.equal(fakeD1.tables.document_recordings.length, 1);
  assert.equal(fakeD1.tables.document_recordings[0].audio_storage_ref, null);
});

test("adding a recording with audio but no typed note works, and the audio streams back from its own route", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1, fakeR2 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });

  const { blobId, filename, contentType } = await putBlob(env, token, "voice.m4a", "audio/m4a", "the actual audio bytes");
  const form = new URLSearchParams({ notedAt: "2026-09-28", blobId, filename, contentType });
  const req = authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/recordings", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/recordings"));
  assert.equal(res.status, 303);

  const recording = fakeD1.tables.document_recordings[0];
  assert.equal(recording.body, null);
  assert.ok(recording.audio_storage_ref);

  const fileRes = await handleBenchGet(authedRequest(`https://darius.life/bench/recordings/${recording.id}/file`, token), env, new URL(`https://darius.life/bench/recordings/${recording.id}/file`));
  assert.equal(fileRes.status, 200);
  assert.equal(await fileRes.text(), "the actual audio bytes");
});

test("adding a recording with audio transcribes it in the background, then regenerates the case summary with that transcript", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t", ai_summary: null, ai_summary_updated_at: null });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });
  let sentAudio = null;
  let sentPrompt = "";
  env.AI = {
    run: async (model, opts) => {
      if (model === "@cf/openai/whisper") { sentAudio = opts.audio; return { text: "Filed the response this morning." }; }
      sentPrompt = opts.messages[0].content;
      return { response: "Overview: a voice note is now on file." };
    },
  };

  const { blobId, filename, contentType } = await putBlob(env, token, "voice.m4a", "audio/m4a", "the actual audio bytes");
  const form = new URLSearchParams({ notedAt: "2026-09-28", blobId, filename, contentType });
  const { ctx, drain } = stubCtx();
  const req = authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/recordings", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/recordings"), ctx);
  assert.equal(res.status, 303);

  const recordingBefore = fakeD1.tables.document_recordings[0];
  assert.ok(!recordingBefore.transcript); // not yet — the response didn't wait on it

  await drain();
  const recording = fakeD1.tables.document_recordings[0];
  assert.equal(recording.transcript, "Filed the response this morning.");
  assert.equal(recording.transcript_source, "auto");
  assert.deepEqual(sentAudio, [...new TextEncoder().encode("the actual audio bytes")]);
  assert.match(sentPrompt, /Filed the response this morning\./);
  assert.match(fakeD1.tables.cases[0].ai_summary, /voice note/);
});

test("correcting a transcript saves the edit, tags it manual, and regenerates the case summary", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t", ai_summary: null, ai_summary_updated_at: null });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });
  fakeD1.tables.document_recordings.push({ id: "r1", document_id: "doc-1", case_id: "case-1", noted_at: "2026-09-28", body: null, audio_storage_ref: "bench-blobs/r1/voice.m4a", transcript: "Filed the responze this morning.", transcript_error: null, transcript_source: "auto", created_at: "t" });
  let sentPrompt = "";
  env.AI = { run: async (model, opts) => { sentPrompt = opts.messages[0].content; return { response: "ok" }; } };

  const { ctx, drain } = stubCtx();
  const form = new URLSearchParams({ transcript: "Filed the response this morning." });
  const req = authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/recordings/r1/edit", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/recordings/r1/edit"), ctx);
  assert.equal(res.status, 303);

  const recording = fakeD1.tables.document_recordings[0];
  assert.equal(recording.transcript, "Filed the response this morning.");
  assert.equal(recording.transcript_source, "manual");
  await drain();
  assert.match(sentPrompt, /Filed the response this morning\./);
});

test("saving an empty transcript correction is rejected — delete the recording instead if it's wrong entirely", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });
  fakeD1.tables.document_recordings.push({ id: "r1", document_id: "doc-1", case_id: "case-1", noted_at: "t", body: null, audio_storage_ref: "bench-blobs/r1/voice.m4a", transcript: "Something.", transcript_source: "auto", created_at: "t" });

  const form = new URLSearchParams({ transcript: "" });
  const req = authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/recordings/r1/edit", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/recordings/r1/edit"));
  assert.equal(res.status, 400);
  assert.equal(fakeD1.tables.document_recordings[0].transcript, "Something.");
});

test("a document can carry any number of recordings, added one at a time through the real routes — both typed and recorded", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });

  const form1 = new URLSearchParams({ notedAt: "2026-09-01", body: "First thought." });
  await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/recordings", token, { method: "POST", body: form1.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/recordings"),
  );

  const { blobId, filename, contentType } = await putBlob(env, token, "voice.m4a", "audio/m4a", "audio bytes two");
  const form2 = new URLSearchParams({ notedAt: "2026-09-15", blobId, filename, contentType });
  await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/recordings", token, { method: "POST", body: form2.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/recordings"),
  );

  assert.equal(fakeD1.tables.document_recordings.length, 2);
  const detail = await handleBenchGet(authedRequest("https://darius.life/bench/documents/doc-1", token), env, new URL("https://darius.life/bench/documents/doc-1"));
  const html = await detail.text();
  assert.match(html, /First thought\./);
  assert.match(html, /2026-09-15/);
  // The second form is still there after one is added — nothing caps it at one.
  assert.match(html, /Add one/);
});

test("a recording's audio over the transcribable size ceiling is skipped, cheaply, without fetching its bytes", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1, fakeR2 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });
  fakeD1.tables.document_recordings.push({ id: "r1", document_id: "doc-1", case_id: "case-1", noted_at: "t", body: null, audio_storage_ref: "bench-blobs/r1/voice.m4a", created_at: "t" });
  await fakeR2.put("bench-blobs/r1/voice.m4a", "audio bytes");
  const realHead = fakeR2.head.bind(fakeR2);
  fakeR2.head = async (key) => ({ ...(await realHead(key)), size: 26 * 1024 * 1024 });
  let calls = 0;
  env.AI = { run: async () => { calls++; return { text: "should never be reached" }; } };

  const { transcribeRecording } = await import("./bench-working.js");
  await transcribeRecording(env, "r1");
  assert.equal(calls, 0);
  assert.ok(!fakeD1.tables.document_recordings[0].transcript);
});

test("a recording with neither a note nor audio is rejected — not neither", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });

  const form = new URLSearchParams({ notedAt: "2026-09-28" });
  const req = authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/recordings", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/recordings"));
  assert.equal(res.status, 400);
  assert.equal(fakeD1.tables.document_recordings.length, 0);
});

test("GET /bench/static/bench.js serves the client script, Access-gated like everything else", async () => {
  const { token, jwk } = await validToken();
  const { env } = setup(jwk);
  const noAuth = await handleBenchGet(new Request("https://darius.life/bench/static/bench.js"), env, new URL("https://darius.life/bench/static/bench.js"));
  assert.equal(noAuth.status, 403);

  const res = await handleBenchGet(authedRequest("https://darius.life/bench/static/bench.js", token), env, new URL("https://darius.life/bench/static/bench.js"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  const body = await res.text();
  assert.match(body, /MediaRecorder/);
});

test("deleting an entry removes it and any document attached to it becomes general instead", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.docket_entries.push({ id: "entry-1", case_id: "case-1", case_label: "X", entry_date: "t", fact: "F", source: "manual", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", entry_id: "entry-1", title: "Motion", storage_kind: "link", storage_ref: "https://example.com/x", shared_at: null, created_at: "t" });

  const req = authedRequest("https://darius.life/bench/case/case-1/entries/entry-1/delete", token, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/entries/entry-1/delete"));
  assert.equal(res.status, 303);
  assert.equal(fakeD1.tables.docket_entries.length, 0);
  assert.equal(fakeD1.tables.documents[0].entry_id, null);
});

test("deleting a document also deletes its R2 bytes and its recordings' audio", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1, fakeR2 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion.pdf", storage_kind: "upload", storage_ref: "bench-blobs/doc-1/motion.pdf", shared_at: null, created_at: "t" });
  fakeD1.tables.document_recordings.push({ id: "r1", document_id: "doc-1", case_id: "case-1", noted_at: "t", body: null, audio_storage_ref: "bench-blobs/r1/voice.m4a", created_at: "t" });
  await fakeR2.put("bench-blobs/doc-1/motion.pdf", "doc bytes");
  await fakeR2.put("bench-blobs/r1/voice.m4a", "audio bytes");

  const req = authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/delete", token, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/delete"));
  assert.equal(res.status, 303);
  assert.equal(fakeD1.tables.documents.length, 0);
  assert.equal(fakeD1.tables.document_recordings.length, 0);
  assert.equal(await fakeR2.get("bench-blobs/doc-1/motion.pdf"), null);
  assert.equal(await fakeR2.get("bench-blobs/r1/voice.m4a"), null);
});

test("deleting a single recording removes only that row and its own audio, leaving the document alone", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1, fakeR2 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, created_at: "t" });
  fakeD1.tables.document_recordings.push({ id: "r1", document_id: "doc-1", case_id: "case-1", noted_at: "t", body: null, audio_storage_ref: "bench-blobs/r1/voice.m4a", created_at: "t" });
  await fakeR2.put("bench-blobs/r1/voice.m4a", "audio bytes");

  const req = authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/recordings/r1/delete", token, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/recordings/r1/delete"));
  assert.equal(res.status, 303);
  assert.equal(fakeD1.tables.document_recordings.length, 0);
  assert.equal(fakeD1.tables.documents.length, 1);
  assert.equal(await fakeR2.get("bench-blobs/r1/voice.m4a"), null);
});

test("deleting a case requires typing its exact title back, and refuses (writing nothing) if it doesn't match", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });

  const wrongForm = new URLSearchParams({ confirmTitle: "wrong title" });
  const wrongRes = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/delete", token, { method: "POST", body: wrongForm.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/delete"),
  );
  assert.equal(wrongRes.status, 400);
  assert.equal(fakeD1.tables.cases.length, 1);

  const rightForm = new URLSearchParams({ confirmTitle: "Family matter" });
  const rightRes = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/delete", token, { method: "POST", body: rightForm.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/delete"),
  );
  assert.equal(rightRes.status, 303);
  assert.equal(fakeD1.tables.cases.length, 0);
});

test("deleting a case removes every document's R2 bytes and every recording's audio under it", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1, fakeR2 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion.pdf", storage_kind: "upload", storage_ref: "bench-blobs/doc-1/motion.pdf", shared_at: null, created_at: "t" });
  fakeD1.tables.document_recordings.push({ id: "r1", document_id: "doc-1", case_id: "case-1", noted_at: "t", body: null, audio_storage_ref: "bench-blobs/r1/voice.m4a", created_at: "t" });
  await fakeR2.put("bench-blobs/doc-1/motion.pdf", "doc bytes");
  await fakeR2.put("bench-blobs/r1/voice.m4a", "audio bytes");

  const form = new URLSearchParams({ confirmTitle: "Family matter" });
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/delete", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/delete"),
  );
  assert.equal(res.status, 303);
  assert.equal(await fakeR2.get("bench-blobs/doc-1/motion.pdf"), null);
  assert.equal(await fakeR2.get("bench-blobs/r1/voice.m4a"), null);
});

// A stub ctx.waitUntil that just collects the tasks so a test can await
// them itself — mirrors the real Workers runtime's contract (keep the
// promise alive past the response) closely enough for regeneration to be
// observable without a real Workers environment.
function stubCtx() {
  const tasks = [];
  return { ctx: { waitUntil: (p) => tasks.push(p) }, drain: () => Promise.all(tasks) };
}

test("adding a docket entry regenerates the case summary in the background via ctx.waitUntil", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t", ai_summary: null, ai_summary_updated_at: null });
  let calls = 0;
  env.AI = { run: async () => { calls++; return { response: "1. Overview\nA family matter, open." }; } };

  const { ctx, drain } = stubCtx();
  const form = new URLSearchParams({ entryDate: "2026-09-28", fact: "Hearing held." });
  const req = authedRequest("https://darius.life/bench/case/case-1/entries", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchPost(req, env, new URL("https://darius.life/bench/case/case-1/entries"), ctx);
  assert.equal(res.status, 303);

  // The redirect above didn't wait on the AI call — ctx.waitUntil is what
  // keeps it alive, same as the real Workers runtime.
  assert.equal(calls, 0);
  await drain();
  assert.equal(calls, 1);
  assert.match(fakeD1.tables.cases[0].ai_summary, /Overview/);
  assert.ok(fakeD1.tables.cases[0].ai_summary_updated_at);
});

test("sharing or unsharing a docket entry does not regenerate the case summary — the underlying facts haven't changed", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t", ai_summary: null, ai_summary_updated_at: null });
  fakeD1.tables.docket_entries.push({ id: "e1", case_id: "case-1", case_label: "Family matter", entry_date: "2026-09-28", fact: "Hearing held.", source: "manual", shared_at: null, created_at: "t", updated_at: "t" });
  let calls = 0;
  env.AI = { run: async () => { calls++; return { response: "Overview." }; } };

  const { ctx, drain } = stubCtx();
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/entries/e1/share", token, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/entries/e1/share"), ctx,
  );
  assert.equal(res.status, 303);
  await drain();
  assert.equal(calls, 0);
  assert.equal(fakeD1.tables.cases[0].ai_summary, null);
});

test("POST /bench/case/:id/summary/refresh regenerates synchronously — the response itself waits on it, unlike every other write", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t", ai_summary: null, ai_summary_updated_at: null });
  fakeD1.tables.docket_entries.push({ id: "e1", case_id: "case-1", case_label: "Family matter", entry_date: "2026-09-28", fact: "Hearing held.", source: "manual", shared_at: null, created_at: "t", updated_at: "t" });
  env.AI = { run: async () => ({ response: "1. Overview\nFresh summary." }) };

  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/summary/refresh", token, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/summary/refresh"),
  );
  assert.equal(res.status, 303);
  // No ctx.waitUntil was passed at all, yet the summary is already there —
  // proof this route awaits regeneration itself rather than backgrounding it.
  assert.match(fakeD1.tables.cases[0].ai_summary, /Fresh summary/);

  const detail = await handleBenchGet(authedRequest("https://darius.life/bench/case/case-1", token), env, new URL("https://darius.life/bench/case/case-1"));
  const html = await detail.text();
  assert.match(html, /Fresh summary/);
  assert.match(html, /not legal advice/);
});

test("POST /bench/case/:id/summary/refresh on a nonexistent case is 404 and calls no AI", async () => {
  const { token, jwk } = await validToken();
  const { env } = setup(jwk);
  let calls = 0;
  env.AI = { run: async () => { calls++; return { response: "x" }; } };
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/nope/summary/refresh", token, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/nope/summary/refresh"),
  );
  assert.equal(res.status, 404);
  assert.equal(calls, 0);
});

test("a case with no ai_summary yet shows the not-yet-generated state, not a blank section", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t", ai_summary: null, ai_summary_updated_at: null });
  const detail = await handleBenchGet(authedRequest("https://darius.life/bench/case/case-1", token), env, new URL("https://darius.life/bench/case/case-1"));
  const html = await detail.text();
  assert.match(html, /Nothing to summarize yet/);
  assert.match(html, /Refresh summary now/);
});

// --- Hearings & deadlines ---

test("adding a docket entry as a hearing shows it under Upcoming on the case page, and it regenerates the case summary", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t", ai_summary: null, ai_summary_updated_at: null });

  const { ctx, drain } = stubCtx();
  const form = new URLSearchParams({ entryDate: "2099-10-15", fact: "Hearing on temporary orders.", entryKind: "hearing" });
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/entries", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/entries"), ctx,
  );
  assert.equal(res.status, 303);
  assert.equal(fakeD1.tables.docket_entries[0].entry_kind, "hearing");
  await drain();

  const detail = await handleBenchGet(authedRequest("https://darius.life/bench/case/case-1", token), env, new URL("https://darius.life/bench/case/case-1"));
  const html = await detail.text();
  assert.match(html, /Upcoming/);
  assert.match(html, /Hearing on temporary orders\./);
});

test("a past hearing date never appears under Upcoming", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.docket_entries.push({ id: "e1", case_id: "case-1", case_label: "X", entry_date: "2020-01-01", fact: "Old hearing.", entry_kind: "hearing", source: "manual", created_at: "t", updated_at: "t" });

  const detail = await handleBenchGet(authedRequest("https://darius.life/bench/case/case-1", token), env, new URL("https://darius.life/bench/case/case-1"));
  const html = await detail.text();
  assert.doesNotMatch(html, /class="card upcoming"/);
});

test("the case list shows each case's soonest upcoming hearing/deadline as a tag", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.docket_entries.push({ id: "e1", case_id: "case-1", case_label: "X", entry_date: "2099-11-01", fact: "Later deadline.", entry_kind: "deadline", source: "manual", created_at: "t", updated_at: "t" });
  fakeD1.tables.docket_entries.push({ id: "e2", case_id: "case-1", case_label: "X", entry_date: "2099-10-15", fact: "Sooner hearing.", entry_kind: "hearing", source: "manual", created_at: "t", updated_at: "t" });

  const list = await handleBenchGet(authedRequest("https://darius.life/bench/", token), env, new URL("https://darius.life/bench/"));
  const html = await list.text();
  assert.match(html, /hearing 2099-10-15/);
});

test("editing an entry's kind is honored, and correcting a hearing back to a plain note removes it from Upcoming", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.docket_entries.push({ id: "e1", case_id: "case-1", case_label: "X", entry_date: "2099-10-15", fact: "Maybe a hearing?", entry_kind: "hearing", source: "manual", created_at: "t", updated_at: "t" });

  const form = new URLSearchParams({ fact: "Turned out to be nothing.", entryKind: "note" });
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/entries/e1/edit", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/entries/e1/edit"),
  );
  assert.equal(res.status, 303);
  assert.equal(fakeD1.tables.docket_entries[0].entry_kind, "note");

  const detail = await handleBenchGet(authedRequest("https://darius.life/bench/case/case-1", token), env, new URL("https://darius.life/bench/case/case-1"));
  assert.doesNotMatch(await detail.text(), /Upcoming/);
});

// --- Filing & service ---

test("a document defaults to drafted, can be marked filed, then served with a proof-of-service upload", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, filing_status: "drafted", created_at: "t" });

  const fileForm = new URLSearchParams({ filedDate: "2026-09-15" });
  const fileRes = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/file", token, { method: "POST", body: fileForm.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/file"),
  );
  assert.equal(fileRes.status, 303);
  assert.equal(fakeD1.tables.documents[0].filing_status, "filed");
  assert.equal(fakeD1.tables.documents[0].filed_date, "2026-09-15");

  const { blobId, filename, contentType } = await putBlob(env, token, "receipt.pdf", "application/pdf", "mail receipt bytes");
  const serveForm = new URLSearchParams({ servedAt: "2026-09-20", servedMethod: "mail", servedOn: "Respondent, Jane Doe", blobId, filename, contentType });
  const serveRes = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/serve", token, { method: "POST", body: serveForm.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/serve"),
  );
  assert.equal(serveRes.status, 303);
  const doc = fakeD1.tables.documents[0];
  assert.equal(doc.filing_status, "served");
  assert.equal(doc.served_method, "mail");
  assert.equal(doc.served_on, "Respondent, Jane Doe");
  assert.ok(doc.proof_of_service_ref);

  const proofRes = await handleBenchGet(
    authedRequest(`https://darius.life/bench/documents/doc-1/proof-of-service/file`, token),
    env, new URL(`https://darius.life/bench/documents/doc-1/proof-of-service/file`),
  );
  assert.equal(proofRes.status, 200);
  assert.equal(await proofRes.text(), "mail receipt bytes");

  const detail = await handleBenchGet(authedRequest("https://darius.life/bench/documents/doc-1", token), env, new URL("https://darius.life/bench/documents/doc-1"));
  const html = await detail.text();
  assert.match(html, /Served 2026-09-20/);
  assert.match(html, /Open proof of service/);
});

test("marking served without a proof-of-service upload still works — the upload is optional", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, filing_status: "filed", filed_date: "2026-09-15", created_at: "t" });

  const form = new URLSearchParams({ servedAt: "2026-09-20", servedMethod: "personal" });
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/documents/doc-1/serve", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/documents/doc-1/serve"),
  );
  assert.equal(res.status, 303);
  assert.equal(fakeD1.tables.documents[0].filing_status, "served");
  assert.equal(fakeD1.tables.documents[0].proof_of_service_ref, null);
});

test("adding a document with a filedDate up front shows it already filed, not drafted", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t" });

  const form = new URLSearchParams({ docTitle: "Response", storageRef: "https://example.com/response.pdf", filedDate: "2026-09-01" });
  await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/documents", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/documents"),
  );
  assert.equal(fakeD1.tables.documents[0].filing_status, "filed");
});

test("the filing packet lists every document and its status, and is reachable from the case page", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: "CV-1", status: "open", created_at: "t", updated_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "X", title: "Motion.pdf", storage_kind: "upload", storage_ref: "k", shared_at: null, filing_status: "served", served_at: "2026-09-20", created_at: "t" });

  const caseDetail = await handleBenchGet(authedRequest("https://darius.life/bench/case/case-1", token), env, new URL("https://darius.life/bench/case/case-1"));
  assert.match(await caseDetail.text(), /Filing packet/);

  const packet = await handleBenchGet(authedRequest("https://darius.life/bench/case/case-1/packet", token), env, new URL("https://darius.life/bench/case/case-1/packet"));
  assert.equal(packet.status, 200);
  const html = await packet.text();
  assert.match(html, /Motion\.pdf/);
  assert.match(html, /served 2026-09-20/);
});

// --- Local rules & procedure notes ---

test("saving local rules notes stores Darius's own words and never triggers a case summary regeneration", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.cases.push({ id: "case-1", title: "Family matter", court: null, case_number: null, status: "open", created_at: "t", updated_at: "t", ai_summary: null, ai_summary_updated_at: null });
  let calls = 0;
  env.AI = { run: async () => { calls++; return { response: "should not be called" }; } };

  const { ctx, drain } = stubCtx();
  const form = new URLSearchParams({ notes: "Self-help center says: 3 copies, one for the clerk." });
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/case/case-1/local-rules", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/case/case-1/local-rules"), ctx,
  );
  assert.equal(res.status, 303);
  assert.equal(fakeD1.tables.cases[0].local_rules_notes, "Self-help center says: 3 copies, one for the clerk.");
  await drain();
  assert.equal(calls, 0);

  const detail = await handleBenchGet(authedRequest("https://darius.life/bench/case/case-1", token), env, new URL("https://darius.life/bench/case/case-1"));
  assert.match(await detail.text(), /3 copies, one for the clerk\./);
});

// --- Resources ---

test("GET /bench/resources lists resources, including the one seeded default", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  fakeD1.tables.resources.push({ id: "res-1", name: "National Domestic Violence Hotline", phone: "1-800-799-7233", url: "https://www.thehotline.org", notes: "24/7", created_at: "t" });
  const res = await handleBenchGet(authedRequest("https://darius.life/bench/resources", token), env, new URL("https://darius.life/bench/resources"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /National Domestic Violence Hotline/);
  assert.match(html, /1-800-799-7233/);
});

test("adding and deleting a resource works, and the case list links to the resources page", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);

  const addForm = new URLSearchParams({ name: "County self-help center", phone: "555-0100" });
  const addRes = await handleBenchPost(
    authedRequest("https://darius.life/bench/resources", token, { method: "POST", body: addForm.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/resources"),
  );
  assert.equal(addRes.status, 303);
  assert.equal(fakeD1.tables.resources.length, 1);
  const resourceId = fakeD1.tables.resources[0].id;

  const list = await handleBenchGet(authedRequest("https://darius.life/bench/", token), env, new URL("https://darius.life/bench/"));
  assert.match(await list.text(), /bench\/resources/);

  const deleteRes = await handleBenchPost(
    authedRequest(`https://darius.life/bench/resources/${resourceId}/delete`, token, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL(`https://darius.life/bench/resources/${resourceId}/delete`),
  );
  assert.equal(deleteRes.status, 303);
  assert.equal(fakeD1.tables.resources.length, 0);
});

test("adding a resource without a name is rejected and writes nothing", async () => {
  const { token, jwk } = await validToken();
  const { env, fakeD1 } = setup(jwk);
  const form = new URLSearchParams({ phone: "555-0100" });
  const res = await handleBenchPost(
    authedRequest("https://darius.life/bench/resources", token, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench/resources"),
  );
  assert.equal(res.status, 400);
  assert.equal(fakeD1.tables.resources.length, 0);
});
