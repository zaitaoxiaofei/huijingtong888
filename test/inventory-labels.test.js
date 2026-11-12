import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryLabelItems, inventoryLabelType, validateInventoryLabels, wrapLabelName } from '../frontend/admin/utils/inventory-labels.js';
import { inventoryValuation } from '../frontend/admin/utils/inventory-valuation.js';
const product = { id: 267, inventory_number: '2-6-7', name: '门槛条 VOLGA K40 红色 LOGO定制款 ABS塑料 激光 4个', component_count: 0 };
test('label task deduplicates product identity and preserves full name and per-product copies', () => {
  const items = inventoryLabelItems([product, product, { ...product, id: 268 }]);
  assert.equal(items.length, 2, 'same display number on different product IDs is not merged');
  assert.equal(items[0].name, product.name);
  items[0].quantity = 2; items[1].quantity = 3;
  assert.equal(validateInventoryLabels(items), 5);
  assert.equal(items[0].number, '2-6-7');
  assert.equal(inventoryLabelType(product), '单品');
  assert.equal(inventoryLabelType({ ...product, is_accessory: 1 }), '配件');
  assert.equal(inventoryLabelType({ ...product, is_accessory: 1, component_count: 2 }), '套装');
  assert.equal(inventoryLabelType({ ...product, is_consumable: 1, component_count: 2 }), '耗材');
});
test('invalid or excessive label copies and incomplete inventories cannot generate a PDF', () => {
  for (const quantity of [null, 0, -1, 1.5, NaN, Infinity, 1001, '2']) {
    assert.throws(() => validateInventoryLabels([{ ...inventoryLabelItems([product])[0], quantity }]));
  }
  const [item] = inventoryLabelItems([product]);
  assert.throws(() => validateInventoryLabels([]));
  assert.throws(() => validateInventoryLabels([item, item]), /重复/);
  assert.throws(() => validateInventoryLabels([{ ...item, name: '' }]), /名称/);
  assert.throws(() => validateInventoryLabels([{ ...item, number: '' }]), /编号/);
  assert.throws(() => validateInventoryLabels([{ ...item, quantity: 1000 }, { ...item, id: 268 }]), /分批/);
  assert.equal(validateInventoryLabels([{ ...item, quantity: 1000 }]), 1000);
});
test('wrapping Chinese names retains every visible character without ellipsis', () => {
  const name = '门槛条VOLGAK40红色LOGO定制款ABS塑料激光4个';
  const lines = wrapLabelName(name, text => [...text].length * 10, 120);
  assert.equal(lines.join(''), name);
  assert.ok(lines.every(line => [...line].length <= 12));
});
test('inventory valuation distinguishes known local value from missing FBP and known zero', () => {
  assert.deepEqual(inventoryValuation({ physical_stock: 5, fbp_stock_known: 3, avg_unit_cost: 4 }), { local: 20, fbp: 12, total: 32, reason: '' });
  const partial = inventoryValuation({ physical_stock: 5, fbp_stock_known: null, avg_unit_cost: 4 });
  assert.equal(partial.local, 20); assert.equal(partial.fbp, null); assert.equal(partial.total, null);
  assert.match(partial.reason, /FBP/);
  assert.equal(inventoryValuation({ physical_stock: 0, fbp_stock_known: 0 }).total, 0);
  assert.equal(inventoryValuation({ physical_stock: 5, fbp_stock_known: 0, avg_unit_cost: 0 }).total, 0);
  assert.equal(inventoryValuation({ physical_stock: 5, fbp_stock_known: 0 }).total, null);
  assert.match(inventoryValuation({ physical_stock: null, fbp_stock_known: 0, avg_unit_cost: 4 }).reason, /本地/);
  assert.equal(inventoryValuation({ physical_stock: NaN, fbp_stock_known: 0, avg_unit_cost: 4 }).total, null);
});
