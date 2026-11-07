import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryIdentifierSearch, isInventoryIdentifier, inventoryNamePattern } from '../src/services/inventory-search.js';
import mysql from 'mysql2/promise';

test('identifier modes use separate equality branches without fuzzy fallback', () => {
  const id = inventoryIdentifierSearch(' 1-23 ', 'inventory_id');
  assert.deepEqual(id.params, ['1-23', '1-23', '1-23']);
  assert.doesNotMatch(id.sql, /sku_mappings|LIKE/);
  const sku = inventoryIdentifierSearch('123', 'sku');
  assert.doesNotMatch(sku.sql, /FROM products/);
  assert.deepEqual(sku.params, ['123', '123']);
  assert.match(sku.sql, /UNION ALL/);
  assert.equal(isInventoryIdentifier('P-20260915-094232-001'), true);
  assert.equal(isInventoryIdentifier('钥匙壳'), false);
  assert.equal(inventoryNamePattern('50%_='), '%50=%=_==%');
});
test('generated legacy codes narrow by creation time and retain original formatting', () => {
  const result = inventoryIdentifierSearch('P-20260915-094232-001', 'inventory_id');
  assert.equal(result.params.at(-2), '2026-09-15 09:42:32');
  assert.match(result.sql, /created_at = \?/);
  assert.match(result.sql, /LPAD\(id, 3, '0'\)/);
  assert.doesNotMatch(inventoryIdentifierSearch('P-20260230-094232-001').sql, /created_at/);
});
test('MySQL finds stored codes, generated legacy codes, large IDs and active SKU mappings', {skip: process.env.INVENTORY_SEARCH_TEST_MYSQL !== '1'}, async () => {
  const db = `inventory_search_test_${process.pid}_${Date.now()}`;
  const connection = await mysql.createConnection({socketPath:'/var/run/mysqld/mysqld.sock',user:'root'});
  try {
    await connection.query(`CREATE DATABASE ${db}`);
    await connection.query(`USE ${db}`);
    await connection.query('CREATE TABLE products (id INT PRIMARY KEY, inventory_number VARCHAR(64), code VARCHAR(64), selection_id VARCHAR(64), created_at DATETIME, INDEX(created_at))');
    await connection.query('CREATE TABLE sku_mappings (product_id INT, active INT, ozon_sku VARCHAR(64), offer_id VARCHAR(64))');
    await connection.query("INSERT INTO products VALUES (1,'1-1','P-20260915-094232-001',NULL,'2026-09-15 09:42:32'),(1001,'1-2','legacy',NULL,'2026-09-14 10:00:00')");
    await connection.query("INSERT INTO sku_mappings VALUES (1,1,'sku','offer'),(1001,0,'sku','offer')");
    for (const [value,mode,expected] of [['1-1','inventory_id',[1]],['P-20260915-094232-001','inventory_id',[1]],['P-20260914-100000-100','inventory_id',[1001]],['P-20260914-100000-101','inventory_id',[]],['sku','sku',[1]],['sku','inventory_id',[]],['legacy','inventory_id',[1001]]]) {
      const {sql,params} = inventoryIdentifierSearch(value,mode);
      const [rows] = await connection.query(sql,params);
      assert.deepEqual(rows.map(row=>row.product_id),expected,value);
    }
  } finally {
    await connection.query(`DROP DATABASE IF EXISTS ${db}`);
    await connection.end();
  }
});
