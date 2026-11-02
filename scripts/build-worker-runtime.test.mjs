import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildWorkerRuntime } from './build-worker-runtime.mjs';
import { storageBinding } from '../workers/shared/storage-service-proxy.mjs';

test('both authored Workers build with the existing provider bridge and distinct front door', async () => {
  for (const name of ['private-legal', 'confidential']) {
    const result = await buildWorkerRuntime(name);
    assert(result.bridgedUses >= 2);
    for (const file of ['index.js', 'storage-options.mjs', 'storage-service-proxy.mjs', 'storage-wire.mjs']) assert(result.modules.some(m => m.name === file));
    assert.equal(result.modules.some(m => m.name === 'bench-frontdoor.mjs'), name === 'confidential');
    const code = await fs.readFile(new URL(`../workers/${name}/dist/index.js`, import.meta.url), 'utf8');
    assert(code.includes('import {storageBinding as __posterityStorageBinding}'));
    assert(!code.includes(`env.${result.storageBinding}`));
  }
});
test('the current native R2 binding remains the identical object', () => {
  const native = {};
  assert.equal(storageBinding({ PRIVATE_LEGAL: native, POSTERITY_STORAGE_PROVIDER: 'r2' }, 'PRIVATE_LEGAL', 'darius-life-private'), native);
});
test('an unsupported or incomplete provider never falls back silently', () => {
  for (const provider of ['unknown', 'dropbox']) assert.throws(() => storageBinding({ POSTERITY_STORAGE_PROVIDER: provider }, 'PRIVATE_LEGAL', 'darius-life-private'), /storage_configuration/);
});
