import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderProfitDetailSnapshotPayload } from '../src/services/order-profit-detail-snapshots.js';
import { buildOrderProfitDetail } from '../frontend/orders/utils/order-profit-detail.js';
import { mobileOrderProfitDetail, profitAmountText, profitRowValue } from '../frontend/admin/views/mobile/mobile-order-profit.js';

test('mobile uses the complete desktop snapshot and all order items without replacing saved estimates', () => {
  const order = { id: 1, status: 'awaiting_packaging', estimated_profit: 999, actual_profit: 999 };
  const items = [
    { id: 11, quantity: 2, sale_price: 40, frozen_purchase_cost: 5, frozen_international_shipping: 2, estimated_profit: 60 },
    { id: 12, quantity: 1, sale_price: 30, frozen_purchase_cost: 8, frozen_international_shipping: 3, estimated_profit: 17 }
  ];
  const snapshot = buildOrderProfitDetailSnapshotPayload(order, items, []);
  const before = JSON.stringify({ order, items, snapshot });
  const result = mobileOrderProfitDetail({ order, items, finance: [], profit_detail_snapshot: snapshot });
  assert.deepEqual(result, buildOrderProfitDetail(order, items, [], snapshot));
  assert.equal(result.fromSnapshot, true);
  assert.equal(result.rows.find(row => row.key === 'sale').estimated, 110);
  assert.equal(result.rows.find(row => row.key === 'purchase').estimated, 18);
  assert.equal(result.rows.find(row => row.key === 'profit').estimated, 77);
  assert.equal(result.summary.actualProfitReady, false);
  assert.equal(profitRowValue(result.rows.find(row => row.key === 'profit'), 'actual'), '--');
  assert.equal(JSON.stringify({ order, items, snapshot }), before);
});

test('saved zero, negative differences and unknown historical fees remain distinct', () => {
  const snapshot = { summary: { estimatedProfit: null, actualProfit: 0, actualProfitReady: true }, detailRows: [
    { key: 'purchase', estimated: null, estimatedText: '未留存完整预估依据', actual: 8, diff: null },
    { key: 'profit', estimated: 5, actual: 0, diff: -5 }
  ] };
  const result = mobileOrderProfitDetail({ profit_detail_snapshot: snapshot });
  assert.equal(profitRowValue(result.rows[0], 'estimated'), '未留存完整预估依据');
  assert.equal(profitRowValue(result.rows[0], 'diff'), '--');
  assert.equal(profitRowValue(result.rows[1], 'actual'), 'CNY 0.00');
  assert.equal(profitRowValue(result.rows[1], 'diff'), 'CNY -5.00');
  assert.equal(profitAmountText(2, true), 'CNY +2.00');
  for (const missing of [null, undefined, '', 'invalid']) assert.equal(profitAmountText(missing), '未记录');
});

test('missing structured detail never creates a zero-valued estimate from current products', () => {
  assert.equal(mobileOrderProfitDetail(null), null);
  assert.equal(mobileOrderProfitDetail({ order: { estimated_profit: 0 }, items: [{ sale_price: 100 }] }), null);
  assert.equal(mobileOrderProfitDetail({ profit_detail_snapshot: { summary: {}, detailRows: [] } }), null);
});
