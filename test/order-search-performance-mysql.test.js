import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema, loadTenantOrderService } from './helpers/tenant-order-service.js';
import { orderSearchMatchForInput } from '../src/shared/order-search.js';
import { ensureOrderSearchIndex, inspectOrderSearchIndex } from '../src/services/order-search-indexes.js';

test('desktop/mobile complete-posting lookup is explicit; partial, legacy and product searches retain contains', () => {
  for (const value of ['0182529378-0072-1', '62103852-0141-1', ' 62103852-0141-1 ']) assert.equal(orderSearchMatchForInput('order', value), 'exact');
  for (const value of ['62103852', '62103852-0141', 'P-001', '', '62103852-0141-1%', '62103852-0141-1 7']) assert.equal(orderSearchMatchForInput('order', value), 'contains');
  assert.equal(orderSearchMatchForInput('sku', '62103852-0141-1'), 'contains');
  const desktop = readFileSync(new URL('../frontend/orders/composables/useOrdersPage.js', import.meta.url), 'utf8');
  const context = vm.createContext({ URLSearchParams, orderSearchMatchForInput, DEFAULT_PAGE_SIZE: 20, DEFAULT_ORDER_STATUS: 'awaiting_packaging' });
  vm.runInContext(desktop.match(/  function buildOrdersParams\([^]*?\n  }/)[0], context);
  assert.equal(context.buildOrdersParams({ searchType: 'order', searchQuery: '62103852-0141-1' }).get('searchMatch'), 'exact');
  assert.equal(context.buildOrdersParams({ searchType: 'order', searchQuery: '62103852' }).get('searchMatch'), 'contains');
  assert.equal(context.buildOrdersParams({ searchType: 'order', searchQuery: '62103852-0141-1', searchMatch: 'contains' }).get('searchMatch'), 'contains');
  const mobile = readFileSync(new URL('../frontend/admin/views/mobile/MobileOrdersView.vue', import.meta.url), 'utf8');
  assert.match(mobile, /searchMatch: orderSearchMatchForInput\(filters.searchType, filters.searchQuery\)/);
});

