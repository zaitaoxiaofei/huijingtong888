import test from 'node:test';
import assert from 'node:assert/strict';
import { whole, validateFlowSettings, flowLeadDays, calculateFlowProduct } from '../src/services/inventory-flow-rules.js';

const settings = validateFlowSettings({ production_days: 7, local_days: 3 });
const sku = { per_set_quantity: 1, present: 0, available: 0, sales: { w1: 70, w2: 70, w3: 70, w4: 70, d14: 140, d60: 300, fbs7: 70 } };
const product = { created_days: 100, incoming_stock: 100 };
const balance = { physical_stock: 200, open_order_demand_qty: 10, fbp_reserved_qty: 0 };
test('quantities ceil to single pieces, not tens; minimum FBP recommendation is five', () => {
  const p = calculateFlowProduct(product, balance, [{ ...sku, sales: { ...sku.sales, fbs7: 1, d14: 1 } }], settings, '2026-10-28');
  assert.equal(p.safety_qty, 2);
  assert.equal(p.skus[0].suggested_qty, 5);
  assert.throws(() => whole(1.2));
});
test('order demand is outside safety stock and existing FBP reservations reduce free stock', () => {
  const p = calculateFlowProduct(product, { ...balance, fbp_reserved_qty: 90 }, [sku], settings, '2026-10-28');
  assert.equal(p.safety_qty, 100); assert.equal(p.free_qty, 0); assert.equal(p.locked_qty, 90);
});
test('FBP stock moves future demand, zero stock restores local historical demand', () => {
  const a = calculateFlowProduct(product, balance, [{ ...sku, available: 1000, present: 1000 }], settings, '2026-10-28');
  assert.equal(a.safety_qty, 0);
  const b = calculateFlowProduct(product, balance, [sku], settings, '2026-10-28');
  assert.equal(b.safety_qty, 100);
  const c = calculateFlowProduct(product, balance, [{ ...sku, available: 10, present: 10 }], settings, '2026-10-28');
  assert.ok(c.safety_qty > 0); assert.match(c.skus[0].status, /本地接替/);
});
test('unknown stock is not treated as zero or a calculated replenishment', () => {
  const p = calculateFlowProduct(product, balance, [{ ...sku, available: null, present: null }], settings, '2026-10-28');
  assert.equal(p.official_qty, null); assert.equal(p.skus[0].suggested_qty, null); assert.equal(p.stock_incomplete, true);
});
test('incoming reduces future purchase gap but does not add dispatchable stock', () => {
  const a = calculateFlowProduct(product, balance, [sku], settings, '2026-10-28');
  const b = calculateFlowProduct({ ...product, incoming_stock: 10000 }, balance, [sku], settings, '2026-10-28');
  assert.equal(a.free_qty, b.free_qty); assert.equal(b.purchase_qty, 0);
});
test('holiday union extends the whole period once, including chained holidays', () => {
  assert.equal(flowLeadDays(2, 7, [], '2026-10-01'), 7);
  assert.equal(flowLeadDays(10, 7, [{from:'2026-10-01',to:'2026-10-07'},{from:'2026-10-05',to:'2026-10-09'}], '2026-10-01'), 19);
  assert.equal(flowLeadDays(10, 7, [{from:'2026-10-01',to:'2026-10-07'}], '2026-10-07'), 11);
  assert.equal(flowLeadDays(1, 15, [], '2026-10-01'), 15);
});
test('combo consumption expands to real pieces and official stock is expanded once', () => {
  const p = calculateFlowProduct(product, balance, [{ ...sku, per_set_quantity: 2 }], settings, '2026-10-28');
  assert.equal(p.safety_qty, 200);
});
test('purchase multiples round up separately from requirement pieces', () => {
  const p = calculateFlowProduct({ ...product, incoming_stock: 0 }, { ...balance, physical_stock: 0 }, [sku], { ...settings, minimum_order: 12 }, '2026-10-28');
  assert.equal(p.purchase_qty % 12, 0); assert.ok(p.purchase_qty >= p.local_purchase + p.fbp_purchase);
});
test('invalid dates and extreme settings are rejected', () => {
  assert.throws(() => validateFlowSettings({ holidays: [{from:'2026-02-30',to:'2026-03-01'}] }));
  assert.throws(() => validateFlowSettings({ fbp_days: -1 }));
});
