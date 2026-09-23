import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { calculateOrderProcurementCoverage, planPartialReceipt } from '../src/services/order-procurement-coverage.js';
import { loadOrderProcurementCoverage, invalidateOrderProcurementCoverage } from '../src/services/mysql-order-procurement-coverage.js';

const item = (order_id = 1, extra = {}) => ({ order_id, order_item_id: order_id, product_id: 10, quantity: 1, needs_fulfillment: 1, entered_transport: 0, stock_location: 'LOCAL', ...extra });
const calculate = (demands, extra = {}) => calculateOrderProcurementCoverage({ demands, stocks: [], allocations: [], inbounds: [], requests: [], marks: [], ...extra });
test('current rows expose the same inventory historical purchase gap without adding it to current procurement', () => {
  const demands = [item(1, { needs_fulfillment: 0, entered_transport: 1, quantity: 5 }), item(2)];
  const result = calculate(demands, { stocks: [{ product_id: 10, ledger: -5 }] });
  assert.equal(result.get(2).items[0].product_historical_missing_purchase_quantity, 5);
  assert.equal(result.get(2).shortage_quantity, 1);
  const filled = calculate(demands, { sources: [{ order_item_id: 1, product_id: 10, quantity: 5 }] });
  assert.equal(filled.get(2).items[0].product_historical_missing_purchase_quantity, 0);
});
test('historical negative stock does not consume this order’s confirmed purchase', () => {
  const result = calculate([item()], { stocks: [{ product_id: 10, ledger: -6, open_deducted: 1 }], requests: [{ id: 3, product_id: 10, quantity: 1, amount: 10, purchase_order_id: 4, status: 'purchased' }], allocations: [{ order_item_id: 1, product_id: 10, procurement_request_id: 3, allocated_quantity: 1 }], inbounds: [{ id: 5, product_id: 10, procurement_request_id: 3, purchase_order_id: 4, quantity: 1, status: 'pending_arrival' }] });
  assert.equal(result.get(1).shortage_quantity, 0);
  assert.equal(result.get(1).incoming_quantity, 1);
  assert.equal(result.get(1).inventory_needs_review, true);
});
test('one available unit cannot cover two orders', () => {
  const result = calculate([item(), item(2)], { stocks: [{ product_id: 10, ledger: 1, open_deducted: 0 }] });
  assert.equal(result.get(1).stock_quantity, 1);
  assert.equal(result.get(2).shortage_quantity, 1);
});
test('pre-shipping deductions are restored once before allocating current demand', () => {
  const result = calculate([item(), item(2)], { stocks: [{ product_id: 10, ledger: -1, open_deducted: 2 }] });
  assert.equal(result.get(1).stock_quantity, 1);
  assert.equal(result.get(2).shortage_quantity, 1);
});
test('partial purchase appears in both actionable queues', () => {
  const result = calculate([item(1, { quantity: 3 })], { inbounds: [{ id: 5, product_id: 10, quantity: 2, status: 'pending_arrival', amount: 20 }] }).get(1);
  assert.equal(result.incoming_quantity, 2);
  assert.equal(result.shortage_quantity, 1);
});
test('coverage exposes total, reserved, and currently available inbound supply', () => {
  const result = calculate([item(1), item(2)], {
    inbounds: [{ id: 5, product_id: 10, quantity: 2, status: 'pending_arrival', amount: 20 }]
  });
  const first = result.get(1).items[0];
  const second = result.get(2).items[0];
  assert.deepEqual(
    [first.product_total_incoming_quantity, first.product_reserved_incoming_quantity, first.product_available_incoming_quantity],
    [2, 2, 0]
  );
  assert.deepEqual(
    [second.product_total_incoming_quantity, second.product_reserved_incoming_quantity, second.product_available_incoming_quantity],
    [2, 2, 0]
  );
});
test('duplicate historical allocations cannot consume later orders\' in-transit supply', () => {
  const result = calculate([item(1), item(2)], {
    requests: [
      { id: 3, product_id: 10, quantity: 1, purchase_order_id: 4, status: 'purchased' },
      { id: 4, product_id: 10, quantity: 1, purchase_order_id: 5, status: 'purchased' }
    ],
    allocations: [
      { order_item_id: 1, product_id: 10, procurement_request_id: 3, allocated_quantity: 1 },
      { order_item_id: 1, product_id: 10, procurement_request_id: 4, allocated_quantity: 1 }
    ],
    inbounds: [
      { id: 5, product_id: 10, procurement_request_id: 3, purchase_order_id: 4, quantity: 1, status: 'pending_arrival' },
      { id: 6, product_id: 10, procurement_request_id: 4, purchase_order_id: 5, quantity: 1, status: 'pending_arrival' }
    ]
  });
  assert.equal(result.get(1).incoming_quantity, 1);
  assert.equal(result.get(2).incoming_quantity, 1);
  assert.equal(result.get(2).shortage_quantity, 0);
});
test('received supply replaces an in-transit allocation with real stock coverage', () => {
  const result = calculate([item()], {
    stocks: [{ product_id: 10, ledger: 1, open_deducted: 0 }],
    requests: [{ id: 3, product_id: 10, quantity: 1, purchase_order_id: 4, status: 'purchased' }],
    allocations: [{ order_item_id: 1, product_id: 10, procurement_request_id: 3, allocated_quantity: 1 }],
    inbounds: [{ id: 5, product_id: 10, procurement_request_id: 3, purchase_order_id: 4, quantity: 1, status: 'approved' }]
  }).get(1);
  assert.equal(result.stock_quantity, 1);
  assert.equal(result.incoming_quantity, 0);
  assert.equal(result.shortage_quantity, 0);
});
test('purchase suggestions alone are not confirmed supply', () => {
  assert.equal(calculate([item()], { requests: [{ id: 3, product_id: 10, source_order_item_id: 1, quantity: 1, amount: 10, status: 'suggested' }] }).get(1).shortage_quantity, 1);
});
test('FBP stock cannot cover local fulfillment', () => {
  const result = calculate([item()], { stocks: [{ product_id: 10, ledger: 0, open_deducted: 0, fbp: 9 }] });
  assert.equal(result.get(1).shortage_quantity, 1);
});
test('component demand uses component units and does not double-count kits', () => {
  const result = calculate([item(1, { quantity: 2 }), item(1, { product_id: 11, quantity: 1 })], { stocks: [{ product_id: 10, ledger: 1 }, { product_id: 11, ledger: 1 }] }).get(1);
  assert.equal(result.shortage_quantity, 1);
  assert.equal(result.items.length, 2);
});
test('only transported history enters missing-record queue; pre-transit cancellation does not', () => {
  const result = calculate([item(1, { needs_fulfillment: 0, entered_transport: 1 }), item(2, { needs_fulfillment: 0, entered_transport: 0 })]);
  assert.equal(result.get(1).missing_record_quantity, 1);
  assert.equal(result.get(2).missing_record_quantity, 0);
  assert.equal(result.get(1).shortage_quantity, 0);
});
test('an automatic stock-available mark cannot erase historical missing source evidence', () => {
  const result = calculate([item(1, { needs_fulfillment: 0, entered_transport: 1 })], { marks: [{ order_item_id: 1, product_id: 10, handling_type: 'stock_available', status: 'handled' }] });
  assert.equal(result.get(1).missing_record_quantity, 1);
});
test('partial receipt conserves quantity and amount, and rejects stale/double receipt', () => {
  const record = { id: 5, status: 'pending_arrival', quantity: 10, amount: 100, shipping_amount: 10 };
  assert.deepEqual(planPartialReceipt(record, 6, 10), { received: 6, remaining: 4, amount: 60, shippingAmount: 6, remainingAmount: 40, remainingShipping: 4 });
  assert.throws(() => planPartialReceipt(record, 11, 10), /实收数量/);
  assert.throws(() => planPartialReceipt(record, 6, 9), /变化/);
  assert.throws(() => planPartialReceipt({ ...record, status: 'approved' }, 6, 10), /入库/);
});

