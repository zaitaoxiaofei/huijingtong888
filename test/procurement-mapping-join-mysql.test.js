import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { inventoryTenantSql } from '../src/services/inventory-tenant-scope.js';
import { buildOrderOutcomeSql } from '../src/services/order-outcome.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const original = execFileSync('git', ['show', 'a4af631d:src/services/mysql-cutover.js'], {
  cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024
});

// Execute the complete reader to capture its actual SQL; do not reproduce the
// candidate mapping expressions in a hand-written oracle.
async function detailSql(text = source, query = { grouped: '1' }, scope = { id: 2, isDefault: false }, productIds = [101, 102]) {
  const body = text.match(/^export async function procurementRequestsMysql\([^]*?^}/m)?.[0];
  assert.ok(body);
  let result;
  const noop = async () => {};
  const context = vm.createContext({
    Date, Map, Set, Number, String, Object, Array, Math,
    ensureMysqlCutoverEnabled() {}, resolveInventoryTenantScope: async () => scope,
    requireProcurementTenantSchemaMysql: noop, ensureProcurementRequestTimestampSchemaMysql: noop,
    ensureProcurementFlexibleRequestSchemaMysql: noop, ensureStockLocationSchemaMysql: noop,
    ensureFbpTransferRecordsSchemaMysql: noop, inventoryScopeCoverageMysql: async () => new Map(),
    readDemandCancellationEvents: async () => [], activeDemandCancellations: () => new Map(),
    procurementGroupedPageIdsMysql: async () => ({ productIds, page: 1, pageSize: 30, total: productIds.length }),
    inventoryTenantSql, workflowFbpCandidateMysql: () => '0',
    localStockLocationPredicateMysql: () => '1=1', fbpTransferInTransitWhereMysql: () => '1=1',
    chinaDateSqlMysql: value => `DATE(CONVERT_TZ(${value}, '+00:00', '+08:00'))`, buildOrderOutcomeSql,
    mysqlQuery: async (sql, params) => { result = { sql, params: Array.from(params) }; return []; },
    createInventoryWorkflowService: () => ({ batch: async () => [] }), supplementLiveProcurementRows: rows => rows,
    groupProcurementRequestsMysql: rows => ({ rows }), filterProcurementRequestsMysql: rows => rows
  });
  vm.runInContext(body.replace(/^export /, ''), context);
  await context.procurementRequestsMysql(query, scope.id);
  return result;
}

function aggregateSql(detail, kind) {
  const alias = kind === 'sales' ? 'sales' : 'order_history';
  const start = kind === 'sales' ? 'sales' : 'history';
  const aggregate = detail.sql.match(new RegExp(`LEFT JOIN \\(\\s*(SELECT ${start}_(?:mapping|item)\\.product_id,[\\s\\S]*?)\\s*\\) ${alias} ON`))?.[1];
  assert.ok(aggregate, `Missing ${kind} aggregate`);
  const cteStart = detail.sql.indexOf('WITH procurement_page_mappings');
  const cte = cteStart === -1 ? '' : detail.sql.slice(cteStart, detail.sql.indexOf('\n    SELECT pr.', cteStart)).trim();
  return { sql: `${cte}\n${aggregate} ORDER BY product_id`, params: detail.params.slice(0, cte ? (cte.match(/\?/g) || []).length : (aggregate.match(/\?/g) || []).length) };
}

test('selected details bind all scopes and leave legacy unbounded inputs unchanged', async () => {
  const grouped = await detailSql();
  assert.equal((grouped.sql.match(/\?/g) || []).length, grouped.params.length);
  assert.deepEqual(grouped.params, Array.from({ length: 12 }, () => [101, 102]).flat());
  assert.match(grouped.sql, /UNION ALL/);
  assert.match(grouped.sql, /NOT \(page_mapping\.id <=> page_item\.sku_mapping_id\)/);
  assert.doesNotMatch(grouped.sql, /sales_mapping\.id = sales_item\.sku_mapping_id OR/);
  for (const query of [{ productId: 101 }, { product_id: '101' }, { productId: '1.01e2' }]) {
    const current = await detailSql(source, { paged: '1', status: 'all', ...query });
    assert.deepEqual(current.params, Array(12).fill(101));
    assert.equal((current.sql.match(/\?/g) || []).length, 12);
    assert.match(current.sql, /AND p\.id IN \(\?\)/);
  }
  for (const query of [{}, { productId: 0 }, { productId: -1 }, { productId: 'bad' }, { productId: 1.5 }, { productId: 'Infinity' }, { productId: '9007199254740992' }]) {
    const current = await detailSql(source, query), baseline = await detailSql(original, query);
    assert.equal(current.sql.replace(/\s+/g, ' ').trim(), baseline.sql.replace(/\s+/g, ' ').trim());
    assert.deepEqual(current.params, baseline.params);
  }
});

