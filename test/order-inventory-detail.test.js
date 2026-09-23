import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeLedger, planLedgerAction, planReceiptCorrection } from '../src/services/procurement-ledger.js';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';

test('physical count restores open deductions and stocktake does not double credit them', () => {
  const state = summarizeLedger({ id: 10 }, [{ quantity_delta: -7, stock_location: 'LOCAL' }], [],
    [{ needs_fulfillment: true, outbound_quantity: 2, stock_quantity: 0 }]);
  assert.equal(state.physical_estimate, -5);
  const plan = planLedgerAction({ ...state, revision: 'v' }, { revision: 'v', action_type: 'stocktake', counted_quantity: 0, reason: '库管实盘确认' });
  assert.equal(plan.local_delta, 5);
  // After verified opening count: ledger -2, then receive 5, then ship 2.
  const remaining = summarizeLedger({ id: 10 }, [{ quantity_delta: 3, stock_location: 'LOCAL' }], [], []);
  assert.equal(remaining.physical_estimate, 3);
  const result = calculateOrderProcurementCoverage({
    stocks: [{ product_id: 10, ledger: 2, open_deducted: 1 }],
    demands: [{ order_id: 3, order_item_id: 3, product_id: 10, quantity: 1, needs_fulfillment: 1, stock_location: 'LOCAL' }]
  });
  assert.equal(result.get(3).shortage_quantity, 0);
  assert.equal(result.get(3).stock_quantity, 1);
});

test('historical receipt requires explicit inventory effect and source-only receipts cannot remove stock on correction', () => {
  const snapshot = { revision: 'v', product: { id: 10 }, orders: [{ order_item_id: 1, entered_transport: true, missing_record_quantity: 2 }],
    batches: [{ id: 8, status: 'pending_arrival', unallocated_quantity: 2 }] };
  const body = { revision: 'v', action_type: 'receive', reason: '已计入盘点', order_item_id: 1, inbound_id: 8, quantity: 2 };
  assert.throws(() => planLedgerAction(snapshot, body), /库存影响/);
  assert.equal(planLedgerAction(snapshot, { ...body, inventory_effect: 'already_accounted' }).local_delta, 0);
  assert.equal(planLedgerAction(snapshot, { ...body, inventory_effect: 'missing_inbound' }).local_delta, 2);
  assert.equal(planReceiptCorrection([{ id: 8, quantity: 2, local_posted_quantity: 0, status: 'approved' }], 2, 1)[0].delta, 0);
});

test('order inventory dialog mounts on demand and history actions are order-specific', () => {
  const page = readFileSync(new URL('../frontend/orders/OrdersPage.vue', import.meta.url), 'utf8');
  const table = readFileSync(new URL('../frontend/orders/components/OrdersTable.vue', import.meta.url), 'utf8');
  assert.match(page, /ProcurementLedgerDialog v-if="inventoryDetail.visible"/);
  assert.match(page, /:order-id="inventoryDetail.orderId"/);
  assert.match(table, /item.missing_purchase_quantity > 0 \|\| item.missing_receipt_quantity > 0/);
  assert.match(table, /emit\('view-inventory-detail', row, item.product_id\)/);
});
