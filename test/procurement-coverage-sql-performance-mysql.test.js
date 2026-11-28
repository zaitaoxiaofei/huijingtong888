import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema } from './helpers/tenant-order-service.js';
import { remainingAssemblyBatches } from '../src/shared/bundle-finished-stock.js';
import { loadBundleFinishedStocks, allocateBundleFinishedDemands } from '../src/services/bundle-finished-stock.js';
import { loadInventoryComposition } from '../src/services/inventory-composition.js';
import { expandCurrentProcurementDemands, procurementDemandAncestorIds } from '../src/services/procurement-demand-composition.js';
import { procurementQueueOrderIds } from '../src/services/order-procurement-queues.js';
import { invalidateInventoryWorkflow } from '../src/services/inventory-workflow-cache.js';
import { shanghaiDateKey } from '../src/shanghai-time.js';
import { calculateOrderProcurementCoverageAsync } from '../src/services/order-procurement-coverage-async.js';
import { transportStatusesSql } from '../src/services/order-query-facts.js';
import { oglPhysicalDispatchSql } from '../src/services/ogl-dispatch-state.js';
import { loadFbpReservations } from '../src/services/fbp-warehouse.js';
import { resolveInventoryTenantScope } from '../src/services/inventory-tenant-scope.js';

const baseline = execFileSync('git', ['show', 'a4af631d:src/services/mysql-order-procurement-coverage.js'], { encoding: 'utf8', windowsHide: true });
const candidate = readFileSync(new URL('../src/services/mysql-order-procurement-coverage.js', import.meta.url), 'utf8');
function canonical(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return value.toJSON();
  if (Object.prototype.toString.call(value) === '[object Map]') return { entries: [...value].map(([key, row]) => [key, canonical(row)]), properties: canonical({ ...value }) };
  if (Array.isArray(value)) return Array.from(value, canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function reader(source, connection) {
  const calls = [];
  const query = async (sql, args = []) => {
    const started = performance.now();
    const rows = (await connection.query(sql, args))[0];
    calls.push({ sql, args, rows, ms: performance.now() - started });
    return rows;
  };
  const context = vm.createContext({ Date, Map, Set, Number, String, Object, Array, Math, console,
    remainingAssemblyBatches, loadBundleFinishedStocks, allocateBundleFinishedDemands, loadInventoryComposition,
    expandCurrentProcurementDemands, procurementDemandAncestorIds, procurementQueueOrderIds, invalidateInventoryWorkflow,
    shanghaiDateKey, calculateOrderProcurementCoverageAsync, transportStatusesSql, oglPhysicalDispatchSql, loadFbpReservations,
    resolveInventoryTenantScope
  });
  vm.runInContext(source.replace(/^import[^\n]*\r?\n/gm, '').replace(/^export /gm, ''), context);
  return { calls, async read(options) { calls.length = 0; return context.loadOrderProcurementCoverage(query, '', { fresh: true, ...options }); } };
}

async function seed(f) {
  const q = f.query;
  await createOrderFixtureSchema(f.connection);
  await q('ALTER TABLE products ADD COLUMN is_accessory TINYINT NOT NULL DEFAULT 0');
  await q('CREATE TABLE fbp_replenishment_orders(id BIGINT PRIMARY KEY,shop_id BIGINT,status VARCHAR(32)) ENGINE=InnoDB');
  await q('CREATE TABLE fbp_replenishment_order_items(id BIGINT PRIMARY KEY,order_id BIGINT,shop_id BIGINT,product_id BIGINT,ozon_sku VARCHAR(80),mapping_id BIGINT,approved_qty DECIMAL(18,4)) ENGINE=InnoDB');
  await q('CREATE TABLE fbp_replenishment_item_adjustments(item_id BIGINT,adjustment_qty DECIMAL(18,4)) ENGINE=InnoDB');
  await q('CREATE TABLE inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO shops(id,tenant_id,name,platform) VALUES(10,NULL,'Legacy','ozon'),(11,1,'Default','ozon'),(20,2,'A','ozon'),(21,2,'A WB','wb'),(30,3,'B','ozon')");
  await q("INSERT INTO products(id,tenant_id,name,code,active) VALUES(1,NULL,'Legacy','P1',1),(2,2,'A bundle','P2',1),(3,2,'A leaf','P3',1),(4,3,'B','P4',1),(5,2,'Inactive','P5',0)");
  await f.connection.query('INSERT INTO products(id,tenant_id,name,code) VALUES ?', [Array.from({ length: 35 }, (_, i) => [100 + i, 2, `Leaf ${i}`, `L${i}`])]);
  // Legacy duplicate mappings must still choose the same minimum eligible ID.
  await q('ALTER TABLE sku_mappings DROP INDEX uk_sku_mappings_shop_sku');
  await q(`INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES
    (1,NULL,10,1,'same',1),(18,2,20,3,'same',0),(19,3,20,4,'same',1),(20,2,20,2,'same',1),
    (21,2,20,3,'direct',1),(22,2,20,3,'same',1),(23,2,20,5,'inactive',1),(24,2,20,3,'',1),
    (30,3,30,4,'same',1),(40,2,21,3,'same',1)`);
  await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,2,3,2)');
  await q("INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active,mode) VALUES(1,20,'recipe',1,'combo')");
  await q('INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES(1,2,2),(1,3,1)');
  const orders = [
    [1,10,'legacy','awaiting_packaging'],[2,20,'fallback','awaiting_packaging'],[3,20,'direct','awaiting_packaging'],
    [4,20,'foreign-direct','awaiting_deliver'],[5,21,'wb-unbound','awaiting_packaging'],[6,21,'wb-direct','awaiting_packaging'],
    [7,20,'null-history','cancelled'],[8,20,'earliest-status','delivered'],[9,30,'foreign','delivered'],
    [10,20,'recipe','awaiting_packaging'],[11,20,'zero-direct','awaiting_deliver'],[12,20,'inactive-product','awaiting_packaging']
  ];
  await f.connection.query('INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES ?',
    [orders.map(([id, shop, posting, status]) => [id, shop, posting, status, status, '2020-01-01'])]);
  await f.connection.query('INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity) VALUES ?', [[
    [1,1,null,'same',1],[2,2,null,'same',3],[3,3,21,'same',2],[4,4,30,'same',4],
    [5,5,null,'same',1],[6,6,40,'other',1],[7,7,21,'direct',2],[8,8,21,'direct',2],
    [9,9,30,'same',2],[10,10,null,'recipe',1],[11,11,0,'',1],[12,12,23,'inactive',2]
  ]]);
  await f.connection.query('INSERT INTO order_status_history(order_id,shop_id,posting_number,status,observed_at,observed_hour,last_status_changed_at) VALUES ?', [[
    [7,20,'null-history','delivering','2020-01-01 00:00:00','2020-01-01 00:00:00',null],
    [8,20,'earliest-status','delivering','2020-01-01 00:00:00','2020-01-01 00:00:00','2019-12-30'],
    [8,20,'earliest-status','delivered','2020-01-02 00:00:00','2020-01-02 00:00:00','2019-12-29'],
    [8,20,'earliest-status','posting_delivered','2020-01-03 00:00:00','2020-01-03 00:00:00',null],
    [8,20,'earliest-status','posting_in_transit','2020-01-04 00:00:00','2020-01-04 00:00:00','2019-12-31']
  ]]);
  await q("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type,status,stock_location) VALUES(NULL,1,1,'opening_stock','posted','LOCAL'),(2,3,7,'opening_stock','posted','LOCAL'),(3,3,999,'opening_stock','posted','LOCAL')");
  await q("INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at) VALUES(1,2,'partial','partial_inbound','2019-12-01')");
  await q("INSERT INTO procurement_requests(id,tenant_id,product_id,source_order_item_id,quantity,amount,status,purchase_order_id) VALUES(1,2,3,2,5,50,'purchased',1)");
  await q("INSERT INTO inbound_records(id,tenant_id,product_id,quantity,amount,status,purchase_order_id,procurement_request_id,created_at,approved_at) VALUES(1,2,3,2,20,'approved',1,1,'2019-12-01','2019-12-02'),(2,2,3,3,30,'pending_arrival',1,1,'2019-12-01',NULL)");
  await q('INSERT INTO procurement_order_allocations(procurement_request_id,order_item_id,order_id,product_id,allocated_quantity) VALUES(1,2,2,3,5)');
  await q('INSERT INTO procurement_history_sources(action_id,order_item_id,product_id,quantity,inbound_record_id) VALUES(1,8,3,1,1)');
}

test('coverage SQL changes preserve complete live/history results and indexed binding reads', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated TCP-disabled MySQL socket', timeout: 180000
}, async t => {
  const f = await createTenantMysqlFixture('coverage_sql');
  try {
    await seed(f);
    const old = reader(baseline, f.connection), next = reader(candidate, f.connection);
    await t.test('default NULL, A/B, direct/fallback/WB, recipes, NULL-only transport and partial receipts match', async () => {
      for (const options of [{ tenantId: 'admin', includeTrace: true }, { tenantId: 1 }, { tenantId: 2, includeTrace: true }, { tenantId: 3 },
        { tenantId: 2, productIds: [2,3,5,...Array.from({ length: 35 }, (_, i) => i + 100)] },
        { tenantId: 2, productIds: [3], includeTrace: true }, { tenantId: 2, productIds: [3], localStateOnly: true },
        { tenantId: 2, productIds: [2,3,...Array.from({ length: 35 }, (_, i) => i + 100)], localStateOnly: true },
        { tenantId: 2, queuesOnly: true }]) {
        const before = await old.read(options), after = await next.read(options);
        assert.deepEqual(canonical(after), canonical(before), JSON.stringify(options));
      }
      const value = await next.read({ tenantId: 2 });
      assert.equal(value.has(5), false, 'WB cannot acquire a fallback binding');
      assert.equal(value.get(6).items[0].product_id, 3, 'valid WB direct binding remains usable');
      assert.equal(value.get(7).entered_transport, true, 'NULL timestamp transport history remains evidence');
      assert.equal(value.get(8).transport_at.getTime(), new Date(2019, 11, 29).getTime(), 'earliest status time matches the fixture driver timezone');
    });
    await t.test('fresh stock and receipt changes cannot reuse earlier results', async () => {
      const before = canonical(await next.read({ tenantId: 2 }));
      await f.query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type,status,stock_location) VALUES(2,3,11,'opening_stock','posted','LOCAL')");
      await f.query("UPDATE inbound_records SET quantity=2 WHERE id=2");
      const expected = canonical(await old.read({ tenantId: 2 })), after = canonical(await next.read({ tenantId: 2 }));
      assert.deepEqual(after, expected); assert.notDeepEqual(after, before);
    });
    await t.test('request-local fallback binding avoids per-item MIN probes without dropping history', {
      skip: process.env.RUN_COVERAGE_SQL_PERF !== '1' && 'Enable RUN_COVERAGE_SQL_PERF after coordinating the isolated benchmark'
    }, async () => {
      const orders = Array.from({ length: 2000 }, (_, i) => [1000 + i,20,`history-${i}`,'delivered','2018-01-01']);
      await f.connection.query('INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES ?', [orders]);
      await f.connection.query('INSERT INTO order_items(id,order_id,ozon_sku,quantity) VALUES ?', [orders.map(([id]) => [id,id,'direct',1])]);
      for (let start = 0; start < orders.length; start += 100) {
        const history = orders.slice(start, start + 100).flatMap(([id,shop,posting]) => Array.from({ length: 6 }, (_, i) => {
          const stamp = new Date(Date.UTC(2018,0,1, i)).toISOString().slice(0,19).replace('T',' ');
          return [id,shop,posting,i % 2 ? 'delivered' : 'delivering',stamp,stamp,'2018-01-01'];
        }));
        await f.connection.query('INSERT INTO order_status_history(order_id,shop_id,posting_number,status,observed_at,observed_hour,last_status_changed_at) VALUES ?', [history]);
      }
      await f.query('ANALYZE TABLE order_status_history');
      const expected = await old.read({ tenantId: 2 }), actual = await next.read({ tenantId: 2 });
      assert.deepEqual(canonical(actual), canonical(expected));
      const oldSql = old.calls.find(call => call.sql.startsWith('SELECT STRAIGHT_JOIN o.id AS order_id'));
      const newSql = next.calls.find(call => call.sql.startsWith('SELECT STRAIGHT_JOIN o.id AS order_id'));
      const sample = async call => {
        const status = async () => new Map((await f.connection.query("SHOW SESSION STATUS LIKE 'Handler_read%'") )[0].map(r => [r.Variable_name, Number(r.Value)]));
        const before = await status(), started = performance.now();
        const rows = (await f.connection.query(call.sql, call.args))[0];
        const ms = performance.now() - started, after = await status();
        return { ms, reads: [...after].reduce((sum, [key, value]) => sum + value - (before.get(key) || 0), 0), rows: canonical(rows) };
      };
      await sample(oldSql); await sample(newSql);
      const a = await sample(oldSql), b = await sample(newSql), c = await sample(newSql), d = await sample(oldSql);
      assert.deepEqual(b.rows, a.rows); assert.deepEqual(c.rows, d.rows);
      assert.ok(b.reads < a.reads, `expected fewer indexed reads: ${a.reads} -> ${b.reads}`);
      const plan = (await f.connection.query('EXPLAIN FORMAT=JSON ' + newSql.sql, newSql.args))[0];
      assert.match(JSON.stringify(plan), /materialized_from_subquery/);
      t.diagnostic(JSON.stringify({ scope: 'synthetic demand SQL only', history_rows: 12005,
        old: [a,d].map(({ ms, reads }) => ({ ms, reads })), candidate: [b,c].map(({ ms, reads }) => ({ ms, reads })) }));
    });
  } finally { await f.cleanup(); }
});
