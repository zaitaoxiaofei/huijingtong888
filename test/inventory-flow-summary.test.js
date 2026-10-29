import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInventoryFlowSummary } from '../src/services/inventory-flow-summary-model.js';
import { inventoryLedgerView } from '../src/services/inventory-ledger-view.js';

const ledger = { product: { id: 1 }, physical_estimate: 200, open_order_demand: 10, fbp_reserved: 90,
  available_estimate: 100, incoming_quantity: 300, current_incoming: 20, current_shortage: 0,
  purchases: [{ id: 5, pending_quantity: 300, amount: 999, purchase_cost: 44 }] };
const forecast = { safety_qty: 100, local_days: 10, fbp_days: 17, skus: [], stock_incomplete: false };
test('physical 200 is allocated to actual orders 10, future safety 100, confirmed FBP 90 once', () => {
  const before = structuredClone(ledger);
  const summary = buildInventoryFlowSummary(ledger, forecast, [], [{ requested_quantity: 150, locked_quantity: 90, status: 'approved' }]);
  assert.equal(summary.free, 0);
  assert.equal(summary.requested, 150);
  assert.equal(summary.unoccupied, 100);
  assert.equal(summary.protection_gap, 0);
  assert.equal(summary.incoming, 300);
  assert.deepEqual(ledger, before);
  assert.equal(summary.purchases[0].amount, undefined);
  assert.equal(summary.purchases[0].purchase_cost, undefined);
  assert.deepEqual(inventoryLedgerView({ ...ledger, flow_summary: summary }).flow_summary, summary);
});
test('unknown safety/negative physical never reports dispatchable surplus; zero remains a known value', () => {
  for (const value of [null, { ...forecast, stock_incomplete: true }, { ...forecast, needs_review: true }]) {
    const summary = buildInventoryFlowSummary(ledger, value);
    assert.equal(summary.safety, null); assert.equal(summary.free, null);
  }
  assert.equal(buildInventoryFlowSummary({ ...ledger, physical_estimate: -2 }, forecast).free, null);
  assert.equal(buildInventoryFlowSummary({ ...ledger, physical_estimate: 10, fbp_reserved: 0 }, { ...forecast, safety_qty: 0 }).free, 0);
});
test('locked stock remains committed when later demand rises, exposing protection gap without reallocating it', () => {
  const summary = buildInventoryFlowSummary({ ...ledger, open_order_demand: 30 }, forecast);
  assert.equal(summary.locked, 90); assert.equal(summary.free, 0); assert.equal(summary.protection_gap, 20);
});
