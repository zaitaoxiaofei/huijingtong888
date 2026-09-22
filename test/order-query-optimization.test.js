import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { config } from '../src/config.js';
import { getMysqlPool, closeMysqlPool } from '../src/mysql-pool.js';
import mysql from 'mysql2/promise';

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const search = vm.runInNewContext(`(${source.match(/function addOrderSearchSqlMysql\([\s\S]*?\n}/)[0]})`);
const filtered = vm.runInNewContext(`(${source.match(/async function orderFilteredSqlMysql\([\s\S]*?\n}/)[0]})`, {
  orderStatusSqlMysql: () => '1 = 1', addOrderSearchSqlMysql: search
});

test('optimized order predicates bind every search parameter and retain empty search', async () => {
  const where = [], params = [];
  search(where, params, { searchType: 'product', searchQuery: ' J6 ' });
  assert.equal((where[0].match(/\?/g) || []).length, params.length);
  assert.deepEqual([...params], ['%j6%', '%j6%', '%j6%']);
  const empty = [];
  search(empty, [], { searchType: 'product', searchQuery: ' ' });
  assert.equal(empty.length, 0);
});

test('large inventory lists warm logistics once and bound enrichment concurrency without reordering', async () => {
  let active = 0, peak = 0, warmed = 0;
  const map = vm.runInNewContext(`(${source.match(/async function mapWithConcurrencyMysql\([\s\S]*?\n}/)[0]})`);
  const enrich = vm.runInNewContext(`(${source.match(/async function enrichOrderRowsForListMysql\([\s\S]*?\n}/)[0]})`, {
    orderProcurementCoverageMysql: async () => new Map(),
    orderQualityPrefixesMysql: async () => [],
    orderInventoryPickingMysql: async () => new Map(),
    mysqlQuery: async () => [],
    activeOrderLogisticsFilterMethodsMysql: async () => { warmed++; },
    mapWithConcurrencyMysql: map,
    enrichOrderLogisticsMysql: async row => {
      assert.equal(warmed, 1);
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, row.id % 3));
      active--; return row;
    },
    classifyOrderAccounting: () => ({}),
    cancellationDisplay: () => ({}),
    AFTERSALE_BUCKET_LABELS_MYSQL: {}
  });
  const rows = Array.from({ length: 240 }, (_, i) => ({ id: i + 1 }));
  const result = await enrich(rows);
  assert.equal(warmed, 1);
  assert.equal(peak, 3);
  assert.deepEqual(Array.from(result, row => row.id), rows.map(row => row.id));
});

