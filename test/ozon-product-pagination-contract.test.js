import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOzonProductRefs, fetchOzonProductStocks, fetchOzonProductPrices } from '../src/ozonClient.js';
const shop = { id: 1, name: 'Fixture', ozon_client_id: 'fixture', ozon_api_key: 'fixture-key' };
const json = data => new Response(JSON.stringify(data));
function mock(t, fetch) { const original = globalThis.fetch;t.after(() => { globalThis.fetch = original; });globalThis.fetch = fetch; }
const calls = [
  ['product', '/v3/product/list', opts => fetchOzonProductRefs(shop, { visibilityFilters: ['ALL'], ...opts }), item => ({ result: item }), item => item.ozon_product_id],
  ['stock', '/v4/product/info/stocks', opts => fetchOzonProductStocks(shop, opts), item => item, item => item.ozon_product_id],
  ['price', '/v5/product/info/prices', opts => fetchOzonProductPrices(shop, opts), item => item, item => item.ozon_product_id]
];
for (const [name,path,run,envelope,identity] of calls) {
  test(`${name}: total_items-only pages and short pages retain both products`, async t => {
    const cursors = [];
    mock(t, async (url, options) => {
      assert.equal(new URL(url).pathname, path);
      const body = JSON.parse(options.body), cursor = body.last_id ?? body.cursor;cursors.push(cursor);
      return json(envelope({ items: [{ product_id: cursor ? 2 : 1, stocks: [{ type: 'fbs', present: 2, reserved: 0 }] }], total_items: 2, ...(name === 'product' ? { last_id: cursor ? '' : 'next' } : { cursor: cursor ? '' : 'next' }) }));
    });
    const result = await run({});assert.deepEqual(cursors, ['', 'next']);assert.deepEqual(result.map(identity), ['1','2']);
  });
  test(`${name}: new totals take precedence over old totals during transition`, async t => {
    mock(t, async () => json(envelope({ items: [{ product_id: 1, stocks: [{ type: 'fbs', present: 1, reserved: 0 }] }], total_items: 1, total: 999, cursor: '', last_id: '' })));
    assert.equal((await run({})).length, 1);
  });
  test(`${name}: total_items detects premature termination rather than accepting a partial result`, async t => {
    mock(t, async () => json(envelope({ items: [{ product_id: 1, stocks: [] }], total_items: 2, cursor: '', last_id: '' })));
    await assert.rejects(run({}), /分页提前结束/);
  });
}
test('price: a repeated cursor fails after two reads instead of an unbounded loop', async t => {
  let count = 0;
  mock(t, async () => { if (++count > 2) throw Error('Unbounded pagination');return json({ items: [{ product_id: 1 }], cursor: 'same' }); });
  await assert.rejects(fetchOzonProductPrices(shop), /分页未推进/);assert.equal(count, 2);
});
test('price: malformed row containers and numeric cursors fail explicitly', async t => {
  for (const data of [{}, { items: {} }, { items: [{ product_id: 1 }], cursor: 123 }]) {
    let reads = 0;mock(t, async () => { if (++reads > 2) throw Error('Unbounded pagination');return json(data); });await assert.rejects(fetchOzonProductPrices(shop), /价格.*(格式|分页)/);
  }
});
test('price: once mode preserves an explicit single-page read', async t => {
  let count = 0;mock(t, async () => { count++;return json({ items: [{ product_id: 1 }], total_items: 2, cursor: 'next' }); });
  assert.equal((await fetchOzonProductPrices(shop, { once: true })).length, 1);assert.equal(count, 1);
});
test('price: authorization callbacks are honored before and after every actual read', async t => {
  let before = 0, after = 0;const clients = [];
  mock(t, async (url, options) => { clients.push(options.headers['Client-Id']);return json({ items: [{ product_id: clients.length }], cursor: clients.length === 1 ? 'next' : '' }); });
  const rows = await fetchOzonProductPrices(shop, { beforeRequest: async () => ({ ...shop, ozon_client_id: String(++before) }), afterRequest: async () => { after++; } });
  assert.equal(rows.length, 2);assert.deepEqual(clients, ['1','2']);assert.equal(after, 2);
});
test('price: revocation after a page stops before another page', async t => {
  let count = 0;const denied = Object.assign(Error('revoked'), { statusCode: 403 });
  mock(t, async () => { if (++count > 2) throw Error('Unbounded pagination');return json({ items: [{ product_id: 1 }], cursor: 'next' }); });
  await assert.rejects(fetchOzonProductPrices(shop, { afterRequest: async () => { throw denied; } }), error => error === denied);assert.equal(count, 1);
});
test('price: legacy total remains accepted during migration', async t => {
  mock(t, async () => json({ items: [{ product_id: 1 }], total: 2, cursor: '' }));
  await assert.rejects(fetchOzonProductPrices(shop), /分页提前结束/);
});

test('price: an explicit resume cursor reads the remaining pages without comparing them with a whole-catalog total', async t => {
  mock(t, async (url, options) => { assert.equal(JSON.parse(options.body).cursor, 'saved');return json({ items: [{ product_id: 2 }], total_items: 10, cursor: '' }); });
  assert.equal((await fetchOzonProductPrices(shop, { cursor: 'saved' })).length, 1);
});
