import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleBenchGet, handleBenchPost } from "./bench-working.js";
import { resetCertsCacheForTests } from "../../shared/access.js";
import { createFakeD1 } from "../../shared/test-fake-d1.mjs";

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
  globalThis.fetch = async (url) => {
    if (String(url) === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) return { ok: true, json: async () => ({ keys: [jwk] }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { env: { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD, BENCH_NOTES: fakeD1.BENCH_NOTES }, fakeD1 };
}

const authedRequest = (url, token, opts = {}) =>
  new Request(url, { ...opts, headers: { ...(opts.headers || {}), "Cf-Access-Jwt-Assertion": token } });

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
