import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitions = {
  'private-legal': { binding: 'PRIVATE_LEGAL', frontdoor: false },
  confidential: { binding: 'BENCH_DOCUMENTS', frontdoor: true },
};

export async function buildWorkerRuntime(name) {
  const definition = definitions[name];
  if (!definition) throw new Error('Unknown Worker runtime');
  const worker = path.join(root, 'workers', name);
  const output = path.join(worker, 'dist');
  const result = await build({
    absWorkingDir: worker, entryPoints: ['src/index.js'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', keepNames: true,
    legalComments: 'eof', write: false,
    external: definition.frontdoor ? ['./bench-frontdoor.mjs'] : [],
  });
  let code = result.outputFiles[0].text;
  const needle = `env.${definition.binding}`;
  const count = code.split(needle).length - 1;
  if (!count) throw new Error('Required storage binding was not compiled');
  // Retain the deployed provider bridge; its current r2 setting stays authoritative.
  code = `import {storageBinding as __posterityStorageBinding} from './storage-service-proxy.mjs';\n`
    + code.split(needle).join(`__posterityStorageBinding(env,"${definition.binding}","darius-life-private")`);
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'index.js'), code);
  const names = ['storage-options.mjs', 'storage-service-proxy.mjs', 'storage-wire.mjs'];
  for (const module of names) await fs.copyFile(path.join(root, 'workers/shared', module), path.join(output, module));
  if (definition.frontdoor) {
    names.push('bench-frontdoor.mjs');
    await fs.copyFile(path.join(worker, 'src/bench-frontdoor.mjs'), path.join(output, 'bench-frontdoor.mjs'));
  }
  const modules = [];
  for (const module of ['index.js', ...names].sort()) {
    const bytes = await fs.readFile(path.join(output, module));
    modules.push({ name: module, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { worker: name, storageBinding: definition.binding, bridgedUses: count, modules };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildWorkerRuntime(process.argv[2]), null, 2));
}
