import test from 'node:test';
import assert from 'node:assert/strict';
import { inferProcurementSources } from '../src/services/procurement-source-inference.js';
const batch = (id, quantity) => ({ id, status: 'approved', quantity, unallocated_quantity: quantity, purchase_order_no: `PO-${id}`, purchased_at: '2026-08-01', approved_at: '2026-10-01' });
test('200 purchased, 150 historical, 50 counted: 17 current plus 33 reserve, no repeated consumption', () => {
  const snapshot = { physical_estimate: 50, batches: [{ ...batch(1, 200), unallocated_quantity: 50 }],
    orders: [{ order_item_id: 1, needs_fulfillment: true, stock_quantity: 17, coverage_trace: [] },
      { order_item_id: 2, entered_transport: true, quantity: 150, missing_record_quantity: 0 }] };
  const before = structuredClone(snapshot), result = inferProcurementSources(snapshot);
  assert.equal(result.suggestions[0].quantity, 17);
  assert.equal(result.reserves[0].quantity, 33);
  assert.equal(result.unassigned_purchase_quantity, 0);
  assert.deepEqual(snapshot, before);
});
test('late receipts are candidates after counted stock is protected; pending arrivals are excluded', () => {
  const result = inferProcurementSources({ physical_estimate: 10, batches: [batch(1, 20), { ...batch(2, 50), status: 'pending_arrival' }],
    orders: [{ order_item_id: 1, needs_fulfillment: true, stock_quantity: 5 },
      { order_item_id: 2, entered_transport: true, transport_at: '2026-09-01', missing_record_quantity: 15 }] });
  assert.equal(result.reserves[0].quantity, 5);
  assert.equal(result.suggestions[1].quantity, 10);
  assert.equal(result.suggestions[1].late_registration, true);
  assert.equal(result.historical_unmatched, 5);
  assert.equal(result.suggestions.some(row => row.batch_id === 2), false);
});
test('existing current source is reused as evidence without consuming the batch twice', () => {
  const result = inferProcurementSources({ physical_estimate: 6, batches: [{ ...batch(1, 10), unallocated_quantity: 4 }],
    orders: [{ order_item_id: 1, needs_fulfillment: true, stock_quantity: 6, coverage_trace: [{ batch_id: 1, purchase_order_no: 'PO-1', quantity: 6, purpose: 'source' }] },
      { order_item_id: 2, entered_transport: true, missing_record_quantity: 4 }] });
  assert.deepEqual(result.suggestions.map(row => row.quantity), [6, 4]);
  assert.equal(result.current_unmatched, 0);
});
test('unknown procurement and physical shortfalls remain explicit rather than invented', () => {
  const result = inferProcurementSources({ physical_estimate: 10, batches: [], orders: [{ order_item_id: 1, needs_fulfillment: true, stock_quantity: 3 }, { order_item_id: 2, entered_transport: true, missing_record_quantity: 8 }] });
  assert.equal(result.current_unmatched, 3);
  assert.equal(result.physical_unmatched, 7);
  assert.equal(result.historical_unmatched, 8);
  assert.deepEqual(result.suggestions, []);
});
