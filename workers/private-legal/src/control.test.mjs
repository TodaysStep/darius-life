// Runs under plain Node, same as index.test.mjs — Web Crypto for the Access JWT,
// a stubbed global fetch standing in for both Cloudflare's certs endpoint and the
// GitHub Contents API, so no real network and no real repo are touched.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleControlGet, handleControlPost, _internal } from "./control.js";
import { resetCertsCacheForTests } from "./access.js";

beforeEach(() => resetCertsCacheForTests());

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "test-key-1";
const ENV = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD, GITHUB_REPO: "TodaysStep/darius-life", GITHUB_BRANCH: "main", GH_COMMIT_TOKEN: "test-token" };

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

const MANIFEST = JSON.stringify({
  items: [
    { id: "projects.alpha", dynamic: "project", label: "Alpha" },
    { id: "projects.beta", dynamic: "project", label: "Beta" },
  ],
});
const STATUS = JSON.stringify({ personal: "Heads down." });
const PROJECTS = JSON.stringify({ alpha: "active", beta: "paused" });

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// Routes both the Access certs fetch and the GitHub Contents API. `puts` collects
// every PUT body so a test can assert exactly what would have been committed.
function stubFetch({ jwk, puts = [] } = {}) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) return { ok: true, json: async () => ({ keys: [jwk] }) };
    if (init?.method === "PUT" && u.includes("api.github.com/repos/")) {
      puts.push({ url: u, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ commit: { sha: "new-sha" } }) };
    }
    if (u.includes("content/manifest.json")) return { ok: true, json: async () => ({ content: b64(MANIFEST), sha: "manifest-sha" }) };
    if (u.includes("data/status.json")) return { ok: true, json: async () => ({ content: b64(STATUS), sha: "status-sha" }) };
    if (u.includes("data/projects.json")) return { ok: true, json: async () => ({ content: b64(PROJECTS), sha: "projects-sha" }) };
    throw new Error(`unexpected fetch: ${u}`);
  };
  return puts;
}

test("GET /control/ without a token is forbidden and never touches GitHub", async () => {
  let ghHit = false;
  globalThis.fetch = async () => {
    ghHit = true;
    throw new Error("should not be called");
  };
  const res = await handleControlGet(new Request("https://darius.life/control/"), ENV);
  assert.equal(res.status, 403);
  assert.equal(ghHit, false);
});

test("GET /control/ with a valid token renders the current status and projects, pre-selected", async () => {
  const { token, jwk } = await validToken();
  stubFetch({ jwk });
  const res = await handleControlGet(new Request("https://darius.life/control/", { headers: { "Cf-Access-Jwt-Assertion": token } }), ENV);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /name="personal" value="Heads down\."[^>]*checked/);
  assert.match(html, /name="project:alpha" value="active"[^>]*checked/);
  assert.match(html, /name="project:beta" value="paused"[^>]*checked/);
  assert.match(html, /Alpha/);
  assert.match(html, /Beta/);
});

test("POST with a valid token and valid fields commits both files and shows Saved", async () => {
  const { token, jwk } = await validToken();
  const puts = stubFetch({ jwk });
  const form = new URLSearchParams({ personal: "Surfacing soon.", "project:alpha": "paused", "project:beta": "active" });
  const req = new Request("https://darius.life/control/", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const res = await handleControlPost(req, ENV);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Saved/);

  assert.equal(puts.length, 2);
  const statusPut = puts.find((p) => p.url.includes("data/status.json"));
  const projectsPut = puts.find((p) => p.url.includes("data/projects.json"));
  assert.equal(statusPut.body.sha, "status-sha");
  assert.deepEqual(JSON.parse(Buffer.from(statusPut.body.content, "base64").toString("utf8")), { personal: "Surfacing soon." });
  assert.equal(projectsPut.body.sha, "projects-sha");
  assert.deepEqual(JSON.parse(Buffer.from(projectsPut.body.content, "base64").toString("utf8")), { alpha: "paused", beta: "active" });
});

test("POST with an unrecognized status line is rejected and writes nothing", async () => {
  const { token, jwk } = await validToken();
  const puts = stubFetch({ jwk });
  const form = new URLSearchParams({ personal: "Made up status.", "project:alpha": "active", "project:beta": "active" });
  const req = new Request("https://darius.life/control/", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const res = await handleControlPost(req, ENV);
  assert.equal(res.status, 400);
  assert.equal(puts.length, 0);
});

test("POST missing a project's value is rejected and writes nothing", async () => {
  const { token, jwk } = await validToken();
  const puts = stubFetch({ jwk });
  const form = new URLSearchParams({ personal: "Heads down.", "project:alpha": "active" }); // beta missing
  const req = new Request("https://darius.life/control/", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const res = await handleControlPost(req, ENV);
  assert.equal(res.status, 400);
  assert.equal(puts.length, 0);
});

test("POST without a valid token is forbidden and never touches GitHub", async () => {
  let ghHit = false;
  globalThis.fetch = async () => {
    ghHit = true;
    throw new Error("should not be called");
  };
  const form = new URLSearchParams({ personal: "Heads down." });
  const req = new Request("https://darius.life/control/", { method: "POST", body: form.toString() });
  const res = await handleControlPost(req, ENV);
  assert.equal(res.status, 403);
  assert.equal(ghHit, false);
});

test("base64 helpers round-trip UTF-8 content", () => {
  const { decodeBase64Utf8, encodeBase64Utf8 } = _internal;
  const text = '{"personal":"Heads down."}\n— em dash too —\n';
  assert.equal(decodeBase64Utf8(encodeBase64Utf8(text)), text);
});
