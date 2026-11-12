import assert from 'node:assert/strict';
import test from 'node:test';
import { createOzonPromotionRequestQueue } from '../src/services/ozon-promotion-request-queue.js';

function fixture() {
  let time = 0; const waits = [];
  return { waits, now: () => time, run: createOzonPromotionRequestQueue({ now: () => time, wait: async ms => { waits.push(ms); time += ms; } }) };
}
test('interactive and background promotion pages share one per-client read queue', async () => {
  const f = fixture(), calls = [];
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.run('A', i % 2 ? '/v2/actions/products' : '/v2/actions/candidates', async () => calls.push(f.now()))));
  assert.equal(calls.length, 12);
  assert.ok(calls.slice(1).every((at, i) => at - calls[i] >= 1100));
});
test('429 reads honor Retry-After and retry only the failed page with bounded backoff', async () => {
  const f = fixture(); let attempts = 0;
  const result = await f.run('A', '/v2/actions/products', async () => {
    if (++attempts < 3) throw Object.assign(new Error('limited'), { status: 429, retryAfterMs: 6000 });
    return 'page-two';
  });
  assert.equal(result, 'page-two'); assert.equal(attempts, 3);
  assert.deepEqual(f.waits, [0, 6000, 6000]);
});
test('rate limit retries stop after three attempts, but later reads can recover', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(f.run('A', '/v2/actions/products', async () => { calls++; throw Error('You have reached request rate limit per second'); }), /rate limit/);
  assert.equal(calls, 3); assert.equal(await f.run('A', '/v2/actions/products', async () => 'ok'), 'ok');
});
test('enrollment, price and removal writes are never retried or queued by the read limiter', async () => {
  for (const path of ['/v1/actions/products/update', '/v2/actions/products/deactivate', '/v1/seller-actions/products/add']) {
    const f = fixture(); let calls = 0;
    await assert.rejects(f.run('A', path, async () => { calls++; throw Object.assign(Error('limited'), { status: 429 }); }));
    assert.equal(calls, 1); assert.equal(f.waits.length, 0);
  }
});
test('permission errors stop immediately and cancellation blocks a queued read', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(f.run('A', '/v2/actions/products', async () => { calls++; throw Object.assign(Error('revoked'), { status: 403 }); }), /revoked/);
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(f.run('A', '/v2/actions/products', async () => calls++, { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 1);
});
test('a blocked shop does not hold another shop queue', async () => {
  const f = fixture(); let finish;
  const first = f.run('A', '/v2/actions/products', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(await f.run('B', '/v2/actions/products', async () => 'B'), 'B');
  finish('A'); assert.equal(await first, 'A');
});

// Exercise the production request wrapper and its permission refresh without a
// live MySQL or any real Ozon mutation.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const actionSource = readFileSync(new URL('../src/services/ozon-actions.js', import.meta.url), 'utf8');
function transportFixture({ write = false, revoke = false } = {}) {
  const f = fixture(); const calls = []; let authorizations = 0;
  const context = vm.createContext({ AbortController, setTimeout, clearTimeout, Date, Number, Math, JSON, Error,
    OZON_API_BASE: 'https://api-seller.ozon.ru', OZON_REQUEST_TIMEOUT_MS: 30000,
    runPromotionRequest: f.run,
    readShop: async id => {
      authorizations++;
      if (revoke && authorizations > 1) throw Object.assign(Error('permission revoked'), { status: 403 });
      return { id, clientId: 'fixture-client' };
    },
    ozonHeaders: () => ({}),
    statusError: (message, status) => Object.assign(Error(message), { status }),
    fetch: async (url, options) => {
      calls.push({ path: new URL(url).pathname, body: options.body });
      return new Response(JSON.stringify(calls.length === 1 || write ? { message: 'limited' } : { products: [] }),
        { status: calls.length === 1 || write ? 429 : 200, headers: { 'retry-after': '4' } });
    }
  });
  for (const name of ['ozonRequest', 'ozonRequestOnce']) {
    vm.runInContext(actionSource.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'))[0], context);
  }
  return { context, calls, f, checks: () => authorizations };
}
test('production read transport preserves the cursor and Retry-After on a retried page', async () => {
  const h = transportFixture();
  await h.context.ozonRequest('/v2/actions/products', { shop: { id: 7, clientId: 'fixture-client' }, payload: { action_id: 123, last_id: 'page-11' } });
  assert.equal(h.checks(), 2); assert.deepEqual(h.calls.map(c => JSON.parse(c.body).last_id), ['page-11', 'page-11']);
  assert.deepEqual(h.f.waits, [0, 4000]);
});
test('production transport rechecks permission before retrying and never continues a revoked read', async () => {
  const h = transportFixture({ revoke: true });
  await assert.rejects(h.context.ozonRequest('/v2/actions/products', { shop: { id: 7 } }), /permission revoked/);
  assert.equal(h.checks(), 2); assert.equal(h.calls.length, 1);
});
test('production write transport reports a 429 after one mutation request', async () => {
  const h = transportFixture({ write: true });
  await assert.rejects(h.context.ozonRequest('/v1/actions/products/update', { shop: { id: 7 }, payload: { products: [] } }), /limited/);
  assert.equal(h.calls.length, 1); assert.equal(h.f.waits.length, 0);
});
