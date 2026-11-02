import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { verifyWorkerBaseline } from './verify-worker-baseline.mjs';

const all = JSON.parse(await fs.readFile(new URL('../workers/deployment-baselines.json', import.meta.url)));
const config = { accountId: 'a'.repeat(32), token: 'constructed-test-token' };
function setup(change = () => {}) {
  const expected = all['private-legal'];
  const data = { deployments: [{ versions: [{ version_id: expected.version, percentage: 100 }] }], compatibility_date: expected.compatibility_date,
    bindings: [...Object.entries(expected.bindings).map(([name, fields]) => ({ name, ...fields })), ...expected.secrets.map(name => ({ name, type: 'secret_text' }))] };
  change(data);
  const calls = [];
  return { calls, fetcher: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ success: true, result: url.includes('/deployments') ? { deployments: data.deployments } : data });
  } };
}
test('checks the exact working baseline with read-only requests and no secret values', async () => {
  const s = setup();
  const result = await verifyWorkerBaseline('private-legal', { ...config, fetcher: s.fetcher });
  assert.equal(result.verified, true);
  assert.equal(s.calls.length, 2);
  assert(s.calls.every(c => c.options.method === undefined && c.options.redirect === 'error'));
  assert(!JSON.stringify(result).includes(config.token));
});
for (const [name, change] of [
  ['newer deployed version', d => d.deployments[0].versions[0].version_id = 'newer'],
  ['split rollout', d => d.deployments[0].versions.push({ version_id: 'other', percentage: 5 })],
  ['changed storage provider', d => d.bindings.find(b => b.name === 'POSTERITY_STORAGE_PROVIDER').text = 'dropbox'],
  ['missing existing secret', d => d.bindings = d.bindings.filter(b => b.name !== 'GH_COMMIT_TOKEN')],
  ['new approved binding', d => d.bindings.push({ name: 'NEW_SERVICE', type: 'service', service: 'newer' })],
  ['runtime compatibility change', d => d.compatibility_date = '2026-11-01'],
]) test(`refuses ${name} before any write`, async () => {
  const s = setup(change);
  await assert.rejects(verifyWorkerBaseline('private-legal', { ...config, fetcher: s.fetcher }));
  assert(s.calls.every(c => c.options.method === undefined));
});
test('a refused provider read cannot become baseline acceptance', async () => {
  await assert.rejects(verifyWorkerBaseline('private-legal', { ...config, fetcher: async () => new Response('', { status: 403 }) }), /refused/);
});