test('indexed mapping facts retain OR multiplicity, NULLs, lifetime and tenant isolation in MySQL', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires disposable socket-only MySQL', timeout: 120000
}, async t => {
  const f = await createTenantMysqlFixture('procure_mapping');
  const q = (sql, params = []) => f.connection.query(sql, params).then(([rows]) => rows);
  try {
    await q("SET timestamp = UNIX_TIMESTAMP('2026-11-27 12:00:00')");
    await q('ALTER TABLE orders MODIFY ordered_at DATETIME NULL');
    await q('ALTER TABLE order_items MODIFY ozon_sku VARCHAR(128) NULL');
    await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(10,1,'default','active'),(11,NULL,'legacy','active'),(20,2,'owned','active'),(30,3,'foreign','active')");
    await q(`INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES
      (10,1,10,101,'DEFAULT',1),(11,NULL,11,102,'LEGACY',1),
      (20,2,20,101,'MAIN',1),(21,2,20,101,'ALIAS',1),(22,2,20,102,'OTHER',1),
      (23,2,20,101,'INACTIVE',0),(24,3,20,101,'POISON',1),
      (25,2,30,101,'FOREIGN-SHOP',1),(26,NULL,20,101,'NULL-TENANT',1),
      (27,2,20,103,'OUTSIDE',1),(28,3,20,102,'MAIN-FOREIGN',1)`);
    await q(`INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES
      (1,20,'same-mapping','delivered','delivered',CURRENT_TIMESTAMP),
      (2,20,'same-product-two-mappings','delivered','delivered',CURRENT_TIMESTAMP),
      (3,20,'different-product-two-mappings','delivered','delivered',CURRENT_TIMESTAMP),
      (4,20,'null-mapping','delivered','delivered',CURRENT_TIMESTAMP),
      (5,20,'null-sku','delivered','delivered',CURRENT_TIMESTAMP),
      (6,20,'null-both','delivered','delivered',CURRENT_TIMESTAMP),
      (7,20,'inactive','delivered','delivered',CURRENT_TIMESTAMP),
      (8,20,'foreign-mapping','delivered','delivered',CURRENT_TIMESTAMP),
      (9,30,'foreign-shop','delivered','delivered',CURRENT_TIMESTAMP),
      (10,20,'old','cancelled','pending_stock','2020-01-01'),
      (11,20,'null-date','delivered','delivered',NULL),
      (12,20,'future','delivered','delivered',CURRENT_DATE + INTERVAL 2 DAY),
      (13,20,'null-mapping-tenant','delivered','delivered',CURRENT_TIMESTAMP),
      (14,10,'default','delivered','delivered',CURRENT_TIMESTAMP),
      (15,11,'legacy','delivered','delivered',CURRENT_TIMESTAMP),
      (16,20,'rejected','rejected','rejected',CURRENT_TIMESTAMP),
      (17,20,'returned','returned','returned',CURRENT_TIMESTAMP),
      (18,20,'foreign-direct-valid-sku','delivered','delivered',CURRENT_TIMESTAMP)`);
    await q(`INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity) VALUES
      (1,1,20,'MAIN',1),(2,2,21,'MAIN',2),(3,3,22,'MAIN',3),(4,4,NULL,'MAIN',4),
      (5,5,20,NULL,5),(6,6,NULL,NULL,6),(7,7,23,'INACTIVE',7),(8,8,24,'POISON',8),
      (9,9,25,'FOREIGN-SHOP',9),(10,10,20,'MAIN',10),(11,11,20,'MAIN',11),
      (12,12,20,'MAIN',12),(13,13,26,'NULL-TENANT',13),(14,14,10,'DEFAULT',14),
      (15,15,11,'LEGACY',15),(16,16,20,'MAIN',16),(17,17,20,'MAIN',17),
      (18,18,28,'MAIN',18)`);
    for (const scope of [{ id: 2, isDefault: false }, { id: 1, isDefault: true }, { id: 3, isDefault: false }]) {
      for (const zone of ['+00:00', '+08:00']) {
        await q('SET time_zone = ?', [zone]);
        const before = await detailSql(original, { grouped: '1' }, scope), after = await detailSql(source, { grouped: '1' }, scope);
        for (const kind of ['sales', 'history']) {
          const a = aggregateSql(before, kind), b = aggregateSql(after, kind);
          assert.deepEqual(await q(b.sql, b.params), await q(a.sql, a.params), `${kind}: ${JSON.stringify(scope)} ${zone}`);
        }
      }
    }
    const owned = aggregateSql(await detailSql(), 'history');
    const ownedRows = await q(owned.sql, owned.params);
    assert.equal(Number(ownedRows[0].historical_total_quantity), 101, 'Same mapping counts once, same product different mappings count twice, all history stays');
    assert.equal(Number(ownedRows[1].historical_total_quantity), 3, 'Direct different-product mapping remains alongside the SKU mapping');
    t.diagnostic('Independent aggregate equality includes NULL SKU/mapping/date, future and 2020 history, default legacy ownership, inactive and dirty foreign mappings.');
    // Performance is opt-in so concurrent equality suites do not distort it.
    if (process.env.PROCUREMENT_MAPPING_BENCH === '1') {
      await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(1000,2,20,1000,'BULK-UNRELATED',1)");
      await q(`INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at)
        SELECT 100000+n,20,CONCAT('bulk-',n),'delivered','delivered','2020-01-01'
        FROM (SELECT a.n+10*b.n+100*c.n+1000*d.n+10000*e.n n FROM
          JSON_TABLE('[0,1,2,3,4,5,6,7,8,9]','$[*]' COLUMNS(n INT PATH '$')) a
          CROSS JOIN JSON_TABLE('[0,1,2,3,4,5,6,7,8,9]','$[*]' COLUMNS(n INT PATH '$')) b
          CROSS JOIN JSON_TABLE('[0,1,2,3,4,5,6,7,8,9]','$[*]' COLUMNS(n INT PATH '$')) c
          CROSS JOIN JSON_TABLE('[0,1,2,3,4,5,6,7,8,9]','$[*]' COLUMNS(n INT PATH '$')) d
          CROSS JOIN JSON_TABLE('[0,1,2,3,4]','$[*]' COLUMNS(n INT PATH '$')) e) numbers`);
      await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity) SELECT id,id,1000,'BULK-UNRELATED',1 FROM orders WHERE id>=100000");
      await q('ANALYZE TABLE orders,order_items,sku_mappings');
      for (const [label, text] of [['original', original], ['candidate', source]]) {
        const a = aggregateSql(await detailSql(text), 'history');
        await q(a.sql, a.params);
        const times = [];
        const counters = () => q("SHOW SESSION STATUS WHERE Variable_name IN ('Handler_read_key','Handler_read_next','Handler_read_rnd_next')");
        const before = new Map((await counters()).map(row => [row.Variable_name, Number(row.Value)]));
        for (let i = 0; i < 5; i++) { const start = performance.now(); await q(a.sql, a.params); times.push(performance.now() - start); }
        const reads = Object.fromEntries((await counters()).map(row => [row.Variable_name, Number(row.Value) - before.get(row.Variable_name)]));
        const plan = await q(`EXPLAIN ANALYZE ${a.sql}`, a.params);
        const planSteps = String(Object.values(plan[0])[0]).split('\n').filter(line => line.length < 1500);
        t.diagnostic(JSON.stringify({ label, milliseconds: times, reads, plan: planSteps }));
      }
    }
  } finally { await f.cleanup(); }
});
