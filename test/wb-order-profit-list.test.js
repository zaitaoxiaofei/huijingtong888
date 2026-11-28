import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { enrichWbOrders, dispatchWbProfitRecalculation } from '../src/services/wb-order-dispatch.js';
import { cachedOrderRead, invalidateOrderReadCache } from '../src/services/order-read-cache.js';

const detail = (id, tenant = 2) => ({ order_id: id, tenant_id: tenant, supplier_status: 'new',
  raw_json: { convertedCurrencyCode: 156, convertedPrice: 5655 } });

test('WB list reads canonical saved profits and preserves unknown separately from numeric projections', async () => {
  const ozon = { id: 3, platform: 'ozon', estimated_profit: 6 };
  const records = [{ id: 1, platform: 'wb', estimated_profit: 999 }, { id: 2, platform: 'wb', estimated_profit: 42 }, ozon];
  const reads = [];
  const result = await enrichWbOrders({ rows: records }, {
    query: async (sql, ids) => {
      assert.match(sql, /s\.platform='wb'/);
      assert.deepEqual(ids, [1, 2]);
      assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
      return [detail(1), detail(2)];
    },
    readSnapshots: async ({ tenantId, orderIds }) => {
      reads.push({ tenantId, orderIds });
      return new Map([
        [1, { outputs: { profit: 0, provisional: false }, revision_id: 10, calculated_at: '2026-11-28T01:00:00Z' }],
        [2, { outputs: { profit: null, provisional: true, missingInputs: [{ field: 'weight', label: '包裹实重' }] }, revision_id: 11 }]
      ]);
    }
  });
  assert.equal(result.rows[0].estimated_profit, 0);
  assert.equal(result.rows[0].wb_profit.estimated_profit_cny, 0);
  assert.equal(result.rows[1].estimated_profit, null, 'an old numeric projection cannot turn an incomplete calculation into a known profit');
  assert.equal(result.rows[1].wb_profit.missing_inputs[0].label, '包裹实重');
  assert.equal(result.rows[2], ozon);
  assert.equal(result.rows[2].estimated_profit, 6);
  assert.deepEqual(reads, [{ tenantId: 2, orderIds: [1, 2] }]);
});

test('WB never-calculated rows remain unknown and snapshot reads are partitioned by authoritative enterprise', async () => {
  const records = [{ id: 1, platform: 'wb', estimated_profit: 0 }, { id: 2, platform: 'wb', estimated_profit: 0 }];
  const reads = [];
  await enrichWbOrders(records, {
    query: async () => [detail(1, 2), detail(2, 3)],
    readSnapshots: async ({ tenantId, orderIds }) => { reads.push({ tenantId, orderIds }); return new Map(); }
  });
  assert.ok(records.every(row => row.estimated_profit === null && row.wb_profit === null));
  assert.deepEqual(reads, [{ tenantId: 2, orderIds: [1] }, { tenantId: 3, orderIds: [2] }]);
});

test('Ozon lists do not run WB snapshot queries', async () => {
  const records = [{ id: 1, platform: 'ozon', estimated_profit: 15 }];
  assert.equal(await enrichWbOrders(records, { query: async () => assert.fail('Unexpected WB query') }), records);
});

test('saving WB profit invalidates the server order-row cache immediately', async () => {
  const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
  const block = source.match(/export function invalidateWbOrderCachesMysql\(\) \{[^]*?\n\}/)[0].replace('export ', '');
  const invalidate = vm.runInNewContext(`${block};invalidateWbOrderCachesMysql`, {
    invalidateOrderReadCache, invalidateOrderProcurementCoverage() {}, invalidateShopCacheMysql() {}
  });
  invalidateOrderReadCache();
  let value = 10;
  const load = () => cachedOrderRead('wb-profit-list-test', async () => value);
  assert.equal(await load(), 10);
  value = 24.57;
  assert.equal(await load(), 10);
  invalidate();
  assert.equal(await load(), 24.57);
});

test('the generic single-order action dispatches WB to its own authorized calculator', async () => {
  const calls = [];
  const session = { personId: 7, roles: ['operations'], tenant: { id: 2, slug: 'a', role: 'member' } };
  const result = await dispatchWbProfitRecalculation(17, { session }, {
    authorize: async value => { assert.equal(value, session); return session; },
    platform: async (value, permission) => {
      assert.equal(value, session);
      assert.equal(permission, 'orders.manage');
      return { recalculateOrderProfit: async (tenant, body) => { calls.push({ tenant, body }); return { ok: true, updated_count: 1 }; } };
    }
  });
  assert.deepEqual(calls, [{ tenant: 2, body: { order_ids: [17] } }]);
  assert.equal(result.updated, 1);
  await assert.rejects(dispatchWbProfitRecalculation(17, { session }, {
    authorize: async () => ({ ...session, roles: ['packing'] }), platform: async () => assert.fail('A read-only member reached the writer')
  }), { statusCode: 403 });
});
