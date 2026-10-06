import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';
import { inferProcurementSources } from '../src/services/procurement-source-inference.js';

const order = (id, quantity, shipped, date) => ({ order_id: id, order_item_id: id, product_id: 1, quantity,
  stock_location: 'LOCAL', needs_fulfillment: shipped ? 0 : 1, entered_transport: shipped ? 1 : 0,
  ordered_at: date, transport_at: shipped ? date : null });
const batch = (id, quantity, status, date) => ({ id, product_id: 1, quantity, status, purchased_at: date,
  approved_at: status === 'approved' ? '2026-10-06' : null, purchase_order_no: `PO-${id}`, amount: quantity * 10 });

test('40 missing historic purchases remain separate from second 40 received and third 40 incoming', () => {
  const result = calculateOrderProcurementCoverage({ includeTrace: true,
    demands: [order(1, 40, true, '2026-08-01'), order(2, 40, true, '2026-08-20'), order(3, 40, false, '2026-09-01')],
    inbounds: [batch(3, 40, 'pending_arrival', '2026-08-25'), batch(2, 40, 'approved', '2026-08-10')],
    stocks: [{ product_id: 1, ledger: 0, stocktake_id: 9 }] });
  assert.equal(result.get(1).missing_purchase_quantity, 40);
  assert.equal(result.get(2).missing_record_quantity, 0);
  assert.equal(result.get(2).items[0].coverage_trace[0].purchase_order_no, 'PO-2');
  assert.equal(result.get(3).incoming_quantity, 40);
  assert.equal(result.get(3).shortage_quantity, 0);
});

test('counted 10 covers earliest 10 of 20 before using incoming, even with existing incoming reservations', () => {
  const result = calculateOrderProcurementCoverage({ includeTrace: true,
    demands: [order(1, 10, false, '2026-09-01'), order(2, 10, false, '2026-09-02')],
    inbounds: [{ ...batch(3, 40, 'pending_arrival', '2026-08-25'), purchase_order_id: 3 }],
    stocks: [{ product_id: 1, ledger: 10, stocktake_id: 9 }],
    requests: [{ id: 7, source_order_item_id: 1, product_id: 1, quantity: 10, purchase_order_id: 3, status: 'purchased' }] });
  assert.equal(result.get(1).stock_quantity, 10);
  assert.equal(result.get(1).incoming_quantity, 0);
  assert.equal(result.get(2).incoming_quantity, 10);
  assert.equal(result.available_batches[0].unallocated_quantity, 30);
});

test('shipped order reserves missing receipt records but has no incoming coverage', () => {
  const result = calculateOrderProcurementCoverage({ includeTrace: true,
    demands: [order(1, 5, true, '2026-09-01')],
    inbounds: [{ ...batch(3, 40, 'pending_arrival', '2026-08-25'), purchase_order_id: 3 }],
    requests: [{ id: 7, source_order_item_id: 1, product_id: 1, quantity: 5, purchase_order_id: 3, status: 'purchased' }] });
  assert.equal(result.get(1).incoming_quantity, 0);
  assert.equal(result.get(1).missing_receipt_quantity, 5);
  assert.equal(result.get(1).items[0].coverage_trace[0].purpose, 'receipt_pending');
  assert.equal(result.available_batches[0].unallocated_quantity, 35);
});

test('source inference never proposes new procurement for earlier historical debt', () => {
  const result = inferProcurementSources({ physical_estimate: 10,
    orders: [{ ...order(1, 40, true, '2026-08-01'), missing_record_quantity: 40 }],
    batches: [{ ...batch(2, 40, 'approved', '2026-08-10'), unallocated_quantity: 40 }] });
  assert.equal(result.historical_unmatched, 40);
  assert.equal(result.reserves[0].quantity, 10);
  assert.equal(result.unassigned_purchase_quantity, 30);
});

test('explicit historical links remain authoritative even when registered after shipping', () => {
  const result = calculateOrderProcurementCoverage({ includeTrace: true,
    demands: [order(1, 5, true, '2026-08-01')], inbounds: [batch(2, 40, 'approved', '2026-08-10')],
    sources: [{ order_item_id: 1, product_id: 1, inbound_record_id: 2, quantity: 5 }] });
  assert.equal(result.get(1).missing_record_quantity, 0);
  assert.equal(result.get(1).items[0].coverage_trace[0].basis, 'recorded');
  assert.equal(result.available_batches[0].unallocated_quantity, 35);
});

test('counted physical supply excludes FBP reservations and FBP orders', () => {
  const result = calculateOrderProcurementCoverage({
    demands: [order(1, 20, false, '2026-09-01'), { ...order(2, 10, false, '2026-09-01'), stock_location: 'FBP' }],
    stocks: [{ product_id: 1, ledger: 10, stocktake_id: 9, fbp_reserved: 5 }],
    inbounds: [batch(3, 40, 'pending_arrival', '2026-08-25')] });
  assert.equal(result.get(1).stock_quantity, 5);
  assert.equal(result.get(1).incoming_quantity, 15);
  assert.equal(result.get(2).stock_quantity, 0);
  assert.equal(result.get(2).incoming_quantity, 0);
});
