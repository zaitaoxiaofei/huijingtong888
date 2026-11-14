import test from 'node:test';
import assert from 'node:assert/strict';
import { assertInventoryPackage, defaultInventoryPackagingFee } from '../src/shared/inventory-package-defaults.js';

test('new catalog packaging defaults follow CNY selling price including exact boundaries', () => {
  for (const [price, fee] of [[0, 0.3], [1, 0.3], [49.99, 0.3], [50, 0.3], [50.01, 0.5], [100, 0.5], [100.01, 1]]) {
    for (const weight of [0, 40, 1000]) assert.equal(defaultInventoryPackagingFee({ sale_price_rmb: price, package_weight_g: weight }), fee);
  }
  assert.equal(defaultInventoryPackagingFee({ listing_price_rub: 1000, exchange_rate: 10 }), 0.5);
  assert.equal(defaultInventoryPackagingFee({ air_sale_price_rmb: 120 }), 1);
  assert.equal(defaultInventoryPackagingFee({ purchase_cost: 500 }), 0.3, 'purchase price is not selling price');
});

test('stock save requires measured positive finite weight and all three dimensions', () => {
  const complete = { product_type: 'main', package_weight_g: 100, length_cm: 30, width_cm: 20, height_cm: 10 };
  assert.doesNotThrow(() => assertInventoryPackage(complete));
  for (const key of ['package_weight_g', 'length_cm', 'width_cm', 'height_cm']) {
    for (const value of [0, -1, '', null, undefined, 'invalid', Infinity]) {
      assert.throws(() => assertInventoryPackage({ ...complete, [key]: value }), error => error.statusCode === 400 && error.message.includes(key) && error.message.includes('再保存'));
    }
  }
  assert.doesNotThrow(() => assertInventoryPackage({ product_type: 'selection', selection_status: 'draft' }));
  assert.throws(() => assertInventoryPackage({ product_type: 'selection', selection_status: 'listed' }), /包装克重/);
});

test('inventory create API rejects missing weight before opening a database connection', async () => {
  const { createProductMysql } = await import('../src/services/mysql-cutover.js');
  await assert.rejects(createProductMysql({ name: 'missing weight', product_type: 'main', length_cm: 30, width_cm: 20, height_cm: 10 }), error => error.statusCode === 400 && error.message.includes('请在“计量包装”中填写') && error.message.includes('包装克重'));
});