test('indexed exact/prefix searches preserve enterprise ownership and ordinary contains behavior', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 120000
}, async t => {
  const f = await createTenantMysqlFixture('order_search');
  try {
    await createOrderFixtureSchema(f.connection);
    const { service, query, calls } = loadTenantOrderService(f.connection);
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'search-a','A'),(3,'search-b','B')");
    await query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(11,1,'Default'),(20,2,'A'),(21,2,'A other'),(30,3,'B')");
    // 60,000 independent orders, no real business records or external calls.
    const digits = '(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)';
    await query(`INSERT INTO orders(shop_id,posting_number,order_number,status,ordered_at)
      SELECT IF(seq.n < 30000,20,30), CONCAT(LPAD(10000000+seq.n,10,'0'),'-0001-1'),
        CONCAT('parent-',seq.n), 'awaiting_deliver', '2026-10-22 00:00:00'
      FROM (SELECT a.n+10*b.n+100*c.n+1000*d.n+10000*e.n n FROM ${digits} a CROSS JOIN ${digits} b
        CROSS JOIN ${digits} c CROSS JOIN ${digits} d CROSS JOIN ${digits} e) seq WHERE seq.n < 60000`);
    const posting = '0010012345-0001-1';
    for (const [shop, marker] of [[21,'A second'],[30,'B shared'],[10,'Default legacy'],[11,'Default explicit']]) {
      await query("INSERT INTO orders(shop_id,posting_number,order_number,status,ordered_at,sync_note) VALUES(?,?,?,'awaiting_deliver','2026-10-22',?)", [shop,posting,'shared-parent',marker]);
    }
    await query("INSERT INTO orders(shop_id,posting_number,order_number,status,ordered_at) VALUES(20,?,'has-containing-posting','awaiting_deliver','2026-10-22')", [`prefix-${posting}-extra`]);
    await query("INSERT INTO orders(shop_id,posting_number,order_number,status,ordered_at) VALUES(20,'literal%_!-posting','literal-prefix','awaiting_deliver','2026-10-22'),(20,'literal-OTHER','literal-other','awaiting_deliver','2026-10-22')");
    await query('ANALYZE TABLE orders');
    const rows = async (tenant, text, match) => {
      const scope = await service.orderListTenantScopeMysql(tenant), base = await service.orderBaseSqlMysql({}, tenant);
      const filtered = await service.orderFilteredSqlMysql({status:'all',searchType:'order',searchQuery:text,...(match?{searchMatch:match}:{})},base,null,scope);
      return { result: await query(`SELECT o.id,o.shop_id,o.posting_number FROM orders o WHERE ${filtered.where} ORDER BY o.id`, filtered.params), filtered };
    };
    assert.deepEqual((await rows('2',posting,'exact')).result.map(r=>r.shop_id),[20,21]);
    assert.deepEqual((await rows('3',posting,'exact')).result.map(r=>r.shop_id),[30]);
    assert.deepEqual((await rows('admin',posting,'exact')).result.map(r=>r.shop_id),[10,11]);
    assert.equal((await rows('2',posting)).result.length,3,'legacy contains still includes a larger string containing the identifier');
    assert.equal((await rows('2',posting,'contains')).result.length,3);
    assert.deepEqual((await rows('2','shared-parent','exact')).result.map(r=>r.shop_id),[21]);
    assert.equal((await rows('2','literal%_!','prefix')).result.length,1,'literal prefix does not interpret wildcard characters');
    assert.equal((await rows('2','0010012345','prefix')).result.length,2);
    assert.equal((await rows('2','missing-posting','exact')).result.length,0);
    const scope = await service.orderListTenantScopeMysql('2');
    assert.throws(()=>service.orderSearchBaseSqlMysql({where:'1=1',params:[]},{searchQuery:posting,searchMatch:'unsafe'},scope),{statusCode:400});
    assert.throws(()=>service.orderSearchBaseSqlMysql({where:'1=1',params:[]},{searchQuery:posting,searchMatch:'exact'},{id:'2 OR 1=1'}),/Invalid order tenant scope/);

    const exact = (await rows('2',posting,'exact')).filtered, contains = (await rows('2',posting,'contains')).filtered;
    const statement = x => `SELECT o.id FROM orders o WHERE ${x.where}`;
    const reads = async x => {
      const get = async () => Number((await query("SHOW SESSION STATUS LIKE 'Handler_read_next'"))[0].Value)
        + Number((await query("SHOW SESSION STATUS LIKE 'Handler_read_rnd_next'"))[0].Value);
      const before = await get(), started = performance.now();
      await query(statement(x),x.params);
      return {ms:performance.now()-started, rows_read:(await get())-before};
    };
    // Warm both SQL paths once; report observed times, assert bounded work rather
    // than a machine-dependent millisecond threshold.
    await reads(exact); await reads(contains);
    const old = await reads(contains), optimized = await reads(exact);
    const [plan] = await query(`EXPLAIN FORMAT=JSON ${statement(exact)}`,exact.params);
    if (!(optimized.rows_read < old.rows_read / 10)) t.diagnostic(plan.EXPLAIN);
    assert.match(plan.EXPLAIN,/uk_orders_shop_posting_number/);
    assert.match(plan.EXPLAIN,/idx_orders_shop_order_number_id/);
    assert.ok(optimized.rows_read < old.rows_read / 10, JSON.stringify({old,optimized}));
    t.diagnostic(`Isolated 60,000-order SQL: contains=${old.ms.toFixed(2)}ms/${old.rows_read} reads; exact=${optimized.ms.toFixed(2)}ms/${optimized.rows_read} reads; same tenant, explicit different matching modes`);

    await t.test('explicit additive index migration is idempotent and never changes an existing unexpected index',async()=>{
      assert.equal((await inspectOrderSearchIndex(f.connection)).valid,true);
      assert.equal((await ensureOrderSearchIndex(f.connection)).changed,false);
      await query('ALTER TABLE orders DROP INDEX idx_orders_shop_order_number_id');
      assert.equal((await inspectOrderSearchIndex(f.connection)).present,false);
      assert.deepEqual((await rows('2',posting,'exact')).result.map(r=>r.shop_id),[20,21],'older databases remain correct before the optional performance migration');
      assert.equal((await ensureOrderSearchIndex(f.connection)).changed,true);
      assert.equal((await ensureOrderSearchIndex(f.connection)).changed,false);
      await query('ALTER TABLE orders DROP INDEX idx_orders_shop_order_number_id, ADD INDEX idx_orders_shop_order_number_id(order_number)');
      await assert.rejects(ensureOrderSearchIndex(f.connection),/unexpected definition/);
      assert.deepEqual((await inspectOrderSearchIndex(f.connection)).columns,['order_number']);
    });
  } finally { await f.cleanup(); }
});

test('row-only OGL search classifies only matching candidates while counts and option scope remain unchanged',async()=>{
  const captured=[];
  const {service} = loadTenantOrderService({query:async()=>[[{id:2,slug:'search-a'}]]},{
    orderListTenantScopeMysql:async()=>({id:2,defaultTenant:false}),
    loadOrderLogisticsCarrierSummaryForBaseMysql:async base=>{captured.push(base);return[];},
    orderTenantCoverageMysql:async()=>new Map(),orderPagedSqlCountsMysql:async()=>({all:0})
  });
  const query={paged:'1',includeRows:'0',includeCounts:'0',includeLogisticsOptions:'0',logisticsCarrier:'ogl',searchType:'order',searchQuery:'62103852-0141-1',searchMatch:'exact'};
  await service.ordersPagedMysql(query,'2');
  assert.match(captured[0].where,/order_search_match/);
  assert.equal(captured[0].params.at(-1),'62103852-0141-1');
  await service.ordersPagedMysql({...query,includeCounts:'1'},'2');
  assert.doesNotMatch(captured[1].where,/order_search_match/);
});
