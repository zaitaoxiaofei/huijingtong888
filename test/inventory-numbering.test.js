import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildProductDisplayRows, buildInventoryPickingSummary } from '../frontend/orders/utils/order-display.js';

const pickingSource = readFileSync(new URL('../src/services/order-inventory-picking.js', import.meta.url), 'utf8');
const context = vm.createContext({ mysqlQuery: async () => [] });
vm.runInContext(pickingSource.replace(/^import .*;\n/m, '').replaceAll('export ', ''), context);

test('order inventory number follows its SKU without replacing the product identity', () => {
  const rows = buildProductDisplayRows({skus:'a,b',sku_product_ids:'a:11,b:12',sku_inventory_numbers:'a:1-235||b:3-9',sku_inventory_names:'a:钥匙壳||b:贴纸'});
  assert.equal(rows[0].inventoryNumber, '1-235'); assert.equal(rows[0].productId, 11);
  assert.equal(rows[1].inventoryNumber, '3-9'); assert.equal(rows[1].inventoryName, '贴纸');
});

test('component demand multiplies by ordered sets and sums repeated items without mixing orders', () => {
  const base = {order_id:1,sku:'a',parent_product_id:7,product_id:10,inventory_number:'3-1',per_set_quantity:2,order_quantity:2};
  const grouped = context.groupInventoryPickingRows([base,{...base,order_quantity:3},{...base,order_id:2,order_quantity:1}]);
  assert.equal(grouped.get(1).length,1); assert.equal(grouped.get(1)[0].required_quantity,10);
  assert.equal(grouped.get(1)[0].per_set_quantity,2); assert.equal(grouped.get(2)[0].required_quantity,2);
});

test('SKU recipes and product components are mutually exclusive and page scoped', () => {
  assert.match(pickingSource,/pc\.product_id = p\.id AND recipe\.id IS NULL/);
  assert.match(pickingSource,/WHERE oi\.order_id IN/);
  assert.match(pickingSource,/COALESCE\(direct_mapping\.id/);
});

test('two SKUs bound to one parent add their child demand in the displayed summary', () => {
  const rows = [{sku:'a',parent_product_id:7,product_id:10,per_set_quantity:2,required_quantity:4},
    {sku:'b',parent_product_id:7,product_id:10,per_set_quantity:2,required_quantity:6}];
  assert.equal(buildInventoryPickingSummary(rows, {inventoryMode:'single',productId:7})[0].required_quantity, 10);
  assert.equal(buildInventoryPickingSummary(rows, {inventoryMode:'combo',sku:'a'})[0].required_quantity, 4);
});
