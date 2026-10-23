import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { orderTransportEvidenceSql, automaticCancellationReturnSql } from '../src/services/order-transport-evidence.js';

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const orderTenantPredicateMysql = vm.runInNewContext('('+source.match(/^function orderTenantPredicateMysql\([^]*?^}/m)[0]+')');
const scopeContext = {orderTenantPredicateMysql,orderOwnershipTenantScopeMysql:async()=>({id:1,defaultTenant:true}),orderListTenantScopeMysql:async()=>({id:1,defaultTenant:true}),assertOrderTaskAccessMysql:async()=>{}};
function database() {
  const db = new DatabaseSync(':memory:');
  db.function('CONCAT_WS', { varargs: true }, (sep, ...args) => args.filter(v => v != null).join(sep));
  db.function('CONCAT', { varargs: true }, (...args) => args.join(''));
  db.function('regexp', (pattern, value) => Number(new RegExp(pattern).test(value || '')));
  db.exec(`CREATE TABLE shops(id INTEGER,tenant_id INTEGER); INSERT INTO shops VALUES(1,1);
    CREATE TABLE tenants(id INTEGER,slug TEXT); INSERT INTO tenants VALUES(1,'default');
    CREATE TABLE ogl_dispatch_batches(id INTEGER,tenant_id INTEGER);
    CREATE TABLE ogl_dispatch_members(id INTEGER,tenant_id INTEGER,batch_id INTEGER,order_id INTEGER,active_order_id INTEGER,shop_id INTEGER,dispatched_at TEXT,withdrawn_at TEXT);
    CREATE TABLE products(id INTEGER,tenant_id INTEGER); INSERT INTO products VALUES(94,1);
    CREATE TABLE orders (id INTEGER, status TEXT, tracking_stage TEXT, logistics_status TEXT, cancelled_after_ship INTEGER, delivered_at TEXT,shop_id INTEGER DEFAULT 1,posting_number TEXT DEFAULT 'posting');
    CREATE TABLE order_items (id INTEGER, order_id INTEGER, quantity INTEGER, sku_mapping_id INTEGER, ozon_sku TEXT);
    CREATE TABLE outbound_records (id INTEGER, product_id INTEGER, shop_id INTEGER,order_ref TEXT,order_item_id INTEGER);
    CREATE TABLE order_status_history (order_id INTEGER, status TEXT);
    INSERT INTO orders(id,status,tracking_stage,logistics_status,cancelled_after_ship,delivered_at) VALUES (1, 'cancelled', 'posting_canceled', '', 0, NULL);
    INSERT INTO order_items(id,order_id) VALUES (10, 1);
    CREATE TABLE inventory_movements (id INTEGER PRIMARY KEY, product_id INTEGER, related_order_item_id INTEGER,
      source_type TEXT, source_ref TEXT, status TEXT, quantity_delta INTEGER, note TEXT,tenant_id INTEGER DEFAULT 1,shop_id INTEGER DEFAULT 1,related_posting_number TEXT);
    INSERT INTO inventory_movements(id,product_id,related_order_item_id,source_type,source_ref,status,quantity_delta,note) VALUES (1, 94, 10, 'order_outbound', 'posting', 'posted', -1, 'original outbound'),
      (2, 94, 10, 'return_in', 'cancel_10_94', 'posted', 1, 'Order cancelled, inventory restored'),
      (3, 94, 10, 'return_in', 'manual_receipt_10', 'posted', 1, 'physical return');`);
  return db;
}

test('transport history wins over current cancellation; registration alone never counts as transport', () => {
  const db = database();
  try {
    const evidence = () => Number(db.prepare(`SELECT ${orderTransportEvidenceSql()} AS shipped FROM orders o`).get().shipped);
    for (const status of ['awaiting_packaging', 'awaiting_deliver', 'awaiting_registration', 'posting_registered', 'posting_registration_error']) {
      db.exec('DELETE FROM order_status_history');
      db.prepare('INSERT INTO order_status_history VALUES (1, ?)').run(status);
      assert.equal(evidence(), 0, status);
    }
    for (const status of ['delivering', 'delivered', 'posting_in_transit', 'posting_in_customs', 'posting_on_way_to_city', 'posting_in_pickup_point']) {
      db.exec('DELETE FROM order_status_history');
      db.prepare('INSERT INTO order_status_history VALUES (1, ?)').run(status);
      assert.equal(evidence(), 1, status);
    }
    db.exec('DELETE FROM order_status_history; UPDATE orders SET cancelled_after_ship = 1');
    assert.equal(evidence(), 1);
    db.exec("UPDATE orders SET cancelled_after_ship = 0, delivered_at = '2026-09-01'");
    assert.equal(evidence(), 1);
  } finally { db.close(); }
});

