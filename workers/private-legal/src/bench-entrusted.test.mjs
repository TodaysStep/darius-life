import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBenchEntrustedGet, handleBenchEntrustedPost } from "./bench-entrusted.js";
import { createFakeD1 } from "../../shared/test-fake-d1.mjs";
import { sha256Hex } from "../../shared/bench-crypto.js";

const SECRET = "test-entrusted-secret";

function setup() {
  const fakeD1 = createFakeD1();
  return { env: { ENTRUSTED_COOKIE_SECRET: SECRET, BENCH_NOTES: fakeD1.BENCH_NOTES }, fakeD1 };
}

const cookieReq = (url, cookie) => new Request(url, cookie ? { headers: { Cookie: cookie } } : undefined);

function extractSetCookie(res) {
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : null;
}

test("GET /bench-entrusted/ with no cookie shows the login form, not the portal", async () => {
  const { env } = setup();
  const res = await handleBenchEntrustedGet(cookieReq("https://darius.life/bench-entrusted/"), env, new URL("https://darius.life/bench-entrusted/"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Passphrase/);
  assert.doesNotMatch(html, /Sign out/);
});

test("logging in with the wrong passphrase is rejected and issues no cookie", async () => {
  const { env, fakeD1 } = setup();
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: await sha256Hex("right-code"), case_ids_json: "[]", label: null, created_at: "t", revoked_at: null });

  const form = new URLSearchParams({ passphrase: "wrong-code" });
  const req = new Request("https://darius.life/bench-entrusted/login", { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const res = await handleBenchEntrustedPost(req, env, new URL("https://darius.life/bench-entrusted/login"));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("logging in with the right passphrase issues a session cookie that reaches the portal", async () => {
  const { env, fakeD1 } = setup();
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: await sha256Hex("right-code"), case_ids_json: JSON.stringify(["case-1"]), label: null, created_at: "t", revoked_at: null });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "Family matter", title: "Shared motion", storage_ref: "https://example.com/doc", filed_date: null, shared_at: "t", created_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-2", case_id: "case-1", case_label: "Family matter", title: "Unshared draft", storage_ref: "https://example.com/draft", filed_date: null, shared_at: null, created_at: "t" });

  const form = new URLSearchParams({ passphrase: "right-code" });
  const loginReq = new Request("https://darius.life/bench-entrusted/login", { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const loginRes = await handleBenchEntrustedPost(loginReq, env, new URL("https://darius.life/bench-entrusted/login"));
  assert.equal(loginRes.status, 303);
  const cookie = extractSetCookie(loginRes);
  assert.ok(cookie);

  const portalRes = await handleBenchEntrustedGet(cookieReq("https://darius.life/bench-entrusted/", cookie), env, new URL("https://darius.life/bench-entrusted/"));
  assert.equal(portalRes.status, 200);
  const html = await portalRes.text();
  assert.match(html, /Family matter/);
  assert.match(html, /Shared motion/);
  assert.doesNotMatch(html, /Unshared draft/);
});

test("a document belonging to a case outside the grant's scope is never shown", async () => {
  const { env, fakeD1 } = setup();
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: await sha256Hex("right-code"), case_ids_json: JSON.stringify(["case-1"]), label: null, created_at: "t", revoked_at: null });
  fakeD1.tables.documents.push({ id: "doc-1", case_id: "case-1", case_label: "In scope", title: "Visible doc", storage_ref: "x", filed_date: null, shared_at: "t", created_at: "t" });
  fakeD1.tables.documents.push({ id: "doc-2", case_id: "case-2", case_label: "Out of scope", title: "Secret doc", storage_ref: "x", filed_date: null, shared_at: "t", created_at: "t" });

  const form = new URLSearchParams({ passphrase: "right-code" });
  const loginRes = await handleBenchEntrustedPost(
    new Request("https://darius.life/bench-entrusted/login", { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench-entrusted/login"),
  );
  const cookie = extractSetCookie(loginRes);
  const portalRes = await handleBenchEntrustedGet(cookieReq("https://darius.life/bench-entrusted/", cookie), env, new URL("https://darius.life/bench-entrusted/"));
  const html = await portalRes.text();
  assert.match(html, /Visible doc/);
  assert.doesNotMatch(html, /Secret doc/);
  assert.doesNotMatch(html, /Out of scope/);
});

test("revoking a grant locks out its existing session immediately, even with a still-valid cookie", async () => {
  const { env, fakeD1 } = setup();
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: await sha256Hex("right-code"), case_ids_json: "[]", label: null, created_at: "t", revoked_at: null });

  const form = new URLSearchParams({ passphrase: "right-code" });
  const loginRes = await handleBenchEntrustedPost(
    new Request("https://darius.life/bench-entrusted/login", { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }),
    env, new URL("https://darius.life/bench-entrusted/login"),
  );
  const cookie = extractSetCookie(loginRes);

  fakeD1.tables.access_grants[0].revoked_at = "2026-09-28T00:00:00.000Z";

  const portalRes = await handleBenchEntrustedGet(cookieReq("https://darius.life/bench-entrusted/", cookie), env, new URL("https://darius.life/bench-entrusted/"));
  assert.equal(portalRes.status, 200);
  const html = await portalRes.text();
  assert.match(html, /revoked/i);
  assert.doesNotMatch(html, /Sign out/);
});

test("a forged cookie (wrong secret) is rejected", async () => {
  const { env, fakeD1 } = setup();
  fakeD1.tables.access_grants.push({ id: "grant-1", code_hash: "whatever", case_ids_json: "[]", label: null, created_at: "t", revoked_at: null });
  const forged = `bench_entrusted_session=${Buffer.from(JSON.stringify({ gid: "grant-1", exp: 9999999999 })).toString("base64url")}.forged-signature`;
  const res = await handleBenchEntrustedGet(cookieReq("https://darius.life/bench-entrusted/", forged), env, new URL("https://darius.life/bench-entrusted/"));
  const html = await res.text();
  assert.match(html, /Passphrase/);
});

test("logout clears the cookie", async () => {
  const { env } = setup();
  const res = await handleBenchEntrustedPost(new Request("https://darius.life/bench-entrusted/logout", { method: "POST" }), env, new URL("https://darius.life/bench-entrusted/logout"));
  assert.equal(res.status, 303);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});
