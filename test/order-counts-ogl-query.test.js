import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { oglDispatchedStatusSql, oglOnlineStatusSql, oglTerminalStatusSql } from '../src/services/ogl-dispatch-state.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema, loadTenantOrderService } from './helpers/tenant-order-service.js';

const statuses = ['awaiting_packaging', 'awaiting_deliver', 'ogl_dispatched', 'delivering', 'dispute', 'delivered', 'cancelled',
  'unbound', 'pending_purchase', 'purchase_in_transit', 'purchase_records_missing'];

function baselineCountSql(service, base, coverage, scope) {
  return `SELECT COUNT(*) AS all_count, ${statuses.map(status =>
    `SUM(CASE WHEN ${service.orderStatusSqlMysql(status, coverage, scope)} THEN 1 ELSE 0 END) AS ${status}`).join(',')}
    FROM orders o WHERE ${base.where}`;
}

test('count status predicates reuse one tenant-scoped materialized OGL relation without changing other callers', async () => {
  const { service, calls } = loadTenantOrderService({ query: async () => [[{}]] });
  await service.orderPagedSqlCountsMysql({ where: 'o.ordered_at >= ?', params: ['2026-10-01'] }, new Map(), { id: 2, defaultTenant: false });
  const sql = calls.at(-1).sql;
  assert.equal((sql.match(/FROM ogl_dispatch_members/g) || []).length, 1);
  assert.doesNotMatch(sql, /EXISTS \(SELECT 1 FROM ogl_dispatch_members/);
  assert.match(sql, /GROUP BY ogl_count_member\.order_id/);
  assert.match(sql, /ogl_count_member\.tenant_id = 2/);
  assert.match(sql, /ogl_count_shop\.tenant_id = 2/);
  assert.match(sql, /ogl_count_order\.id = ogl_count_member\.active_order_id/);
  assert.match(sql, /ogl_count_member\.posting_number = ogl_count_order\.posting_number/);
  assert.match(sql, /ogl_count_batch\.tenant_id = ogl_count_member\.tenant_id/);
  assert.deepEqual(calls.at(-1).params, ['2026-10-01']);
  const baseline = baselineCountSql(service, { where: '1=1' }, new Map(), { id: 2, defaultTenant: false });
  assert.ok((baseline.match(/FROM ogl_dispatch_members/g) || []).length > 20);
  assert.ok(sql.length < baseline.length);
  for (const factory of [oglDispatchedStatusSql, oglOnlineStatusSql, oglTerminalStatusSql]) {
    assert.match(factory('o'), /FROM ogl_dispatch_members/);
    assert.doesNotMatch(factory('o', 'ogl_count_evidence'), /FROM ogl_dispatch_members/);
    assert.throws(() => factory('o', 'unsafe; SELECT 1'), /alias/);
  }
  assert.throws(() => service.orderPagedOglEvidenceJoinMysql({ id: '2 OR 1=1', defaultTenant: false }), /Invalid order tenant scope/);
});

test('live count aggregation preserves every tab across OGL/application, physical, withdrawn, terminal and foreign evidence', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('ogl_counts');
  try {
    await createOrderFixtureSchema(fixture.connection);
    const { service, query, calls } = loadTenantOrderService(fixture.connection);
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(11,1,'Default'),(20,2,'A'),(21,2,'A second'),(30,3,'B')");
    const states = [
      ['awaiting_packaging', 'awaiting_packaging', ''], ['awaiting_deliver', 'awaiting_deliver', ''],
      ['awaiting_packaging', 'posting_acceptance_in_progress', ''], ['acceptance_in_progress', 'posting_acceptance_in_progress', ''],
      ['delivering', 'awaiting_deliver', 'posting_in_transit'], ['awaiting_deliver', 'posting_received_by_buyer', ''],
      ['delivered', 'awaiting_deliver', ''], ['cancelled', 'awaiting_deliver', ''], ['arbitration', 'awaiting_deliver', ''],
      ['awaiting_deliver', 'posting_in_customs', ''], ['awaiting_deliver', '', 'returned_to_seller']
    ];
    const modes = ['none', 'applied', 'physical', 'withdrawn', 'inactive', 'foreign', 'posting_mismatch', 'closed', 'cancelled_batch', 'manual_physical'];
    const batches = new Map();
    let batchId = 0, orderId = 0;
    for (const [shop, tenant] of [[10, 1], [11, 1], [20, 2], [21, 2], [30, 3]]) {
      for (const kind of ['observed', 'closed', 'cancelled', 'manual']) {
        batches.set(`${shop}:${kind}`, ++batchId);
        await query(`INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,
          official_carriage_id,official_status,status,created_by) VALUES(?,?,?,?,?,1,?,?,?,1)`,
        [batchId, tenant, `batch-${batchId}`, `request-${batchId}`, shop, kind === 'manual' ? null : kind === 'observed' ? '901' : kind === 'closed' ? '902' : '903',
          kind === 'manual' ? 'not_created' : 'observed', kind === 'closed' || kind === 'cancelled' ? kind : 'preparing']);
      }
      for (const [stateIndex, state] of states.entries()) for (const [modeIndex, mode] of modes.entries()) {
        const id = ++orderId, posting = `shared-${stateIndex}-${modeIndex}`;
        await query(`INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,logistics_status,ordered_at)
          VALUES(?,?,?,?,?,?,?)`, [id, shop, posting, ...state, stateIndex % 2 ? '2026-10-20 18:00:00' : '2026-10-21 18:00:00']);
        await query('INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price) VALUES(?,?,?,?,1)', [id, id, 'same-sku', 1]);
        if (mode === 'none') continue;
        const foreignShop = tenant === 3 ? 20 : 30, foreignTenant = tenant === 3 ? 2 : 3;
        const selectedBatch = batches.get(`${shop}:${mode === 'closed' ? 'closed' : mode === 'cancelled_batch' ? 'cancelled' : mode === 'manual_physical' ? 'manual' : 'observed'}`);
        // A foreign batch is created before being referenced, regardless of shop iteration order.
        let memberBatch = selectedBatch;
        if (mode === 'foreign') {
          memberBatch = ++batchId;
          await query(`INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,official_carriage_id,official_status,created_by)
            VALUES(?,?,?,?,?,1,NULL,'not_created',1)`, [memberBatch, foreignTenant, `batch-${memberBatch}`, `request-${memberBatch}`, foreignShop]);
        }
        await query(`INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,official_member,dispatched_at,withdrawn_at)
          VALUES(?,?,?,?,?,?,1,?,?)`, [mode === 'foreign' ? foreignTenant : tenant, memberBatch, id,
          mode === 'inactive' || mode === 'withdrawn' ? null : id, shop, mode === 'posting_mismatch' ? 'wrong-posting' : posting,
          ['physical', 'manual_physical', 'foreign', 'withdrawn'].includes(mode) ? '2026-10-22 01:00:00' : null,
          mode === 'withdrawn' ? '2026-10-22 02:00:00' : null]);
      }
    }
    const coverage = new Map(Array.from({ length: orderId }, (_, index) => {
      const id = index + 1;
      return [id, { order_id: id, stock_location: id % 7 ? 'LOCAL' : 'FBP', needs_fulfillment: id % 3 === 0,
        incoming_quantity: id % 3 === 1 ? 1 : 0, entered_transport: id % 3 === 2,
        missing_record_quantity: id % 3 === 2 ? 1 : 0, items: [{ product_id: 1, shortage_quantity: 1 }] }];
    }));
    for (const tenant of ['2', '3', 'admin']) {
      const scope = await service.orderListTenantScopeMysql(tenant);
      for (const filter of [{}, { shopId: tenant === '2' ? 21 : tenant === '3' ? 30 : 10 }, { dateFrom: '2026-10-21', dateTo: '2026-10-22' }]) {
        const base = await service.orderBaseSqlMysql(filter, tenant);
        const oldSql = baselineCountSql(service, base, coverage, scope);
        const started = performance.now();
        const [expected] = await query(oldSql, base.params);
        const oldMs = performance.now() - started;
        const newer = performance.now();
        const actual = await service.orderPagedSqlCountsMysql(base, coverage, scope);
        const newMs = performance.now() - newer;
        assert.equal(actual.all, Number(expected.all_count));
        for (const status of statuses) assert.equal(actual[status], Number(expected[status]), `${tenant}/${JSON.stringify(filter)}/${status}`);
        if (tenant === '2' && !Object.keys(filter).length) {
          const newSql = calls.at(-1).sql;
          const [explained] = await query(`EXPLAIN FORMAT=JSON ${newSql}`, base.params);
          const plan = explained.EXPLAIN;
          assert.equal((plan.match(/"materialized_from_subquery"/g) || []).length, 2);
          assert.equal((plan.match(/"table_name": "ogl_count_member"/g) || []).length, 1);
          t.diagnostic(`Fixture ${orderId} orders: baseline=${oldMs.toFixed(1)}ms optimized=${newMs.toFixed(1)}ms; one OGL materialization, no timing threshold`);
        }
      }
    }
    // The same derived evidence also composes with search, print and exact active-tab filtering.
    const scope = await service.orderListTenantScopeMysql('2');
    const base = await service.orderBaseSqlMysql({}, '2');
    await query('INSERT INTO order_label_prints(order_id,printed_by_person_id,printed_at) VALUES(?,?,UTC_TIMESTAMP())', [221, null]);
    for (const status of ['all', 'awaiting_deliver', 'ogl_dispatched', 'delivering']) {
      const filtered = await service.orderFilteredSqlMysql({ status, searchType: 'order', searchQuery: 'shared', printFilter: 'unprinted' }, base, coverage, scope);
      const original = await query(`SELECT o.id FROM orders o WHERE ${filtered.where} ORDER BY o.id LIMIT 17 OFFSET 3`, filtered.params);
      const replacement = service.orderStatusSqlMysql(status, coverage, scope, 'ogl_count_evidence');
      const common = await service.orderFilteredSqlMysql({ status: 'all', searchType: 'order', searchQuery: 'shared', printFilter: 'unprinted' }, base, coverage, scope);
      const optimized = await query(`SELECT o.id FROM orders o ${service.orderPagedOglEvidenceJoinMysql(scope)} WHERE ${common.where} AND ${replacement} ORDER BY o.id LIMIT 17 OFFSET 3`, common.params);
      assert.deepEqual(optimized, original, status);
    }
  } finally { await fixture.cleanup(); }
});
