import test from 'node:test';
import assert from 'node:assert/strict';
import { createWbStockManagement } from '../src/services/wb-stock-management.js';
import { createWbRoutes } from '../src/server/routes/wb.js';
import { wbRoutePermission } from '../src/server/wb-paths.js';

function fixture({ missing = false, writeError, malformed = false, noReadback = false } = {}) {
  const requests = [], queries = [], remote = new Map([[201, 7], [202, 0]]);
  let wrote = false;
  const service = createWbStockManagement({
    account: async (tenant, shop) => { if (tenant !== 2 || shop !== 13) throw Object.assign(Error('foreign shop'), { statusCode: 404 }); return { tenant_id: 2, shop_id: 13, wb_warehouse_id: 100 }; },
    query: async (sql, params) => { queries.push({ sql, params }); return [{ nm_id: 101, raw_json: { sizes: [{ chrtID: 201 }, { chrtID: 202 }] } }]; },
    request: async (a, service, path, options = {}) => {
      requests.push({ path, ...options });
      if (path === '/api/v3/warehouses') return [{ id: 100 }, { id: 101 }];
      if (options.method === 'PUT') { wrote = true; if (writeError) throw writeError; for (const row of options.body.stocks) remote.set(row.chrtId, row.amount); return {}; }
      if (wrote && noReadback) throw Error('readback failed');
      return malformed ? {} : { stocks: missing ? [] : [...remote].map(([chrtId, amount]) => ({ chrtId, amount })) };
    }
  });
  const input = { shop_id: 13, warehouse_id: 101, items: [{ nm_id: 101, chrt_id: 201, quantity: 20, current: 7 }, { nm_id: 101, chrt_id: 202, quantity: 0, current: 0 }] };
  return { service, input, requests, queries, remote };
}
test('manual WB batch updates selected seller warehouse with native chrtId and readback, without local binding or ledger writes', async () => {
  const f = fixture(), result = await f.service.setStockBatch(2, f.input);
  assert.equal(result.ok, true); assert.deepEqual(result.rows.map(row => row.status), ['success', 'success']);
  assert.deepEqual(f.requests.find(r => r.method === 'PUT'), { path: '/api/v3/stocks/101', method: 'PUT', body: { stocks: [{ chrtId: 201, amount: 20 }, { chrtId: 202, amount: 0 }] } });
  assert.deepEqual(f.requests.filter(r => r.method === 'POST').map(r => r.body), [{ chrtIds: [201, 202] }, { chrtIds: [201, 202] }]);
  assert.ok(f.queries.every(q => q.sql.startsWith('SELECT') && q.sql.includes('tenant_id=? AND shop_id=?')));
  assert.deepEqual(f.queries[0].params, [2, 13, 101]);
});
test('foreign enterprise shop, warehouse, or mismatched native SKU cannot write', async () => {
  for (const mutate of [f => { f.input.shop_id = 14; }, f => { f.input.warehouse_id = 999; }, f => { f.input.items[0].chrt_id = 999; }, f => { f.input.items[0].nm_id = 999; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.service.setStockBatch(2, f.input)); assert.equal(f.requests.some(r => r.method === 'PUT'), false);
  }
});
test('invalid quantities, absent expected stock, duplicate SKUs and oversized batches fail before WB writes', async () => {
  for (const value of [undefined, null, '', '4', -1, 0.5, Infinity, NaN]) { const f = fixture(); f.input.items[0].quantity = value; await assert.rejects(f.service.setStockBatch(2, f.input)); assert.equal(f.requests.length, 0); }
  const f = fixture(); delete f.input.items[0].current; await assert.rejects(f.service.setStockBatch(2, f.input), /当前库存/);
  for (const items of [[], [f.input.items[0], f.input.items[0]], Array(1001).fill(f.input.items[0])]) await assert.rejects(f.service.readStockBatch(2, { ...f.input, items }));
});
test('changed platform stock blocks just the stale row and keeps other rows independently actionable', async () => {
  const f = fixture(); f.input.items[0].current = 6;
  const result = await f.service.setStockBatch(2, f.input);
  assert.equal(result.ok, false); assert.equal(result.rows[0].status, 'conflict'); assert.equal(result.rows[0].current, 7);
  assert.deepEqual(f.requests.find(r => r.method === 'PUT').body.stocks, [{ chrtId: 202, amount: 0 }]);
});
test('missing stock is unknown rather than zero, and explicit new quantity can create it', async () => {
  const f = fixture({ missing: true });
  assert.deepEqual((await f.service.readStockBatch(2, f.input)).rows.map(r => r.current), [null, null]);
  f.input.items = [{ nm_id: 101, chrt_id: 201, quantity: 10, current: null }];
  const result = await f.service.setStockBatch(2, f.input);
  assert.equal(result.rows[0].status, 'unconfirmed'); assert.equal(result.rows[0].current, null);
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 1);
});
test('HTTP success alone, absent readback, and unknown network result do not claim confirmed stock or retry writes', async () => {
  for (const options of [{ noReadback: true }, { writeError: Object.assign(Error('unknown'), { code: 'WB_RESULT_UNKNOWN' }) }]) {
    const f = fixture(options), r = await f.service.setStockBatch(2, f.input);
    assert.equal(r.rows[0].status, 'unconfirmed'); assert.equal(f.requests.filter(r => r.method === 'PUT').length, 1);
  }
  const f = fixture({ writeError: Object.assign(Error('permission denied'), { statusCode: 403 }) });
  const r = await f.service.setStockBatch(2, f.input); assert.equal(r.rows[0].status, 'failed'); assert.equal(r.rows[1].status, 'failed');
});
test('malformed reads block writes, archived card is not editable', async () => {
  const f = fixture({ malformed: true }); await assert.rejects(f.service.setStockBatch(2, f.input), /有效库存/); assert.equal(f.requests.some(r => r.method === 'PUT'), false);
  const s = createWbStockManagement({ account: async () => ({ tenant_id: 2, shop_id: 13 }), query: async () => [{ nm_id: 101, raw_json: { _wb_archived: true, sizes: [{ chrtID: 201 }] } }], request: async () => [{ id: 101 }] });
  await assert.rejects(s.setStockBatch(2, f.input), /归档/);
});
test('batch stock routes require enterprise operations and freshly authorized tenant, never request tenant', async () => {
  for (const path of ['stocks/batch/read', 'stocks/batch/set']) { assert.equal(wbRoutePermission(['api', 'wb', ...path.split('/')], 'POST'), 'operations'); assert.equal(wbRoutePermission(['api', 'wb', ...path.split('/')], 'GET'), null); }
  const calls = [], routes = createWbRoutes({ readJson: async () => ({ tenant_id: 99 }), authorize: async () => ({ personId: 1, roles: ['operations'], tenant: { id: 2, slug: 'stock', role: 'member' } }), platform: async () => ({ setStockBatch: async (...args) => { calls.push(args); return {}; } }) });
  await routes['POST /api/wb/stocks/batch/set']({}); assert.equal(calls[0][0], 2);
});
