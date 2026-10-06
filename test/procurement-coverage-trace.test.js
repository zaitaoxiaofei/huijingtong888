import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';
const demand = (id, quantity, historical = false) => ({ order_id: id, order_item_id: id, product_id: 1, quantity,
  posting_number: `ORDER-${id}`, stock_location: 'LOCAL', needs_fulfillment: historical ? 0 : 1,
  entered_transport: historical ? 1 : 0, ordered_at: '2026-09-02', transport_at: historical ? '2026-09-03' : null });
const batch = (id, quantity, status = 'pending_arrival') => ({ id, product_id: 1, quantity, status,
  purchase_order_id: id, purchase_order_no: `PO-${id}`, purchased_at: '2026-09-01', approved_at: status === 'approved' ? '2026-09-01' : null, amount: 100 });

test('split order traces exact quantities, retains local pool, and does not alter coverage', () => {
  const input = { demands: [demand(1, 6), demand(2, 3)], stocks: [{ product_id: 1, ledger: 2 }], inbounds: [batch(10, 3), batch(11, 3)] };
  const plain = calculateOrderProcurementCoverage(input);
  const traced = calculateOrderProcurementCoverage({ ...input, includeTrace: true });
  const first = traced.get(1).items[0], second = traced.get(2).items[0];
  assert.equal(first.stock_quantity, 2);
  assert.deepEqual(first.coverage_trace.map(row => [row.batch_id, row.quantity, row.purpose]), [[10, 3, 'incoming'], [11, 1, 'incoming']]);
  assert.equal(second.coverage_trace[0].quantity, 2);
  assert.equal(second.shortage_quantity, 1);
  for (const [id, order] of traced) {
    const clean = structuredClone(order);
    clean.items.forEach(row => delete row.coverage_trace);
    assert.deepEqual(clean, plain.get(id));
  }
  for (const b of traced.available_batches) {
    const allocated = [...traced.values()].flatMap(order => order.items).flatMap(row => row.coverage_trace)
      .filter(row => row.batch_id === b.id).reduce((sum, row) => sum + row.quantity, 0);
    assert.equal(allocated + b.unallocated_quantity, b.quantity);
  }
});

test('historical traces distinguish explicit source, FIFO evidence, and unreceived purchases', () => {
  const result = calculateOrderProcurementCoverage({ includeTrace: true, demands: [demand(1, 7, true)],
    inbounds: [batch(10, 2, 'approved'), batch(11, 2, 'approved'), batch(12, 2), { ...batch(13, 10, 'approved'), purchased_at: '2026-10-01', approved_at: '2026-10-01' }],
    sources: [{ order_item_id: 1, product_id: 1, inbound_record_id: 10, quantity: 2 }] });
  const row = result.get(1).items[0];
  assert.deepEqual(row.coverage_trace.map(source => [source.batch_id, source.quantity, source.basis, source.purpose]),
    [[10, 2, 'recorded', 'source'], [11, 2, 'fifo', 'source'], [12, 2, 'fifo', 'receipt_pending']]);
  assert.equal(row.missing_purchase_quantity, 1);
  assert.equal(row.missing_receipt_quantity, 2);
  assert.equal(row.stock_quantity, 0);
});

test('recorded pending purchase allocation exposes purchase number without pretending it is received', () => {
  const result = calculateOrderProcurementCoverage({ includeTrace: true, demands: [demand(1, 2)], inbounds: [batch(10, 5)],
    requests: [{ id: 3, product_id: 1, purchase_order_id: 10, quantity: 2 }],
    allocations: [{ order_item_id: 1, product_id: 1, procurement_request_id: 3, allocated_quantity: 2 }] });
  assert.deepEqual(result.get(1).items[0].coverage_trace.map(row => [row.purchase_order_no, row.quantity, row.basis, row.purpose]), [['PO-10', 2, 'recorded', 'incoming']]);
});

test('FBP orders do not acquire local source traces', () => {
  const result = calculateOrderProcurementCoverage({ includeTrace: true, demands: [{ ...demand(1, 2), stock_location: 'FBP' }], inbounds: [batch(10, 5)] });
  assert.deepEqual(result.get(1).items[0].coverage_trace, []);
});
