// Runs under plain Node (Web Crypto is available since Node 20), not wrangler's
// Workers pool — this only exercises verifyAccessJwt/renderIndex, which use only
// Web Crypto and standard JS, so a Workers runtime isn't needed to test them for real.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "./index.js";

const { verifyAccessJwt } = _internal;

// Each test's stubbed fetch must actually be hit — the 5-minute certs cache is
// correct in production but would otherwise let one test's keys leak into the next.
beforeEach(() => _internal.resetCertsCacheForTests());

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

async function signJwt(privateKey, payload, { kid = KID, alg = "RS256" } = {}) {
  const headerB64 = jsonB64url({ alg, kid, typ: "JWT" });
  const payloadB64 = jsonB64url(payload);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data);
  return `${headerB64}.${payloadB64}.${b64url(new Uint8Array(sig))}`;
}

function stubCertsFetch(jwk) {
  globalThis.fetch = async (url) => {
    assert.equal(url, `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  };
}

const now = () => Math.floor(Date.now() / 1000);

test("accepts a validly signed, unexpired token for the right audience", async () => {
  const { privateKey, jwk } = await generateKeypair();
  stubCertsFetch(jwk);
  const token = await signJwt(privateKey, { aud: AUD, email: "michael@example.com", exp: now() + 3600 });
  const payload = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
  assert.equal(payload.email, "michael@example.com");
});

test("rejects a token signed by a different key (forged)", async () => {
  const { jwk } = await generateKeypair(); // published key
  const forged = await generateKeypair(); // attacker's own key, different kid claimed
  stubCertsFetch(jwk);
  const token = await signJwt(forged.privateKey, { aud: AUD, exp: now() + 3600 }, { kid: KID }); // claims the real kid
  await assert.rejects(() => verifyAccessJwt(token, TEAM_DOMAIN, AUD), /signature verification failed/);
});

test("rejects an expired token", async () => {
  const { privateKey, jwk } = await generateKeypair();
  stubCertsFetch(jwk);
  const token = await signJwt(privateKey, { aud: AUD, exp: now() - 10 });
  await assert.rejects(() => verifyAccessJwt(token, TEAM_DOMAIN, AUD), /expired/);
});

test("rejects a token for the wrong Access application (aud mismatch)", async () => {
  const { privateKey, jwk } = await generateKeypair();
  stubCertsFetch(jwk);
  const token = await signJwt(privateKey, { aud: "some-other-applications-aud", exp: now() + 3600 });
  await assert.rejects(() => verifyAccessJwt(token, TEAM_DOMAIN, AUD), /aud mismatch/);
});

test("rejects alg:none / non-RS256 tokens outright", async () => {
  const { privateKey, jwk } = await generateKeypair();
  stubCertsFetch(jwk);
  const token = await signJwt(privateKey, { aud: AUD, exp: now() + 3600 }, { alg: "none" });
  await assert.rejects(() => verifyAccessJwt(token, TEAM_DOMAIN, AUD), /unexpected alg/);
});

test("rejects a token whose payload was tampered with after signing", async () => {
  const { privateKey, jwk } = await generateKeypair();
  stubCertsFetch(jwk);
  const token = await signJwt(privateKey, { aud: AUD, exp: now() + 3600, email: "michael@example.com" });
  const [h, , s] = token.split(".");
  const tamperedPayload = jsonB64url({ aud: AUD, exp: now() + 3600, email: "attacker@example.com" });
  await assert.rejects(() => verifyAccessJwt(`${h}.${tamperedPayload}.${s}`, TEAM_DOMAIN, AUD), /signature verification failed/);
});

test("rejects a structurally malformed token", async () => {
  await assert.rejects(() => verifyAccessJwt("not-a-jwt", TEAM_DOMAIN, AUD), /malformed/);
});

test("rejects when no key matches the token's kid", async () => {
  const { privateKey, jwk } = await generateKeypair();
  stubCertsFetch({ ...jwk, kid: "a-different-kid" });
  const token = await signJwt(privateKey, { aud: AUD, exp: now() + 3600 });
  await assert.rejects(() => verifyAccessJwt(token, TEAM_DOMAIN, AUD), /unknown signing key/);
});
