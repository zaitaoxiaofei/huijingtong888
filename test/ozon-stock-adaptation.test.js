import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOzonProductRefs, fetchOzonProductStocks, filterPendingListingProductsWithoutFbsStock, pendingListingVisibilityFilters, updateOzonProductStocks } from '../src/ozonClient.js';
import { ozonStockUpdateReceipts } from '../src/services/ozon-stock-update.js';

const shop = { id: 1, ozon_client_id: 'fixture-client', ozon_api_key: 'fixture-key' };
const json = data => new Response(JSON.stringify(data));
function mock(t, handler) { const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; }); globalThis.fetch = handler; }

test('pending fallback recalls zero stock outside old visibility buckets and preserves identified no-SKU records', async t => {
  mock(t, async (_url, options) => json({ result: { items: JSON.parse(options.body).filter.visibility === 'ALL' ? [{ product_id: 11, offer_id: 'new-zero' }] : [], last_id: '' } }));
  const refs = await fetchOzonProductRefs(shop, { visibilityFilters: pendingListingVisibilityFilters() });
  assert.deepEqual(refs.map(row => row.id), [11]);
  const products = [
    { ozon_product_id: '11', offer_id: 'new-zero', stocks_json: '{"has_stock":false,"stocks":[]}' },
    { ozon_product_id: '12', offer_id: 'unknown' },
    { ozon_product_id: '13', offer_id: 'archived', archived: 1, stocks_json: '{"has_stock":false}' },
    { ozon_product_id: '14', offer_id: 'stocked', stocks_json: '{"stocks":[{"type":"fbs","present":8}]}' }
  ];
  assert.deepEqual(filterPendingListingProductsWithoutFbsStock(products, [], { requireSku: false, requireStockEvidence: true }).map(row => row.offer_id), ['new-zero']);
  assert.deepEqual(filterPendingListingProductsWithoutFbsStock([{ ozon_product_id: '15', offer_id: 'fbs-zero' }], [{
    ozon_product_id: '15', stock_type: 'fbs_virtual', present: 0, available: 0, raw_json: '{"type":"fbs","present":0}'
  }], { requireSku: false, requireStockEvidence: true }).map(row => row.offer_id), ['fbs-zero']);
  for (const present of ['unknown', null, -1, ' ', false]) {
    const row = { ozon_product_id: '21', offer_id: 'bad-quantity', stocks_json: JSON.stringify({ stocks: [{ type: 'fbs', present }] }) };
    assert.deepEqual(filterPendingListingProductsWithoutFbsStock([row], [], { requireSku: false, requireStockEvidence: true }), []);
    const mixed = { ...row, stocks_json: JSON.stringify({ stocks: [{ type: 'fbs', present, available: 0 }] }) };
    assert.deepEqual(filterPendingListingProductsWithoutFbsStock([mixed], [], { requireSku: false, requireStockEvidence: true }), []);
    const contradictory = { ...row, stocks_json: JSON.stringify({ has_stock: false, stocks: [{ type: 'fbs', present }] }) };
    assert.deepEqual(filterPendingListingProductsWithoutFbsStock([contradictory], [], { requireSku: false, requireStockEvidence: true }), []);
  }
  assert.deepEqual(filterPendingListingProductsWithoutFbsStock([{ ozon_product_id: '22', offer_id: 'multi-warehouse' }], [
    { ozon_product_id: '22', stock_type: 'fbs_virtual', present: 0, available: 0, raw_json: '{"type":"fbs","present":0}' },
    { ozon_product_id: '22', stock_type: 'fbs_virtual', present: 0, available: 0, raw_json: '{"type":"fbs","present":"unknown"}' }
  ], { requireSku: false, requireStockEvidence: true }), []);
});

test('stock pages follow cursor across short pages, accept total_items, and reject loops or premature completion', async t => {
  const cursors = [];
  mock(t, async (_url, options) => {
    const cursor = JSON.parse(options.body).cursor; cursors.push(cursor);
    return json({ items: [{ product_id: cursor ? 2 : 1, stocks: [] }], total_items: 2, cursor: cursor ? '' : 'next' });
  });
  assert.deepEqual((await fetchOzonProductStocks(shop)).map(row => row.ozon_product_id), ['1', '2']);
  assert.deepEqual(cursors, ['', 'next']);
  globalThis.fetch = async () => json({ items: [{ product_id: 1, stocks: [] }], cursor: 'loop' });
  await assert.rejects(fetchOzonProductStocks(shop), /分页未推进/);
  globalThis.fetch = async () => json({ items: [{ product_id: 1, stocks: [] }], cursor: '', total_items: 2 });
  await assert.rejects(fetchOzonProductStocks(shop), /分页提前结束/);
  globalThis.fetch = async () => json({});
  await assert.rejects(fetchOzonProductStocks(shop), /格式已变化/);
  await assert.rejects(fetchOzonProductRefs(shop, { visibilityFilters: ['ALL'] }), /格式已变化/);
});