test('MySQL optimized predicates preserve mapping alternatives and missing raw records', {
  skip: process.env.ORDER_QUERY_MYSQL_TEST !== '1'
}, async () => {
  const socketPath = process.env.ORDER_QUERY_MYSQL_SOCKET;
  if (socketPath) assert.equal(socketPath, '/var/run/mysqld/mysqld.sock');
  else {
    assert.equal(config.dbHost, '127.0.0.1');
    assert.match(config.dbName, /_test$/);
  }
  const connection = socketPath
    ? await mysql.createConnection({ socketPath, user: 'root', database: config.dbName })
    : await getMysqlPool().getConnection();
  try {
    // Session-local fixtures shadow real tables and disappear on disconnect.
    for (const sql of [
      'CREATE TEMPORARY TABLE orders (id INT PRIMARY KEY, shop_id INT, posting_number VARCHAR(40))',
      'CREATE TEMPORARY TABLE order_items (id INT PRIMARY KEY, order_id INT, sku_mapping_id INT, ozon_sku VARCHAR(40))',
      'CREATE TEMPORARY TABLE sku_mappings (id INT PRIMARY KEY, shop_id INT, ozon_sku VARCHAR(40), product_id INT, active INT, UNIQUE(shop_id,ozon_sku))',
      'CREATE TEMPORARY TABLE products (id INT PRIMARY KEY, name VARCHAR(80), code VARCHAR(40), selection_id VARCHAR(40), active INT)',
      'CREATE TEMPORARY TABLE ozon_orders_raw (store_id INT, posting_number VARCHAR(40), raw_json TEXT, UNIQUE(store_id,posting_number))',
      "INSERT INTO orders VALUES (1,1,'A'),(2,1,'B'),(3,1,'C'),(4,1,'D'),(5,1,'E'),(6,1,'F')",
      "INSERT INTO products VALUES (1,'Direct J6','P-1','S-1',1),(2,'雨眉','P-2','S-2',1),(3,'Inactive','P-3','S-3',0)",
      "INSERT INTO sku_mappings VALUES (1,2,'other',1,1),(2,1,'sku1',2,1),(3,1,'sku2',1,0),(4,1,'sku3',3,1),(5,1,'sku4',99,1)",
      "INSERT INTO order_items VALUES (1,1,1,'sku1'),(2,2,3,'sku2'),(3,3,4,'sku3'),(4,4,5,'sku4'),(5,5,NULL,'unbound'),(6,6,NULL,'sku1')",
      `INSERT INTO ozon_orders_raw VALUES (1,'A','{"mode":"fbp"}'),(1,'B','{"mode":"fbs"}'),(1,'C',NULL),(1,'D','{"name":"珲春"}'),(1,'E','{"name":"CEL FBP"}')`
    ]) await connection.query(sql);
    // MySQL cannot reopen a temporary table through two aliases; identical
    // session-local copies let the real predicates run against both mappings.
    for (const table of ['sku_mappings', 'products']) {
      for (const suffix of ['direct', 'fallback']) {
        await connection.query(`CREATE TEMPORARY TABLE ${table}_${suffix} AS SELECT * FROM ${table}`);
      }
    }
    const oldSearch = `EXISTS (SELECT 1 FROM order_items oi
      LEFT JOIN sku_mappings sm ON (sm.id=oi.sku_mapping_id OR (sm.shop_id=o.shop_id AND sm.ozon_sku=oi.ozon_sku)) AND sm.active=1
      LEFT JOIN products p ON p.id=sm.product_id AND p.active=1
      WHERE oi.order_id=o.id AND LOWER(CONCAT(COALESCE(p.name,''),' ',COALESCE(p.code,''),' ',COALESCE(p.selection_id,''),' ',oi.ozon_sku)) LIKE ?)`;
    for (const keyword of ['j6', '雨眉', 'sku1', 'sku2', 'sku3', 'sku4', 'unbound', 'inactive', 'missing', '%', '_', 'p-2']) {
      const where = [], params = [];
      search(where, params, { searchType: 'product', searchQuery: keyword });
      const predicate = where[0]
        .replace('sku_mappings direct_sm', 'sku_mappings_direct direct_sm')
        .replace('sku_mappings fallback_sm', 'sku_mappings_fallback fallback_sm')
        .replace('products direct_p', 'products_direct direct_p')
        .replace('products fallback_p', 'products_fallback fallback_p');
      const [before] = await connection.query(`SELECT o.id FROM orders o WHERE ${oldSearch} ORDER BY o.id`, [`%${keyword}%`]);
      const [after] = await connection.query(`SELECT o.id FROM orders o WHERE ${predicate} ORDER BY o.id`, params);
      assert.deepEqual(after, before, keyword);
    }
    for (const type of ['fbs', 'fbp', 'all']) {
      const clause = await filtered({ fulfillmentType: type }, { where: '1 = 1', params: [] });
      const [rows] = await connection.query(`SELECT o.id FROM orders o WHERE ${clause.where} ORDER BY o.id`, clause.params);
      assert.deepEqual(rows.map(row => row.id), type === 'fbs' ? [2,3,6] : type === 'fbp' ? [1,4,5] : [1,2,3,4,5,6]);
    }
  } finally {
    connection.destroy();
    await closeMysqlPool();
  }
});
