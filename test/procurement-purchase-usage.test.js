import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPurchaseUsage, availableHistoryBatches } from '../src/services/procurement-purchase-usage.js';
import { planLedgerAction } from '../src/services/procurement-ledger.js';

test('500 received = 495 shipped + 3 current + 2 unattributed; pending receipts are not used stock', () => {
  const snapshot = { purchases: [{ id: 1, received_quantity: 500 }, { id: 2, received_quantity: 40 }],
    batches: [{ id: 10, purchase_order_item_id: 1, status: 'approved' }, { id: 11, purchase_order_item_id: 1, status: 'approved' },
      { id: 12, purchase_order_item_id: 1, status: 'pending_arrival' }, { id: 13, purchase_order_item_id: 2, status: 'approved' }],
    orders: [{ entered_transport: true, order_item_id: 1, coverage_trace: [
      { batch_id: 10, quantity: 400, purpose: 'source', basis: 'recorded' }, { batch_id: 11, quantity: 95, purpose: 'source', basis: 'fifo' },
      { batch_id: 12, quantity: 30, purpose: 'receipt_pending' }] },
    { entered_transport: true, stock_location: 'FBP', coverage_trace: [{ batch_id: 13, quantity: 20, purpose: 'source' }] }],
    source_inference: { suggestions: [{ batch_id: 11, quantity: 3, purpose: 'stock_suggestion', already_allocated: true }] } };
  const before = structuredClone(snapshot), usage = buildPurchaseUsage(snapshot);
  assert.equal(usage.get(1).shipped_usage, 495);
  assert.equal(usage.get(1).current_usage, 3);
  assert.equal(usage.get(1).unattributed_usage, 2);
  assert.equal(usage.get(2).shipped_usage, 0);
  assert.equal(usage.get(2).unattributed_usage, 40);
  assert.deepEqual(snapshot, before);
});
test('available history batches protect physical sources and exclude pending batches', () => {
  const result = availableHistoryBatches({ batches: [{ id: 1, status: 'approved', unallocated_quantity: 10 }, { id: 2, status: 'pending_arrival', unallocated_quantity: 50 }],
    source_inference: { reserves: [{ batch_id: 1, quantity: 2 }], suggestions: [
      { batch_id: 1, quantity: 3, purpose: 'stock_suggestion' }, { batch_id: 1, quantity: 20, purpose: 'stock_suggestion', already_allocated: true }] } });
  assert.equal(result.length, 1);
  assert.equal(result[0].available_history_quantity, 5);
});
const snapshot = { product: { id: 1 }, local_stock: 10, revision: 'v1', orders: [1, 2, 3].map(id => ({ order_item_id: id, order_id: id,
  posting_number: `O-${id}`, entered_transport: true, missing_purchase_quantity: 2, missing_record_quantity: 2 })) };
const body = { action_type: 'historical_purchase_bulk', revision: 'v1', reason: '核对采购凭证', order_item_ids: [2, 3], quantity: 4,
  amount: 100, shipping_amount: 10, purchased_at: '2026-10-06T00:00:00+08:00', inventory_effect: 'already_accounted' };
test('bulk backfill touches only selected orders and leaves physical inventory unchanged', () => {
  const plan = planLedgerAction(snapshot, body);
  assert.deepEqual(plan.allocations.map(row => row.order_item_id), [2, 3]);
  assert.equal(plan.local_delta, 0);
  assert.equal(plan.allocations.reduce((sum, row) => sum + row.amount, 0), 100);
  assert.equal(plan.allocations.reduce((sum, row) => sum + row.shipping_amount, 0), 10);
});
test('selected backfill rejects partial quantities, invalid selections and stock changes', () => {
  for (const changes of [{ quantity: 3 }, { order_item_ids: [2, 99] }, { order_item_ids: [2, 2] }, { order_item_ids: [] }, { reconcile_stock: true }, { amount: 0 }]) {
    assert.throws(() => planLedgerAction(snapshot, { ...body, ...changes }));
  }
  assert.throws(() => planLedgerAction({ ...snapshot, orders: snapshot.orders.map(row => ({ ...row, missing_purchase_quantity: 0 })) }, body));
});