test('inventory receipts reject missing, duplicate, mismatched, errored and unconfirmed target results', () => {
  const target = { product_id: 11, offer_id: 'one', warehouse_id: 22, stock: 0 };
  const accepted = { ...target, updated: true, errors: [] };
  assert.equal(ozonStockUpdateReceipts([target], { result: [accepted] })[0].accepted, true);
  for (const rows of [[], [null], [accepted, accepted], [{ ...accepted, warehouse_id: 33 }], [{ ...accepted, offer_id: 'other' }], [{ ...accepted, updated: false }], [{ ...accepted, errors: [null] }], [{ ...accepted, errors: [{ code: 'PRODUCT_IS_ARCHIVED', message: 'Archived' }] }], [{ ...accepted, errors: undefined }]]) {
    const receipt = ozonStockUpdateReceipts([target], { result: rows })[0];
    assert.equal(receipt.accepted, false); assert.ok(receipt.errors.length);
  }
  assert.equal(ozonStockUpdateReceipts([target], null)[0].accepted, false);
});

test('stock writes use 100-item batches, keep zero, and refresh authority before every request', async t => {
  const calls = []; let checks = 0;
  mock(t, async (url, options) => {
    const stocks = JSON.parse(options.body).stocks; calls.push({ url, stocks });
    return json({ result: stocks.map(row => ({ ...row, updated: true, errors: [] })) });
  });
  const stocks = Array.from({ length: 201 }, (_, i) => ({ offer_id: `offer-${i}`, product_id: i + 1, warehouse_id: 22, stock: 0 }));
  const response = await updateOzonProductStocks(shop, stocks, { beforeRequest: async () => { checks++; return shop; } });
  assert.deepEqual(calls.map(row => row.stocks.length), [100, 100, 1]);
  assert.equal(checks, 3); assert.equal(response.result.length, 201);
  assert.ok(response.result.every(row => row.updated === true && row.stock === 0));
});

test('stock writes preserve a partial rejection and never let zero-then-archive continue after rejection', async t => {
  mock(t, async (_url, options) => json({ result: JSON.parse(options.body).stocks.map((row, i) => ({ ...row, updated: i === 0, errors: i === 0 ? [] : [{ code: 'PRODUCT_IS_ARCHIVED', message: 'Product is archived' }] })) }));
  const targets = [1, 2].map(product_id => ({ product_id, warehouse_id: 22, stock: 0 }));
  const response = await updateOzonProductStocks(shop, targets, { allowPartialResults: true });
  assert.deepEqual(response.result.map(row => row.updated), [true, false]);
  await assert.rejects(updateOzonProductStocks(shop, targets), /Product is archived/);
});

test('invalid stock values fail before requests and cancelled batches cannot send', async t => {
  let requests = 0; mock(t, async () => { requests++; return json({}); });
  for (const stock of [-1, 1.5, NaN, Infinity]) await assert.rejects(updateOzonProductStocks(shop, [{ product_id: 1, warehouse_id: 22, stock }]), /整数库存/);
  const controller = new AbortController(); controller.abort(new Error('cancel fixture'));
  await assert.rejects(updateOzonProductStocks(shop, [{ product_id: 1, warehouse_id: 22, stock: 0 }], { signal: controller.signal }), /cancel fixture/);
  assert.equal(requests, 0);
});

test('later forbidden request or response-return revocation preserves earlier acceptance and stops remaining writes', async t => {
  const targets = Array.from({ length: 201 }, (_, i) => ({ product_id: i + 1, warehouse_id: 22, stock: 0 }));
  let calls = 0;
  mock(t, async (_url, options) => {
    calls++;
    return calls === 2 ? new Response('{"message":"forbidden fixture"}', { status: 403 })
      : json({ result: JSON.parse(options.body).stocks.map(row => ({ ...row, updated: true, errors: [] })) });
  });
  await assert.rejects(updateOzonProductStocks(shop, targets, { allowPartialResults: true }), error => {
    assert.equal(error.statusCode, 403); assert.equal(error.stockResponse.result.length, 100);
    assert.ok(error.stockResponse.result.every(row => row.updated)); return true;
  });
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async (_url, options) => { calls++; return json({ result: JSON.parse(options.body).stocks.map(row => ({ ...row, updated: true, errors: [] })) }); };
  await assert.rejects(updateOzonProductStocks(shop, targets, { allowPartialResults: true, afterRequest: async () => { throw Object.assign(new Error('revoked fixture'), { statusCode: 403 }); } }), error => {
    assert.equal(error.stockResponse.result.length, 100); assert.ok(error.stockResponse.result.every(row => row.updated)); return true;
  });
  assert.equal(calls, 1);
  calls = 0;
  const controller = new AbortController();
  await assert.rejects(updateOzonProductStocks(shop, targets, {
    allowPartialResults: true, signal: controller.signal, afterRequest: async () => { controller.abort(new Error('between batches fixture')); }
  }), error => {
    assert.match(error.message, /between batches/); assert.equal(error.stockResponse.result.length, 100);
    assert.ok(error.stockResponse.result.every(row => row.updated)); return true;
  });
  assert.equal(calls, 1);
});