test('reversal preserves original outbound/manual receipt, is repeat-safe, and rolls back with cache rebuild', async () => {
  const db = database();
  const query = async (sql, params = []) => [db.prepare(sql.replace(' FOR UPDATE', '').replace(/LEFT\(source_ref, (\?|7)\)/g,'SUBSTR(source_ref, 1, $1)')).all(...params)];
  const connection = { query, execute: async (sql, params) => [db.prepare(sql).run(...params)] };
  let failRebuild = false, rebuilt = 0;
  const block = source.match(/export async function revokeShippedCancellationReturnsMysql\([^]*?\n}/)[0].replace('export ', '');
  const guard = source.match(/^async function assertCancellationInventoryAnchorsMysql\([^]*?^}/m)[0];
  const revoke = vm.runInNewContext(`${guard}\n${block};revokeShippedCancellationReturnsMysql`, {
    ...scopeContext,
    orderTransportEvidenceSql, automaticCancellationReturnSql,
    withMysqlTransaction: async fn => {
      db.exec('BEGIN');
      try { const result = await fn(connection); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    mysqlConnectionQueryOne: async (_, sql, params) => (await query(sql, params))[0][0],
    rebuildInventoryCurrentForProductMysql: async () => { if (failRebuild) throw Error('rebuild failed'); rebuilt++; },
    invalidateOrderProcurementCoverage() {}, invalidateMasterDataCache() {}
  });
  try {
    assert.equal(await revoke(10), 0, 'unshipped cancellation must keep its restoration');
    db.exec("INSERT INTO order_status_history VALUES (1, 'delivering')");
    failRebuild = true;
    await assert.rejects(revoke(10), /rebuild failed/);
    assert.equal(db.prepare('SELECT status FROM inventory_movements WHERE id=2').get().status, 'posted');
    failRebuild = false;
    assert.equal(await revoke(10), 1);
    assert.equal(await revoke(10), 0);
    assert.equal(rebuilt, 1);
    assert.equal(db.prepare('SELECT status FROM inventory_movements WHERE id=2').get().status, 'void');
    assert.equal(db.prepare('SELECT SUM(quantity_delta) qty FROM inventory_movements WHERE status=\'posted\'').get().qty, 0);
    assert.equal(db.prepare('SELECT note FROM inventory_movements WHERE id=1').get().note, 'original outbound');
    assert.equal(db.prepare('SELECT status FROM inventory_movements WHERE id=3').get().status, 'posted');
  } finally { db.close(); }
});

test('the cancellation sync exits before any stock restoration for shipped orders', async () => {
  const start = source.indexOf('async function syncOutboundForOpenOrdersMysql');
  const end = source.indexOf('\n  const rows = await mysqlQuery', start);
  const block = source.slice(start, end) + '\n}';
  let revokeCalls = 0, outboundQueries = 0;
  let shipped = 1;
  const sync = vm.runInNewContext(`${block};syncOutboundForOpenOrdersMysql`, {
    ...scopeContext,
    orderOutboundSyncScopeMysql: () => ({ sql: '', params: [] }), orderTransportEvidenceSql,
    withMysqlTransaction: async fn => fn({query:async sql=>sql.includes('FROM order_items oi')?[[{}]]:[(outboundQueries++,assert.match(sql,/status = 'posted' AND quantity_delta < 0/),[])]}),
    assertCancellationInventoryAnchorsMysql: async () => ({ entered_transport:shipped,order_item_id:10,order_status:'cancelled' }),
    mysqlQuery: async sql => {
      if (sql.includes('FROM order_items oi')) return [{ entered_transport: shipped, order_item_id: 10 }];
      outboundQueries++;
      assert.match(sql, /status = 'posted' AND quantity_delta < 0/);
      return [];
    },
    revokeShippedCancellationReturnsMysql: async id => { assert.equal(id, 10); revokeCalls++; }
  });
  await sync();
  await sync();
  assert.equal(revokeCalls, 2);
  assert.equal(outboundQueries, 0);
  shipped = 0;
  await sync();
  assert.equal(outboundQueries, 1, 'unshipped cancellation checks for an actual deduction');
});

test('pre-shipping cancellation restores only the deducted units and repeat sync does not add another return', async () => {
  const start = source.indexOf('async function syncOutboundForOpenOrdersMysql');
  const block = source.slice(start, source.indexOf('\n  const rows = await mysqlQuery', start)) + '\n}';
  let existingReturn = null;
  const posted = [];
  const connection = {
    query:async sql => [sql.includes('FROM order_items oi') ? [{product_id:94,purchase_cost:55}]
      : sql.includes("source_type = 'return_in'") ? (existingReturn?[existingReturn]:[])
      : [{ product_id:94,quantity_delta:-2,stock_location:'LOCAL',unit_cost:55 }]],
    execute:async()=>[{}]
  };
  const sync = vm.runInNewContext(`${block};syncOutboundForOpenOrdersMysql`, {
    ...scopeContext,
    orderOutboundSyncScopeMysql: () => ({ sql: '', params: [] }), orderTransportEvidenceSql,
    withMysqlTransaction:async fn=>fn(connection),
    assertCancellationInventoryAnchorsMysql:async()=>({entered_transport:0,order_item_id:10,product_id:94,quantity:99,order_status:'cancelled',posting_number:'posting',shop_id:1}),
    mysqlQuery: async sql => sql.includes('FROM order_items oi')
      ? [{ entered_transport: 0, order_item_id: 10, product_id: 94, quantity: 99 }]
      : [{ product_id: 94, quantity_delta: -2, stock_location: 'LOCAL', unit_cost: 55 }],
    mysqlQueryOne: async () => existingReturn,
    mysqlExecute: async () => {},
    inventoryMovementTenantColumnExistsMysql: async () => false,
    resolveOrderStockLocationMysql: () => ({ stockLocation: 'LOCAL', stockLocationSource: 'order' }),
    normalizeStockLocationMysql: value => value,
    mysqlPoolConnectionAdapter: {},
    rebuildInventoryCurrentForProductMysql: async () => {},
    postInventoryMysql: async (_, movement) => { posted.push(movement); existingReturn = { id: 2, product_id: 94 }; }
  });
  await sync();
  await sync();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].quantity_delta, 2);
  assert.equal(posted[0].source_ref, 'cancel_10_94');
});