test('actual receipt transaction keeps a pending remainder and cannot receive the same row twice', async () => {
  const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('async function applyInboundRecordUpdateMysql'), source.indexOf('export async function updateInboundRecordMysql'));
  let row = { id: 5, product_id: 10, person_id: 1, quantity: 10, amount: 100, shipping_amount: 10, status: 'pending_arrival' };
  const inserts = [], movements = [];
  const connection = { execute: async (sql, values) => {
    if (sql.includes('INSERT INTO inbound_records')) inserts.push(values);
    if (sql.includes('UPDATE inbound_records SET')) row = { ...row, quantity: values[2], amount: values[3], status: values[7] };
    return [{ affectedRows: 1, insertId: 6 }];
  } };
  const apply = vm.runInNewContext(block + ';applyInboundRecordUpdateMysql', {
    planPartialReceipt, mysqlConnectionQueryOne: async () => ({ ...row }), assertFreshRecord: () => {},
    resolvePersonIdOrFirstMysql: async () => 1, normalizeMysqlDateTime: value => value,
    postInventoryMysql: async (_, movement) => movements.push(movement), recordInboundCostVersionMysql: async () => {},
    refreshPurchaseOrderStatusMysql: async () => {}
  });
  await apply(connection, 5, { receive_quantity: 6, expected_remaining_quantity: 10 });
  assert.equal(row.quantity, 6);
  assert.equal(row.status, 'approved');
  assert.equal(inserts[0][2], 4);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].quantity_delta, 6);
  await assert.rejects(() => apply(connection, 5, { receive_quantity: 6, expected_remaining_quantity: 10 }), /已入库/);
  assert.equal(movements.length, 1);
});

test('FBP fulfillment has a warehouse source and does not require a fictitious per-order purchase', () => {
  const result = calculate([item(1, { needs_fulfillment: 0, entered_transport: 1, stock_location: 'FBP' })]).get(1);
  assert.equal(result.missing_record_quantity, 0);
});

