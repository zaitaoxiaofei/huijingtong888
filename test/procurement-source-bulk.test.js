import test from 'node:test';
import assert from 'node:assert/strict';
import { planLedgerAction } from '../src/services/procurement-ledger.js';

const snapshot = { product: { id: 10 }, local_stock: 2, revision: 'r1', physical_estimate: 2, orders: [1, 2].map(id => ({ order_item_id: id, order_id: id,
  entered_transport: true, missing_record_quantity: 4, stock_location: 'LOCAL' })),
  batches: [{ id: 7, status: 'approved', quantity: 10, unallocated_quantity: 10 }] };
const body = { revision: 'r1', action_type: 'link_purchase_bulk', inbound_id: 7, reason: '核对采购及发货凭证',
  allocations: [{ order_item_id: 1, quantity: 4 }, { order_item_id: 2, quantity: 4 }] };
test('bulk source reconciliation keeps stock unchanged and preserves allocations', () => {
  const plan = planLedgerAction(snapshot, body);
  assert.equal(plan.quantity, 8);
  assert.equal(plan.local_delta, 0);
  assert.deepEqual(plan.allocations, body.allocations);
});
test('bulk reconciliation rejects duplicates, stale revisions, excess and pending receipts', () => {
  assert.throws(() => planLedgerAction(snapshot, { ...body, revision: 'old' }), /刷新/);
  assert.throws(() => planLedgerAction(snapshot, { ...body, allocations: [body.allocations[0], body.allocations[0]] }), /重复/);
  assert.throws(() => planLedgerAction({ ...snapshot, physical_estimate: 5 }, body), /剩余可核对数量不足/);
  assert.throws(() => planLedgerAction({ ...snapshot, batches: [{ ...snapshot.batches[0], status: 'pending_arrival' }] }, body), /有效采购/);
});
