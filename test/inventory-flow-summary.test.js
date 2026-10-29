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

test('local FBS safety uses shipped physical components and complete Beijing days without FBP snapshots', async () => {
  const { calculateLocalInventorySafety } = await import('../src/services/inventory-flow-summary-model.js');
  const now = new Date('2026-10-29T04:00:00Z');
  const orders = [
    { order_id: 1, order_item_id: 1, quantity: 14, entered_transport: true, transport_at: '2026-10-22T02:00:00Z', stock_location: 'LOCAL' },
    { order_id: 1, order_item_id: 1, quantity: 14, entered_transport: true, transport_at: '2026-10-22T02:00:00Z', stock_location: 'LOCAL' },
    { order_id: 2, order_item_id: 2, quantity: 900, entered_transport: false, needs_fulfillment: true, ordered_at: '2026-10-27T02:00:00Z' },
    { order_id: 3, order_item_id: 3, quantity: 900, entered_transport: false, ordered_at: '2026-10-27T02:00:00Z' },
    { order_id: 4, order_item_id: 4, quantity: 900, entered_transport: true, stock_location: 'FBP', transport_at: '2026-10-27T02:00:00Z' },
    { order_id: 5, order_item_id: 5, quantity: 900, entered_transport: true, transport_at: '2026-10-28T16:00:00Z' },
    { order_id: 6, order_item_id: 6, quantity: 900, entered_transport: true, transport_at: '2026-10-21T15:59:59Z' }
  ];
  const input = { ...ledger, physical_estimate: 170, open_order_demand: 1, fbp_reserved: 0,
    product: { id: 1, production_lead_days: 7, warehouse_logistics_days: 2 }, orders };
  const projection = calculateLocalInventorySafety(input, {}, now);
  assert.equal(projection.consumed_7d, 14); assert.equal(projection.daily_consumption, 2);
  assert.equal(projection.local_days, 9); assert.equal(projection.safety_qty, 18);
  const result = buildInventoryFlowSummary(input, projection);
  assert.equal(result.free, 151);
  assert.equal(result.safety, 18);
});
test('local protection has a 7-day minimum, fractional daily demand rounds to single pieces, and holiday union applies', async () => {
  const { calculateLocalInventorySafety } = await import('../src/services/inventory-flow-summary-model.js');
  const input = { product: { production_lead_days: 1, warehouse_logistics_days: 1 }, orders: [
    { order_id: 1, order_item_id: 1, entered_transport: true, quantity: 3, ordered_at: '2026-10-27T02:00:00Z' }
  ] };
  const p = calculateLocalInventorySafety(input, { holidays: [{ from: '2026-10-29', to: '2026-10-30' }, { from: '2026-10-30', to: '2026-10-30' }] }, new Date('2026-10-29T03:00:00Z'));
  assert.equal(p.local_days, 9); assert.equal(p.safety_qty, 4); assert.equal(p.estimated_dates, 1);
});
