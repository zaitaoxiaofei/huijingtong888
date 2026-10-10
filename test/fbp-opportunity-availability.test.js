import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';

const service = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../frontend/admin/views/inventory/InventoryFbpOpportunitiesPage.vue', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const coverageLoader = readFileSync(new URL('../src/services/mysql-order-procurement-coverage.js', import.meta.url), 'utf8');
const normalizeSource = service.slice(service.indexOf('function fbpOpportunityPriority('), service.indexOf('function applyFbpOpportunityQuery('));
const normalize = new Function('parseWarehouseBreakdown', `${normalizeSource}; return normalizeFbpOpportunityRow;`)(() => []);

test('FBP suggestion transfers only unreserved local stock and does not re-buy unallocated arrivals', () => {
  const row = normalize({ shop_id: 1, product_id: 605, ozon_sku: '5450019727', recent_30d_qty: 45,
    recent_7d_qty: 12, week1_qty: 12, week2_qty: 10, week3_qty: 9,
    local_stock: 4, local_available: 2, order_reserved_qty: 2,
    pending_procurement_qty: 0, pending_procurement_available_qty: 0,
    fbp_available: 0, fbp_transfer_in_transit_qty: 0 });
  assert.equal(row.pending_procurement_qty, 0);
  assert.equal(row.suggested_transfer_qty, 2);
  assert.equal(row.suggested_purchase_qty, row.suggested_qty - 2);
  const arriving = normalize({ ...row, local_stock: 0, local_available: 0, order_reserved_qty: 0,
    pending_procurement_qty: 50, pending_procurement_available_qty: 50 });
  assert.equal(arriving.suggested_purchase_qty, 0);
  assert.equal(arriving.suggested_action, 'await_inbound');
});

test('global product availability subtracts current order reservations and FBP reservations', () => {
  const coverage = calculateOrderProcurementCoverage({
    stocks: [{ product_id: 605, ledger: 10, fbp_reserved: 2 }],
    demands: [{ order_id: 1, order_item_id: 1, product_id: 605, quantity: 5, needs_fulfillment: 1, stock_location: 'LOCAL' }]
  });
  assert.deepEqual(coverage.product_availability.get(605), {
    product_id: 605, local_stock: 10, local_available: 3,
    order_reserved_qty: 5, fbp_reserved_qty: 2,
    pending_procurement_qty: 0, pending_procurement_available_qty: 0,
    inventory_needs_review: false
  });
});

test('global ledger projection does not count FBP reservation movements as new stock', () => {
  assert.match(coverageLoader, /SUM\(CASE WHEN movement_type IN \('ORDER_RESERVED', 'CANCEL_RESTORE'\) THEN 0 ELSE quantity_delta END\) AS ledger/);
  assert.match(coverageLoader, /AS fbp_reserved/);
});

test('FBP opportunities and future inventory pages share the order coverage availability interface', () => {
  const body = service.slice(service.indexOf('export async function fbpOpportunitiesMysql('), service.indexOf('export async function fbpShortageItemsMysql('));
  assert.match(body, /orderProcurementCoverageMysql\(\)/);
  assert.doesNotMatch(body, /status NOT IN \('cancelled', 'purchased'\)/);
  assert.match(service, /export async function productInventoryAvailabilityMysql\(/);
  assert.match(server, /GET \/api\/inventory\/availability/);
  assert.match(page, /本地可发仓/);
  assert.doesNotMatch(page, /本地\+采购/);
});

test('availability API resolves a bounded product batch from the order projection', async () => {
  const start = service.indexOf('export async function productInventoryAvailabilityMysql(');
  const end = service.indexOf('export async function orderProcurementBatchesMysql(', start);
  const calls = [];
  const load = new Function('ensureMysqlCutoverEnabled', 'orderProcurementCoverageMysql',
    `${service.slice(start, end).replace('export ', '')}; return productInventoryAvailabilityMysql;`)(
    () => {}, async (options) => {
      calls.push(options);
      return { product_availability: new Map([[605, { product_id: 605, local_stock: 4, pending_procurement_qty: 0 }]]) };
    });
  const result = await load({ productIds: '605,606' });
  assert.deepEqual(calls, [{ productIds: [605, 606] }]);
  assert.equal(result.source, 'order_procurement_coverage');
  assert.equal(result.rows[0].local_stock, 4);
  assert.equal(result.rows[1].pending_procurement_qty, 0);
  await assert.rejects(load({ productIds: '605,bad' }), /库存商品 ID/);
});
