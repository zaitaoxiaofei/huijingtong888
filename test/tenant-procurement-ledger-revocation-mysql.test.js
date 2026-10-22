import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('ledger current locking authorization preserves tenant, action permissions and atomic inventory across revocation', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture('ledger_current');
  const oldFetch = globalThis.fetch;
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    globalThis.fetch = async () => { throw new Error('External requests forbidden in ledger acceptance'); };
    const service = await import('../src/services/mysql-cutover.js');
    ({ closeMysqlPool } = await import('../src/mysql-pool.js'));
    const q = fixture.query;
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name,role) VALUES(7,'Ordinary operator','operations'),(8,'B buyer','procurement'),(9,'Platform only','admin')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,7,'member',JSON_ARRAY('operations')),(2,7,'member',JSON_ARRAY('operations')),(3,8,'member',JSON_ARRAY('procurement'))");
    await q("INSERT INTO platform_grants(person_id,role,active,reason) VALUES(9,'super_admin',1,'Isolated fixture')");
    await service.warmCoreInventoryRuntimeMysql('admin');
    await q("INSERT INTO products(id,tenant_id,name,code) VALUES(100,NULL,'Default legacy','LEDGER-100'),(200,2,'A product','LEDGER-200'),(300,3,'B product','LEDGER-300')");
    const snapshot = async () => {
      const result = {};
      for (const table of ['inventory_movements', 'procurement_ledger_actions', 'procurement_stock_cost_tasks', 'procurement_stock_cost_links', 'purchase_cost_versions', 'purchase_orders', 'purchase_order_items', 'inbound_records']) result[table] = await q(`SELECT * FROM ${table} ORDER BY id`);
      result.products = await q('SELECT id,tenant_id,purchase_cost FROM products ORDER BY id');
      result.current = await q('SELECT * FROM inventory_current ORDER BY real_product_id');
      return result;
    };
    const body = async (product, tenant) => {
      const current = await service.procurementLedgerMysql({ product_id: product }, tenant);
      return { action_type: 'stocktake', product_id: product, counted_quantity: current.physical_estimate + 1, reason_code: 'other', reason_note: 'Isolated current authority count', revision: current.revision, request_key: randomUUID(), tenant_id: 999 };
    };

    await t.test('ordinary default NULL/A/B inventory writers stay in scope, remain idempotent and cannot borrow procurement authority', async () => {
      for (const [tenant, product, person] of [['admin', 100, 7], [2, 200, 7], [3, 300, 8]]) {
        const input = await body(product, tenant);
        const result = await service.applyInventoryStocktakeMysql(input, person, tenant);
        assert.equal(result.ok, true);
        assert.deepEqual(await service.applyInventoryStocktakeMysql(input, person, tenant), result);
        const [movement] = await q('SELECT tenant_id,product_id,owner_person_id FROM inventory_movements WHERE source_ref=?', [`reconciliation_${result.action_id}`]);
        assert.equal(Number(movement.tenant_id), product / 100); assert.equal(Number(movement.product_id), product); assert.equal(Number(movement.owner_person_id), person);
      }
      const before = await snapshot();
      await assert.rejects(service.applyProcurementLedgerMysql(await body(200, 2), 7, 2), { statusCode: 403 });
      await assert.rejects(service.applyInventoryStocktakeMysql({ ...await body(200, 2), action_type: 'record_purchase' }, 7, 2), { statusCode: 403 });
      await assert.rejects(service.applyInventoryStocktakeMysql({ ...await body(200, 2), product_id: 300, person_id: 8 }, 7, 2));
      await assert.rejects(service.applyInventoryStocktakeMysql(await body(200, 2), 9, 2));
      assert.deepEqual(await snapshot(), before);
    });

    for (const [tenant, product, person, access] of [['admin', 100, 7, 'inventory'], [2, 200, 7, 'inventory'], [2, 200, 7, 'procurement'], [3, 300, 8, 'procurement']]) {
      const tenantId = product / 100;
      const role = access === 'procurement' ? 'procurement' : 'operations';
      for (const [kind, disable, restore] of [
        ['duty', `UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=${tenantId} AND person_id=${person}`, `UPDATE tenant_members SET business_roles_json=JSON_ARRAY('${role}') WHERE tenant_id=${tenantId} AND person_id=${person}`],
        ['membership', `UPDATE tenant_members SET active=0 WHERE tenant_id=${tenantId} AND person_id=${person}`, `UPDATE tenant_members SET active=1 WHERE tenant_id=${tenantId} AND person_id=${person}`],
        ['subscription status', `UPDATE tenants SET subscription_status='suspended' WHERE id=${tenantId}`, `UPDATE tenants SET subscription_status='active' WHERE id=${tenantId}`],
        ['subscription expiry', `UPDATE tenants SET subscription_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=${tenantId}`, `UPDATE tenants SET subscription_expires_at=NULL WHERE id=${tenantId}`],
        ['identity', `UPDATE people SET active=0 WHERE id=${person}`, `UPDATE people SET active=1 WHERE id=${person}`]
      ]) await t.test(`${tenant}/${access}: ${kind} revoked during actual product lock wait rejects all ledger writes`, async () => {
        await q(`UPDATE tenant_members SET business_roles_json=JSON_ARRAY('${role}') WHERE tenant_id=? AND person_id=?`, [tenantId, person]);
        const input = await body(product, tenant), before = await snapshot();
        const blocker = await mysql.createConnection({ socketPath: fixture.env.DB_SOCKET_PATH, user: 'root', database: fixture.database });
        let pending;
        try {
          await blocker.beginTransaction();
          await blocker.query('SELECT id FROM products WHERE id=? FOR UPDATE', [product]);
          const apply = access === 'inventory' ? service.applyInventoryStocktakeMysql : service.applyProcurementLedgerMysql;
          pending = apply(input, person, tenant).then(value => ({ value }), error => ({ error }));
          let waiting = false;
          for (let index = 0; index < 200; index++) {
            const [row] = await q('SELECT COUNT(*) n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_DB=?', [fixture.database]);
            if (Number(row.n)) { waiting = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(waiting, true, 'The real product locking read must wait before authority changes');
          await q(disable); await blocker.commit();
          assert.equal((await pending).error?.statusCode, 403);
          assert.deepEqual(await snapshot(), before);
        } finally {
          await blocker.rollback(); if (pending) await pending; await blocker.end(); await q(restore);
        }
      });
    }
    await t.test('procurement ledger succeeds with current procurement duty after the rejected attempts', async () => {
      await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('procurement') WHERE tenant_id=2 AND person_id=7");
      assert.equal((await service.applyProcurementLedgerMysql(await body(200, 2), 7, 2)).ok, true);
    });
  } finally {
    globalThis.fetch = oldFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
