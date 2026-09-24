import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryOverview } from '../frontend/orders/utils/inventory-overview.js';

test('inventory overview merges per-order coverage, not global incoming, and sorts shortages first', () => {
  const row = { inventorySummaries: [{ pickingItems: [
    { product_id: 1, product_name: '配件 A', inventory_number: '1-1', required_quantity: 2 },
    { product_id: 2, product_name: '配件 B', inventory_number: '2-1', required_quantity: 3 }
  ] }], procurement_coverage: { needs_fulfillment: true, stock_location: 'LOCAL', inventory_needs_review: true, items: [
    { product_id: 1, quantity: 1, stock_quantity: 1, incoming_quantity: 0, shortage_quantity: 0, product_total_incoming_quantity: 100 },
    { product_id: 1, quantity: 1, stock_quantity: 0, incoming_quantity: 1, shortage_quantity: 0, product_total_incoming_quantity: 100 },
    { product_id: 2, quantity: 3, stock_quantity: 0, incoming_quantity: 1, shortage_quantity: 2 }
  ] } };
  const view = inventoryOverview(row);
  assert.deepEqual(view.items.map(item => item.product_id), [2, 1]);
  assert.equal(view.items[1].quantity, 2);
  assert.equal(view.items[1].incoming_quantity, 1);
  assert.equal(view.items[1].inventory_number, '1-1');
  assert.equal(view.shortageCount, 1);
  assert.equal(view.coveredCount, 1);
  assert.equal(view.review, true);
});

test('unknown, historical and FBP rows do not invent local coverage', () => {
  const row = { inventorySummaries: [{ productId: 1, productName: '配件', quantity: 2 }] };
  assert.equal(inventoryOverview(row).active, false);
  assert.equal(inventoryOverview(row).items[0].stock_quantity, undefined);
  assert.equal(inventoryOverview(row).coveredCount, 0);
  assert.equal(inventoryOverview({ ...row, procurement_coverage: { needs_fulfillment: true, stock_location: 'FBP' } }).active, false);
  const review = inventoryOverview({ ...row, procurement_coverage: { needs_fulfillment: true, items: [
    { product_id: 1, quantity: 2, shortage_quantity: 0, quantity_needs_review: true }
  ] } });
  assert.equal(review.coveredCount, 0);
  assert.equal(review.items[0].stock_quantity, undefined);
});
