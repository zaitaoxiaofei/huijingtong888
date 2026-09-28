import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryOverview } from '../frontend/orders/utils/inventory-overview.js';

test('two-box virtual product retains its identity and uses already expanded order consumption', () => {
  const view = inventoryOverview({ inventorySummaries: [{ productId: 10, productName: '清洁用品 两盒装', inventoryNumber: '2-10', quantity: 3, componentCount: 1,
    pickingItems: [{ product_id: 11, product_name: '清洁用品 一盒装', inventory_number: '2-11', stock_unit: '盒', required_quantity: 6 }] }] });
  assert.equal(view.parents[0].name, '清洁用品 两盒装');
  assert.equal(view.parents[0].virtual, true);
  assert.equal(view.parents[0].quantity, 3);
  assert.equal(view.parents[0].children[0].quantity, 6, 'do not multiply order consumption twice');
  assert.equal(view.items[0].quantity, 6);
});

test('multiple parents keep their own recipes while shared child coverage remains order-wide', () => {
  const view = inventoryOverview({ inventorySummaries: [10, 20].map(id => ({ productId: id, productName: `礼盒${id}`, quantity: 1, componentCount: 1,
    pickingItems: [{ product_id: 11, product_name: '配件', required_quantity: 2 }] })),
    procurement_coverage: { needs_fulfillment: true, items: [{ product_id: 11, quantity: 4, stock_quantity: 1, incoming_quantity: 0, shortage_quantity: 3 }] } });
  assert.deepEqual(view.parents.map(parent => parent.children[0].quantity), [2, 2]);
  assert.equal(view.items[0].quantity, 4);
  assert.equal(view.parents[0].children[0].shortage, 3);
  assert.equal(inventoryOverview({ inventorySummaries: [{ productId: 1, productName: '单品', quantity: 2 }] }).parents[0].virtual, undefined);
});

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
