import test from 'node:test';
import assert from 'node:assert/strict';
import { isChallenge, resolveLink } from './lib.mjs';

const block = '<title>Attention Required! | Cloudflare</title><link href="/cdn-cgi/styles/cf.errors.css"><div id="cf-wrapper"></div>';
const response = (body, status = 403, headers = { server: 'envoy' }) => new Response(body, { status, headers });

test('recognizes the explicit Cloudflare block page through a proxy', async () => {
  assert.equal(await isChallenge(response(block)), true);
});
test('a bare proxy 403 remains a failure', async () => {
  assert.equal(await isChallenge(response('Forbidden')), false);
});
test('mentioning Cloudflare alone is not a challenge', async () => {
  assert.equal(await isChallenge(response('<p>Cloudflare returned an error.</p>')), false);
});
test('the title alone is insufficient through a proxy', async () => {
  assert.equal(await isChallenge(response('<title>Attention Required! | Cloudflare</title>')), false);
});
test('the stylesheet and wrapper alone are insufficient', async () => {
  assert.equal(await isChallenge(response('<link href="/cdn-cgi/styles/cf.errors.css"><div id="cf-wrapper"></div>')), false);
});
test('a successful page is never classified from this markup', async () => {
  assert.equal(await isChallenge(response(block, 200)), false);
});
test('preserves the provider challenge header contract', async () => {
  assert.equal(await isChallenge(response('', 403, { 'cf-mitigated': 'challenge' })), true);
});
test('preserves direct Cloudflare challenge detection', async () => {
  assert.equal(await isChallenge(response('<title>Just a moment...</title>', 503, { server: 'cloudflare' })), true);
});
test('classified challenges still require independent link verification', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => response(block);
  try {
    assert.equal((await resolveLink('https://example.com/')).ok, false);
    let verified = 0;
    const result = await resolveLink('https://example.com/', { onChallenge: async url => {
      verified++;
      return { url, ok: true, note: 'Constructed independent evidence' };
    }});
    assert.equal(verified, 1);
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = previous;
  }
});
