import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { SKU_ORDER_TRACKERS_SCHEMA, skuOrderTrackerSchemaState } from '../src/services/sku-order-tracking-schema.js';

const columns = [{ Field: 'tenant_id', Type: 'bigint unsigned', Null: 'NO' }];
const indexes = [
  ['uk_sku_order_tracker_tenant_shop_sku', ['tenant_id', 'shop_id', 'ozon_sku'], 0],
  ['idx_sku_order_tracker_tenant_active_shop', ['tenant_id', 'active', 'shop_id'], 1]
].flatMap(([Key_name, names, Non_unique]) => names.map((Column_name, index) => ({ Key_name, Column_name, Non_unique, Seq_in_index: index + 1, Sub_part: null })));

test('tracker readiness validates actual column/nullability and complete index definitions', () => {
  assert.equal(skuOrderTrackerSchemaState(columns, indexes).ready, true);
  for (const value of [[], [{ ...columns[0], Null: 'YES' }], [{ ...columns[0], Type: 'varchar(64)' }]]) {
    assert.equal(skuOrderTrackerSchemaState(value, indexes).ready, false);
  }
  for (const value of [
    indexes.slice(1), indexes.map(row => ({ ...row, Non_unique: 1 })),
    indexes.map(row => ({ ...row, Sub_part: 3 })),
    indexes.map(row => ({ ...row, Column_name: row.Column_name === 'tenant_id' ? 'shop_id' : row.Column_name })),
    [...indexes, { Key_name: 'uk_sku_order_tracker', Column_name: 'shop_id', Seq_in_index: 1, Non_unique: 0 }],
    [...indexes, { Key_name: 'unknown_global_sku', Column_name: 'ozon_sku', Seq_in_index: 1, Non_unique: 0 }]
  ]) assert.equal(skuOrderTrackerSchemaState(columns, value).ready, false);
});

test('100 cold tracker callers share one schema check and a rejected check can be retried', async () => {
  const calls = [];
  let valid = false;
  const source = readFileSync(new URL('../src/services/sku-order-tracking.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({
    SKU_ORDER_TRACKERS_SCHEMA, skuOrderTrackerSchemaState,
    mysqlExecute: async sql => { calls.push(sql); await Promise.resolve(); },
    mysqlQuery: async sql => { calls.push(sql); await Promise.resolve(); return sql.startsWith('SHOW COLUMNS') ? valid ? columns : [] : indexes; }
  });
  vm.runInContext(source, context);
  const failed = await Promise.allSettled(Array.from({ length: 100 }, () => context.ensureSchema()));
  assert.equal(failed.filter(row => row.status === 'rejected' && row.reason.code === 'TENANT_SKU_TRACKER_MIGRATION_REQUIRED').length, 100);
  assert.equal(calls.filter(sql => sql === SKU_ORDER_TRACKERS_SCHEMA).length, 1);
  assert.equal(calls.filter(sql => sql === 'SHOW COLUMNS FROM sku_order_trackers').length, 1);
  valid = true;
  await Promise.all(Array.from({ length: 100 }, () => context.ensureSchema()));
  assert.equal(calls.filter(sql => sql === SKU_ORDER_TRACKERS_SCHEMA).length, 2);
  assert.equal(calls.filter(sql => sql === 'SHOW INDEX FROM sku_order_trackers').length, 2);
  await context.ensureSchema();
  assert.equal(calls.length, 6);
});
