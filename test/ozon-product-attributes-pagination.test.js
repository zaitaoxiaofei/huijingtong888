import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOzonProductInfoAttributes } from '../src/ozonClient.js';

const shop = { id: 7, ozon_client_id: 'fixture-client', ozon_api_key: 'fixture-key' };
const row = id => ({ id, offer_id: `offer-${id}`, sku: String(id + 1000), attributes: [] });
function mock(t, reply) {
  const original = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    const call = { url: String(url), body: JSON.parse(options.body), headers: options.headers };
    calls.push(call);
    return reply(call, calls.length);
  };
  return calls;
}
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'retry-after': '0' } });

test('attributes v4 reads short intermediate pages and string total without losing products', async t => {
  const calls = mock(t, (_call, n) => response({ result: [row(n)], last_id: n === 1 ? 'next' : 'last-row', total: '2' }));
  const rows = await fetchOzonProductInfoAttributes(shop, { offerIds: ['offer-1', 'offer-2'], limit: 100 });
  assert.deepEqual(rows.map(r => r.id), [1, 2]);
  assert.deepEqual(calls.map(c => c.body.last_id), ['', 'next']);
  assert.ok(calls.every(c => c.url.endsWith('/v4/product/info/attributes')));
  assert.deepEqual(calls[0].body, { filter: { offer_id: ['offer-1', 'offer-2'] }, limit: 100, last_id: '', sort_dir: 'asc' });
});

test('attributes accepts the existing nested items envelope and ends at an empty final page', async t => {
  const calls = mock(t, (_c, n) => response({ result: { items: n === 1 ? [row(1)] : [], last_id: n === 1 ? 'cursor' : '' } }));
  assert.equal((await fetchOzonProductInfoAttributes(shop, { productIds: [1] })).length, 1);
  assert.equal(calls.length, 2);
});

test('attributes empty success remains distinct from an invalid response', async t => {
  mock(t, () => response({ result: [], total: '0', last_id: '' }));
  assert.deepEqual(await fetchOzonProductInfoAttributes(shop, { productIds: [1] }), []);
});

for (const [name, pages, expected] of [
  ['missing array', [{ result: {} }], /格式已变化/],
  ['missing product identity', [{ result: [{ attributes: [] }] }], /缺少商品编号/],
  ['repeated cursor', [{ result: [row(1)], last_id: 'a' }, { result: [row(2)], last_id: 'a' }], /未推进/],
  ['cursor cycle', [{ result: [row(1)], last_id: 'a' }, { result: [row(2)], last_id: 'b' }, { result: [row(3)], last_id: 'a' }], /未推进/],
  ['repeated product', [{ result: [row(1)], last_id: 'a' }, { result: [row(1)] }], /重复/],
  ['empty intermediate page', [{ result: [], last_id: 'a', total: '1' }], /未推进/],
  ['non-string cursor', [{ result: [row(1)], last_id: 123 }], /游标格式/],
  ['early termination', [{ result: [row(1)], total: '2', last_id: '' }], /提前结束/],
  ['missing later total with incomplete data', [{ result: [row(1)], total: '3', last_id: 'a' }, { result: [row(2)] }], /提前结束/],
  ['changed total', [{ result: [row(1)], total: '3', last_id: 'a' }, { result: [row(2)], total: '2' }], /总数在读取期间发生变化/],
  ['invalid total', [{ result: [row(1)], total: 'invalid' }], /总数异常/],
  ['count exceeds total', [{ result: [row(1)], total: '0' }], /总数异常/]
]) {
  test(`attributes rejects ${name} rather than returning a partial list`, async t => {
    const calls = mock(t, (_c, n) => response(pages[n - 1]));
    await assert.rejects(fetchOzonProductInfoAttributes(shop, { productIds: [1, 2, 3] }), expected);
    assert.equal(calls.length, pages.length);
  });
}

for (const status of [403, 404, 429]) {
  test(`attributes ${status} never probes the undocumented legacy attributes endpoint`, async t => {
    const calls = mock(t, () => response({ message: 'provider rejected request' }, status));
    await assert.rejects(fetchOzonProductInfoAttributes(shop, { productIds: [1] }), error => error.statusCode === status);
    assert.ok(calls.length > 0 && calls.length <= 3);
    assert.ok(calls.every(c => c.url.endsWith('/v4/product/info/attributes')));
  });
}

test('attributes refreshes credentials per page and checks scope after each response', async t => {
  const calls = mock(t, (_c, n) => response({ result: [row(n)], total: '2', last_id: 'next' }));
  let guards = 0, after = 0;
  await fetchOzonProductInfoAttributes(shop, { productIds: [1, 2], beforeRequest: async () => ({ ...shop, ozon_api_key: `rotated-${++guards}` }), afterRequest: async () => { after++; } });
  assert.deepEqual(calls.map(c => c.headers['Api-Key']), ['rotated-1', 'rotated-2']);
  assert.equal(after, 2);
});

test('attributes cannot return data or request another page after scope revocation', async t => {
  const calls = mock(t, () => response({ result: [row(1)], total: '2', last_id: 'next' }));
  await assert.rejects(fetchOzonProductInfoAttributes(shop, { productIds: [1, 2], afterRequest: async () => { throw Error('scope revoked'); } }), /scope revoked/);
  assert.equal(calls.length, 1);
});

test('attributes cancellation stops pagination without returning the collected prefix', async t => {
  const abort = new AbortController();
  const calls = mock(t, () => response({ result: [row(1)], total: '2', last_id: 'next' }));
  await assert.rejects(fetchOzonProductInfoAttributes(shop, { productIds: [1, 2], signal: abort.signal, afterRequest: async () => abort.abort(Error('cancelled')) }), /cancelled/);
  assert.equal(calls.length, 1);
});
