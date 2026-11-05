import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryAliasSearch, inventoryIdentifierSearch, isInventoryIdentifier, inventoryNamePattern, inventoryNumberQueryMode, inventoryPrefixPattern, searchInventoryRows } from '../src/services/inventory-search.js';
import { inventoryProductSearch, filterInventoryProductRows, inventoryBusinessSearch } from '../src/services/inventory-product-search.js';
import mysql from 'mysql2/promise';

test('identifier modes use separate equality branches without fuzzy fallback', () => {
  const id = inventoryIdentifierSearch(' 1-23 ', 'inventory_id');
  assert.deepEqual(id.params, ['1-23', '1-23', '1-23', '1-23']);
  assert.doesNotMatch(id.sql, /sku_mappings|LIKE/);
  const sku = inventoryIdentifierSearch('123', 'sku');
  assert.doesNotMatch(sku.sql, /FROM products/);
  assert.deepEqual(sku.params, ['123', '123']);
  assert.match(sku.sql, /UNION ALL/);
  assert.equal(isInventoryIdentifier('P-20260915-094232-001'), true);
  assert.equal(isInventoryIdentifier('钥匙壳'), false);
  assert.equal(inventoryNamePattern('50%_='), '%50=%=_==%');
});
test('three-part and old numbers stay exact while explicit category/brand prefixes retain boundaries', () => {
  assert.equal(inventoryNumberQueryMode('1-3'), 'inventory_id');
  assert.equal(inventoryNumberQueryMode('1-3-1'), 'inventory_id');
  assert.equal(inventoryNumberQueryMode('1-3-'), 'inventory_prefix');
  for (const [value, expected] of [['1-3','1-3-%'],['1-3-','1-3-%'],['1-3-1','1-3-1%']]) {
    assert.equal(inventoryPrefixPattern(value), expected);
    const found=inventoryIdentifierSearch(value,'inventory_prefix');
    assert.deepEqual(found.params,[expected]);
    assert.doesNotMatch(found.sql,/inventory_number_aliases|code =|sku_mappings/);
  }
  for(const invalid of ['1','1-','1-3-%','1-3-1-','1_3','1-3=']) assert.equal(inventoryPrefixPattern(invalid),null);
  assert.deepEqual(inventoryIdentifierSearch('1_23','inventory_id').params,Array(4).fill('1-23'));
  const rows=['1-3-1','1-3-10','1-30-1','11-3-1'].map((inventory_number, i)=>({product_id:i+1,inventory_number}));
  assert.deepEqual(searchInventoryRows(rows,'1-3-'),rows.slice(0,2));
  assert.deepEqual(searchInventoryRows(rows,'1-3-1'),[rows[0]]);
  assert.equal(searchInventoryRows(rows,'1-3').length,0);
});
test('historical alias ownership is independently tenant checked and escaped for fuzzy matching',()=>{
  const exact=inventoryAliasSearch('1-23','p');
  assert.match(exact.sql,/p\.tenant_id = number_alias\.tenant_id/);
  assert.match(exact.sql,/p\.tenant_id IS NULL AND number_alias_tenant\.slug = 'default'/);
  assert.match(exact.sql,/number_alias_tenant\.status = 'active'/);
  assert.deepEqual(inventoryAliasSearch('50%_=', 'p', {fuzzy:true}).params,['%50=%=_==%']);
  assert.throws(()=>inventoryAliasSearch('1-2','p;bad'));
  const criteria=inventoryProductSearch({searchMode:'inventory_id',query:'1-23'},{id:2,isDefault:false});
  assert.match(criteria.sql,/inventory_number_aliases/);
  assert.equal((criteria.sql.match(/\?/g)||[]).length,criteria.params.length);
});
test('cached number searches resolve IDs in SQL without bypassing cached hidden/tenant boundaries',async()=>{
  const rows=[{product_id:10,inventory_number:'1-3-1'},{product_id:11,inventory_number:'1-3-10'}],scope={id:2,isDefault:false};
  const calls=[];
  const execute=async(sql,params)=>{calls.push({sql,params});return[{id:10},{id:99}];};
  assert.deepEqual(await filterInventoryProductRows(rows,{searchMode:'inventory_id',query:'9-8'},scope,execute),[rows[0]]);
  assert.match(calls[0].sql,/p\.tenant_id = 2/);
  assert.match(calls[0].sql,/inventory_number_aliases/);
  assert.equal(rows[0].aliases,undefined);
  assert.deepEqual(await filterInventoryProductRows(rows,{query:'9-'},scope,execute),[rows[0]]);
  assert.deepEqual(await filterInventoryProductRows(rows,{query:'1-3-1'},scope,async()=>[]),[]);
  assert.equal(inventoryBusinessSearch({query:'1-3'}).query,'');
  assert.equal(inventoryBusinessSearch({query:'采购单号'}).query,'采购单号');
  assert.equal(inventoryBusinessSearch({query:'9-'},true).query,'');
  assert.equal(inventoryBusinessSearch({inventorySku:'EXACT-SKU'},true).inventorySku,'EXACT-SKU');
});
test('generated legacy codes narrow by creation time and retain original formatting', () => {
  const result = inventoryIdentifierSearch('P-20260915-094232-001', 'inventory_id');
  assert.equal(result.params.at(-2), '2026-09-15 09:42:32');
  assert.match(result.sql, /created_at = \?/);
  assert.match(result.sql, /LPAD\(id, 3, '0'\)/);
  assert.doesNotMatch(inventoryIdentifierSearch('P-20260230-094232-001').sql, /created_at/);
});
test('MySQL finds stored codes, generated legacy codes, large IDs and active SKU mappings', {skip: !process.env.TENANT_TEST_MYSQL_SOCKET && process.env.INVENTORY_SEARCH_TEST_MYSQL !== '1'}, async () => {
  const db = `inventory_search_test_${process.pid}_${Date.now()}`;
  const connection = await mysql.createConnection({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET || '/var/run/mysqld/mysqld.sock',user:'root'});
  try {
    assert.equal(Number((await connection.query('SELECT @@skip_networking isolated'))[0][0].isolated),1,'Only the isolated test server is permitted');
    await connection.query(`CREATE DATABASE ${db}`);
    await connection.query(`USE ${db}`);
    await connection.query('CREATE TABLE products (id INT PRIMARY KEY, inventory_number VARCHAR(64), code VARCHAR(64), selection_id VARCHAR(64), created_at DATETIME, tenant_id INT, INDEX(created_at))');
    await connection.query('CREATE TABLE tenants (id INT PRIMARY KEY, slug VARCHAR(32), status VARCHAR(32))');
    await connection.query('CREATE TABLE inventory_number_aliases (alias_number VARCHAR(64) PRIMARY KEY, product_id INT, tenant_id INT NOT NULL)');
    await connection.query("INSERT INTO tenants VALUES (1,'default','active')");
    await connection.query('CREATE TABLE sku_mappings (product_id INT, active INT, ozon_sku VARCHAR(64), offer_id VARCHAR(64))');
    await connection.query("INSERT INTO products VALUES (1,'1-1','P-20260915-094232-001',NULL,'2026-09-15 09:42:32',1),(1001,'1-2','legacy',NULL,'2026-09-14 10:00:00',1)");
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
