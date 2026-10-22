import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOzonProductRefs, fetchOzonProducts } from '../src/ozonClient.js';
const shop = { id: 1, name: 'Fixture', ozon_client_id: 'fixture', ozon_api_key: 'fixture-key' };
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('product pagination and details resolve fresh shop credentials before every request', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  let before = 0, after = 0;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname, body = JSON.parse(options.body);
    calls.push({ path, body, client: options.headers['Client-Id'] });
    return path === '/v3/product/list'
      ? json({ result: { items: [{ product_id: body.last_id ? 102 : 101 }], last_id: body.last_id ? '' : 'next' } })
      : json({ items: body.product_id.map(id => ({ id, sku: id + 1000 })) });
  };
  const rows = await fetchOzonProducts(shop, { visibilityFilters: ['EMPTY_STOCK'],
    beforeRequest: async () => ({ ...shop, ozon_client_id: String(++before) }), afterRequest: async () => { after++; } });
  assert.equal(rows.length, 2); assert.equal(before, 3); assert.equal(after, 3);
  assert.deepEqual(calls.map(row => row.client), ['1', '2', '3']);
});

test('revocation after a returned page prevents later pages and detail requests', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; }); let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ result: { items: [{ product_id: 101 }], last_id: 'next' } }); };
  const denied = Object.assign(new Error('Membership revoked'), { statusCode: 403 });
  await assert.rejects(fetchOzonProducts(shop, { visibilityFilters: ['EMPTY_STOCK'], afterRequest: async () => { throw denied; } }), error => error === denied);
  assert.equal(calls, 1);
});

test('repeated product cursors fail explicitly instead of spinning forever', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; }); let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ result: { items: [{ product_id: 101 }], last_id: 'same' } }); };
  await assert.rejects(fetchOzonProductRefs(shop, { visibilityFilters: ['EMPTY_STOCK'] }), /重复分页游标/);
  assert.equal(calls, 2);
});

test('cancelled product pulls do not send an initial page', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; }); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unreachable'); };
  const controller = new AbortController(); controller.abort(new Error('Cancelled'));
  await assert.rejects(fetchOzonProductRefs(shop, { visibilityFilters: ['EMPTY_STOCK'], signal: controller.signal }), /Cancelled/);
  assert.equal(calls, 0);
});
