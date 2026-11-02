import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const baselines = JSON.parse(await fs.readFile(new URL('../workers/deployment-baselines.json', import.meta.url), 'utf8'));

export async function verifyWorkerBaseline(name, { accountId, token, fetcher = fetch }) {
  const expected = baselines[name];
  if (!expected || !/^[a-f0-9]{32}$/.test(accountId ?? '') || !token) throw new Error('Worker baseline configuration is missing');
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${expected.name}`;
  const get = async suffix => {
    const r = await fetcher(base + suffix, { redirect: 'error', headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Worker baseline read refused: HTTP ${r.status}`);
    const body = await r.json();
    if (!body.success || !body.result) throw new Error('Worker baseline response did not verify');
    return body.result;
  };
  const [deployments, settings] = await Promise.all([get('/deployments?per_page=1'), get('/settings')]);
  const versions = deployments.deployments?.[0]?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0].version_id !== expected.version || versions[0].percentage !== 100) {
    throw new Error('Production Worker changed; reconcile its current source and receipt before deployment');
  }
  if (settings.compatibility_date !== expected.compatibility_date || (settings.compatibility_flags ?? []).length) throw new Error('Worker runtime settings changed');
  const bindings = new Map((settings.bindings ?? []).map(b => [b.name, b]));
  for (const secret of expected.secrets) {
    if (bindings.get(secret)?.type !== 'secret_text') throw new Error(`Required existing secret binding is missing: ${secret}`);
  }
  for (const [binding, fields] of Object.entries(expected.bindings)) {
    const actual = bindings.get(binding);
    if (!actual || Object.entries(fields).some(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value))) throw new Error(`Worker binding changed: ${binding}`);
  }
  if ([...bindings.values()].some(b => b.type !== 'secret_text' && !Object.hasOwn(expected.bindings, b.name))) throw new Error('Worker has a newer binding; preserve it before deployment');
  return { name: expected.name, version: expected.version, verified: true, secrets: 'existing bindings retained; values not retrieved' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyWorkerBaseline(process.argv[2], {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN,
  })));
}
