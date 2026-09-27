import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { supplementLiveProcurementRows } from '../src/services/procurement-live-demand.js';
import { groupProcurementRequestsMysql } from '../src/services/mysql-procurement-list.js';

const order = (id, product, qty, extra = {}) => ({ order_id: id, needs_fulfillment: true, stock_location: 'LOCAL', posting_number: `ORDER-${id}`, transport_at: '2026-09-27T05:30:00Z', items: [{ order_item_id: id, product_id: product, shortage_quantity: qty }], ...extra });
test('live gaps without request records appear once per inventory without doubling quantities', () => {
  const coverage = new Map([[1, order(1, 827, 1)], [2, order(2, 827, 1)], [3, order(3, 829, 4)]]);
  const rows = [{ product_id: 827, product_code: '1-261', operational_shortage: 2 }, { product_id: 829, product_code: '1-263', operational_shortage: 4 }];
  for (const demandType of ['real_order', 'all']) {
    const result = groupProcurementRequestsMysql(supplementLiveProcurementRows(rows, coverage), { demandType });
    assert.equal(result.total, 2);
    assert.equal(result.rows.reduce((sum, row) => sum + row.real_order_shortage, 0), 6);
    assert.equal(result.rows.flatMap(row => row.requests).length, 3);
    assert.ok(result.rows.every(row => row.requests.every(request => request.id === 0 && request.live_order_demand)));
  }
  assert.equal(rows.length, 2, 'source rows stay untouched');
});

test('existing actionable requests are not duplicated; completed and cancelled records cannot hide new gaps', () => {
  const coverage = new Map([[1, order(1, 10, 2)]]);
  const row = { id: 77, product_id: 10, quantity: 2, status: 'suggested', source_order_id: 1, operational_needs_fulfillment: true, operational_shortage: 2 };
  assert.equal(supplementLiveProcurementRows([row], coverage).length, 1);
  for (const changed of [{ status: 'cancelled' }, { purchase_order_status: 'purchased' }, { operational_needs_fulfillment: false }]) {
    const result = groupProcurementRequestsMysql(supplementLiveProcurementRows([{ ...row, ...changed }], coverage), { demandType: 'real_order' });
    assert.equal(result.rows[0].real_order_shortage, 2);
    assert.equal(result.rows[0].requests.length, 1);
    assert.equal(result.rows[0].requests[0].id, 0);
  }
});

test('FBP, already shipped, covered orders and products outside the selected page do not leak in', () => {
  const coverage = new Map([[1, order(1, 1, 1, { stock_location: 'FBP' })], [2, order(2, 1, 1, { needs_fulfillment: false })], [3, order(3, 1, 0)], [4, order(4, 2, 1)]]);
  assert.deepEqual(supplementLiveProcurementRows([{ product_id: 1 }], coverage), []);
});

test('live paging queries products before paging, preserves filters and never writes requests', async () => {
  const source = await fs.readFile(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function procurementGroupedPageIdsMysql('), source.indexOf('async function nextPurchaseOrderNoMysql('));
  const calls = [];
  const page = new Function('mysqlQuery', 'normalizeVehicleBrand', `${body};return procurementGroupedPageIdsMysql;`)(async (sql, params) => {
    calls.push({ sql, params });
    return sql.startsWith('SELECT COUNT') ? [{ total: 28 }] : [{ product_id: 827 }];
  }, value => value || '');
  const result = await page({ demandType: 'real_order', page: 2, pageSize: 20, query: '1-261' }, [827, 829]);
  assert.equal(result.total, 28);
  assert.deepEqual(result.productIds, [827]);
  assert.match(calls[0].sql, /FROM products p\s+LEFT JOIN procurement_requests/);
  assert.match(calls[0].sql, /WHERE p.id IN/);
  assert.match(calls[0].sql, /p.inventory_number/);
  assert.deepEqual(calls[0].params.slice(-2), [20, 20]);
  assert.ok(calls.every(call => !/INSERT|UPDATE|DELETE/.test(call.sql)));
});

test('purchase entry materializes live demand before editing and blocks an unresolved gap', async () => {
  const source = await fs.readFile(new URL('../frontend/admin/views/procurement/ProcurementWorkspaceView.vue', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function openBulkPurchase('), source.indexOf('function bulkItemFromDemand('));
  for (const resolved of [true, false]) {
    const row = { product_id: 827, product_code: '1-261', product_name: '新库存', requests: [{ id: 0, live_order_demand: true }] };
    const calls = [], errors = [], visible = { value: false }, items = { value: [] };
    const deps = {
      selectedDemandRows: { value: [row] }, loading: { value: false },
      apiClient: {
        post: async url => { calls.push(url); },
        get: async url => { calls.push(url); return url.startsWith('/api/products/') ? {} : { rows: resolved ? [{ ...row, requests: [{ id: 777 }], suggested_purchase_qty: 2 }] : [] }; }
      },
      ElMessage: { warning: message => errors.push(message), error: message => errors.push(message) },
      ElMessageBox: { alert: () => {} }, bulkItemFromDemand: row => ({ request_ids: row.requests.map(item => item.id), quantity: row.suggested_purchase_qty }),
      mergeBulkItems: rows => rows, bulkItems: items, bulkPage: { value: 1 }, bulkMeta: {}, bulkVisible: visible, loadBulkGroupRecommendations: () => {}
    };
    const open = new Function(...Object.keys(deps), `${body};return openBulkPurchase;`)(...Object.values(deps));
    await open();
    assert.equal(calls[0], '/api/procurement/refresh-demand');
    assert.equal(visible.value, resolved);
    if (resolved) assert.deepEqual(items.value, [{ request_ids: [777], quantity: 2 }]);
    else assert.match(errors[0], /缺口已变化或采购需求尚未生成/);
  }
});
