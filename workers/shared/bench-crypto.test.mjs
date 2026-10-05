import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession } from './bench-crypto.js';

test('malformed or expired cookies fail closed without exceptions', async () => {
  for (const token of [null, '', '.', 'a.%%%%', 'a.a', 'a.a.a', '====.====', 'one.\nsecond', {}]) assert.equal(await verifySession(token, 'test-secret'), null);
  assert.equal(await verifySession(await signSession({gid:'grant'},'test-secret',-1),'test-secret'),null);
  const token=await signSession({gid:'grant'},'test-secret',60);
  assert.equal((await verifySession(token,'test-secret')).gid,'grant');
  assert.equal(await verifySession(token,'wrong-secret'),null);
  assert.equal(await verifySession(token,undefined),null);
});