test('historical receipts cover history once and never become additional live stock', () => {
  const result = calculate([item(1, { needs_fulfillment: 0, entered_transport: 1 }), item(2, { needs_fulfillment: 0, entered_transport: 1 }), item(3)],
    { inbounds: [{ id: 5, product_id: 10, quantity: 1, amount: 10, status: 'approved' }] });
  assert.equal(result.get(1).missing_record_quantity, 0);
  assert.equal(result.get(2).missing_record_quantity, 1);
  assert.equal(result.get(3).shortage_quantity, 1);
});

test('confirmed purchase with unknown quantity requests verification instead of another purchase', () => {
  const result = calculate([item()], { requests: [{ id: 3, product_id: 10, source_order_item_id: 1, quantity: 0, purchase_order_id: 4, status: 'purchased' }] }).get(1);
  assert.equal(result.quantity_needs_review, true);
  assert.equal(result.shortage_quantity, 0);
  assert.equal(result.incoming_quantity, 0);
});

test('date objects allocate chronologically rather than by weekday text', () => {
  const result = calculate([item(1, { ordered_at: new Date('2026-09-11T00:00:00Z') }), item(2, { ordered_at: new Date('2026-09-07T00:00:00Z') })], { stocks: [{ product_id: 10, ledger: 1 }] });
  assert.equal(result.get(2).stock_quantity, 1);
  assert.equal(result.get(1).shortage_quantity, 1);
});

test('refresh reloads active orders and removes cancelled demand while retaining historical records', async () => {
  let refreshed = false;
  const statements = [];
  const query = async sql => {
    statements.push(sql);
    if (sql.includes('SELECT o.id AS order_id')) return refreshed
      ? [item(1, { needs_fulfillment: 0, entered_transport: 0 })]
      : [item(), item(2, { needs_fulfillment: 0, entered_transport: 1 })];
    return [];
  };
  const first = await loadOrderProcurementCoverage(query, '');
  assert.equal(first.get(1).shortage_quantity, 1);
  refreshed = true;
  invalidateOrderProcurementCoverage();
  const next = await loadOrderProcurementCoverage(query, '');
  assert.equal(next.get(1).shortage_quantity, 0);
  assert.equal(next.get(2).missing_record_quantity, 1);
  assert.ok(statements.filter(sql => sql.includes('SELECT o.id AS order_id'))[1].includes('o.last_status_changed_at'));
});

test('FBP sales ignore linked procurement cost/quantity issues and never consume local stock', async () => {
  const { procurementQueueSql } = await import('../src/services/mysql-order-procurement-coverage.js');
  for (const status of ['pending_arrival', 'approved']) {
    const result = calculate([item(1, { stock_location: 'FBP', entered_transport: 1 }), item(2)], {
      stocks: [{ product_id: 10, ledger: 1 }],
      requests: [{ id: 3, product_id: 10, quantity: 0, purchase_order_id: 4, status: 'purchased' }],
      allocations: [{ order_item_id: 1, product_id: 10, procurement_request_id: 3, allocated_quantity: 1 }],
      inbounds: [{ id: 5, product_id: 10, procurement_request_id: 3, purchase_order_id: 4, quantity: 1, amount: 0, status }]
    });
    const fbp = result.get(1);
    for (const key of ['shortage_quantity', 'stock_quantity', 'incoming_quantity', 'missing_record_quantity']) assert.equal(fbp[key], 0, key);
    assert.equal(fbp.missing_amount, false);
    assert.equal(fbp.quantity_needs_review, false);
    assert.equal(fbp.batches.length, 0);
    assert.equal(result.get(2).stock_quantity, 1);
    for (const queue of ['pending_purchase', 'purchase_in_transit', 'purchase_records_missing']) assert.equal(procurementQueueSql(result, queue), '1 = 0');
  }
});

test('FBP-associated supplier batches are not promised again to local sales', () => {
  const result = calculate([item(1, { stock_location: 'FBP' }), item(2)], {
    requests: [{ id: 3, product_id: 10, quantity: 1, purchase_order_id: 4, status: 'purchased' }],
    allocations: [{ order_item_id: 1, product_id: 10, procurement_request_id: 3, allocated_quantity: 1 }],
    inbounds: [{ id: 5, product_id: 10, procurement_request_id: 3, quantity: 1, status: 'pending_arrival' }]
  });
  assert.equal(result.get(1).incoming_quantity, 0);
  assert.equal(result.get(2).shortage_quantity, 1);
});

test('order procurement endpoints reject FBP before changing purchase records', async () => {
  const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
  for (const name of ['previewOrderProcurementMysql', 'createOrderProcurementRequestsMysql']) {
    const block = source.match(new RegExp(`async function ${name}\\([^]*?\\n}`))[0];
    const stockCheck = source.match(/async function orderUsesFbpStockMysql\([^]*?\n}/)[0];
    const fn = vm.runInNewContext(`${stockCheck};${block};${name}`, {
      ensureMysqlCutoverEnabled() {},
      mysqlQueryOne: async () => ({ stock_location: 'FBP' })
    });
    await assert.rejects(fn(1), /官方仓库存直接履约/);
  }
});
