import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiCreditRuntime } from '../src/services/ai-credit-runtime.js';

test('a queued task with changed identity is denied before wallet or provider access', async () => {
  const session = { personId: 9, tenant: { id: 42, slug: 'customer-a' } };
  for (const current of [null, { ...session, personId: 8 }, { ...session, tenant: { id: 43, slug: 'customer-b' } }]) {
    let reads = 0, writes = 0;
    const runtime = createAiCreditRuntime({ query: async () => { reads++; return []; }, transaction: async () => { writes++; throw new Error('Must not write'); }, resultStore: {}, authorize: async () => current });
    await assert.rejects(runtime.execute(session, { kind: 'image', capability: 'image', idempotencyKey: 'saved-task', payload: {}, provider: {} }), { code: 'AI_CREDIT_FORBIDDEN' });
    assert.equal(reads, 0); assert.equal(writes, 0);
  }
});
