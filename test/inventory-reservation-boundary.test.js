import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadFbpReservations } from '../src/services/fbp-warehouse.js';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';
import { summarizeLedger } from '../src/services/procurement-ledger.js';

const order = (id, quantity = 10) => ({ order_id: id, order_item_id: id, product_id: 10,
  quantity, ordered_at: `2026-09-0${id}T00:00:00Z`, needs_fulfillment: 1, stock_location: 'LOCAL' });

test('FBP approval and adjustments reserve once; shipment and receipt do not retain reservation', async () => {
  const db = new DatabaseSync(':memory:');
  db.function('GREATEST', (left, right) => Math.max(left, right));
  db.exec(`CREATE TABLE fbp_replenishment_orders (id INTEGER, status TEXT);
    CREATE TABLE fbp_replenishment_order_items (id INTEGER, order_id INTEGER, product_id INTEGER, approved_qty INTEGER);
    CREATE TABLE fbp_replenishment_item_adjustments (item_id INTEGER, adjustment_qty INTEGER);
    INSERT INTO fbp_replenishment_orders VALUES (1, 'approved');
    INSERT INTO fbp_replenishment_order_items VALUES (1, 1, 10, 100);
    INSERT INTO fbp_replenishment_item_adjustments VALUES (1, -10);`);
  const query = async (sql, args) => db.prepare(sql).all(...args);
  try {
    assert.equal((await loadFbpReservations(query, [10]))[0].quantity, 90);
    db.exec("UPDATE fbp_replenishment_orders SET status = 'sent'");
    assert.deepEqual(await loadFbpReservations(query, [10]), []);
    db.exec("UPDATE fbp_replenishment_orders SET status = 'completed'");
    assert.deepEqual(await loadFbpReservations(query, [10]), []);
  } finally { db.close(); }
});

test('a physical count covers the earliest ten of twenty units; historical debt stays separate', () => {
  const result = calculateOrderProcurementCoverage({
    demands: [{ ...order(1, 20), needs_fulfillment: 0, entered_transport: 1 }, order(2), order(3)],
    stocks: [{ product_id: 10, ledger: -10, open_deducted: 20, stocktake_id: 1 }]
  });
  assert.equal(result.get(1).missing_record_quantity, 20);
  assert.equal(result.get(2).stock_quantity, 10);
  assert.equal(result.get(2).shortage_quantity, 0);
  assert.equal(result.get(3).shortage_quantity, 10);
});

test('FBP reservations cannot create stock or be allocated again to current orders', () => {
  const compute = reserved => calculateOrderProcurementCoverage({ demands: [order(1)],
    stocks: [{ product_id: 10, ledger: 10, fbp_reserved: reserved, stocktake_id: 1 }] }).get(1);
  assert.equal(compute(10).shortage_quantity, 10);
  assert.equal(compute(6).stock_quantity, 4);
  assert.equal(compute(6).items[0].product_fbp_reserved, 6);
  assert.equal(compute(0).stock_quantity, 10);
  const summary = summarizeLedger({ id: 10 }, [
    { source_type: 'initial_stock', quantity_delta: 10 },
    { source_type: 'fbp_replenishment_reserve', quantity_delta: 100 },
    { source_type: 'fbp_replenishment_reserve_release', quantity_delta: -20 }
  ], [], [], 6);
  assert.equal(summary.physical_estimate, 10);
  assert.equal(summary.available_estimate, 4);
});

test('old linked receipts cannot override a verified zero stocktake or FBP occupancy', () => {
  for (const stock of [{ ledger: 0, fbp_reserved: 0 }, { ledger: 10, fbp_reserved: 10 }]) {
    const result = calculateOrderProcurementCoverage({ demands: [order(1)],
      stocks: [{ product_id: 10, ...stock, stocktake_id: 1 }],
      requests: [{ id: 1, product_id: 10, source_order_item_id: 1, quantity: 10, purchase_order_id: 1, status: 'purchased' }],
      inbounds: [{ id: 1, product_id: 10, procurement_request_id: 1, purchase_order_id: 1, quantity: 10, amount: 100, status: 'approved' }]
    }).get(1);
    assert.equal(result.stock_quantity, 0);
    assert.equal(result.shortage_quantity, 10);
  }
});

test('manual urgency changes FIFO only for live stock and never consumes FBP reservations', () => {
  const demands = [order(1, 2), { ...order(2, 2), allocation_priority: 1 },
    { ...order(3, 5), needs_fulfillment: 0, entered_transport: 1 }];
  const input = { demands, stocks: [{ product_id: 10, ledger: 5, stocktake_id: 1, fbp_reserved: 3 }] };
  const prioritized = calculateOrderProcurementCoverage(input);
  assert.equal(prioritized.get(2).stock_quantity, 2);
  assert.equal(prioritized.get(1).shortage_quantity, 2);
  assert.equal(prioritized.get(3).missing_record_quantity, 5);
  const restored = calculateOrderProcurementCoverage({ ...input, demands: demands.map(row => ({ ...row, allocation_priority: 0 })) });
  assert.equal(restored.get(1).stock_quantity, 2);
  assert.equal(restored.get(2).shortage_quantity, 2);
});
