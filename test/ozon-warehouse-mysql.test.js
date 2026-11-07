import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('warehouse pages use the current own active shop and stop if credentials change in flight', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async () => {
  const fixture = await createTenantMysqlFixture('warehouse'); fixture.useEnvironment();
  const q = fixture.query;
  const { onlineProductWarehousesMysql } = await import('../src/services/mysql-cutover.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const previousFetch = globalThis.fetch;
  const calls = []; let rotate = false;
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body); calls.push({ path: new URL(url).pathname, key: options.headers['Api-Key'], payload });
    if (rotate) await q("UPDATE shops SET api_key_hint='replacement-fixture-key' WHERE id=20");
    return new Response(JSON.stringify({ warehouses: [{ warehouse_id: payload.cursor ? 2002 : 2001, name: 'Own warehouse', status: 'active' }], has_next: !payload.cursor, cursor: payload.cursor ? '' : 'next' }));
  };
  try {
    for (const sql of ["ALTER TABLE tenants ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'active'", 'ALTER TABLE tenants ADD COLUMN subscription_expires_at DATETIME NULL']) {
      try { await q(sql); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    }
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name,role,active) VALUES(7,'Operator','operations',1)");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,7,'member',JSON_ARRAY('operations'),1)");
    await q("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,api_key_hint) VALUES(10,NULL,'Inactive legacy','inactive','legacy-client','fixture-key'),(20,2,'A','active','a-client','fixture-key'),(30,3,'B','active','b-client','foreign-fixture-key'),(21,2,'No credentials','active','','')");
    const result = await onlineProductWarehousesMysql({ shop_id: 20 },2);
    assert.deepEqual(result.warehouses.map(row => row.warehouse_id),['2001','2002']);
    assert.deepEqual(calls.map(call => call.payload),[{ limit:200,cursor:'' },{ limit:200,cursor:'next' }]);
    assert.ok(calls.every(call => call.path === '/v2/warehouse/list' && call.key === 'fixture-key'));
    calls.length=0;
    await assert.rejects(onlineProductWarehousesMysql({shop_id:30,tenant_id:3},2),error=>error.statusCode===404);
    await assert.rejects(onlineProductWarehousesMysql({shop_id:10},'admin'),error=>error.statusCode===403);
    await assert.rejects(onlineProductWarehousesMysql({shop_id:21},2),error=>error.statusCode===409);
    assert.equal(calls.length,0);
    rotate=true;
    await assert.rejects(onlineProductWarehousesMysql({shop_id:20},2),error=>error.statusCode===409 && /授权已变更/.test(error.message));
    assert.equal(calls.length,1,'no later page is fetched using a changed identity');
    rotate = false;
    calls.length = 0;
    const actor = { personId: 7, roles: ['operations'], tenant: { id: 2, slug: 'a', role: 'member' } };
    globalThis.fetch = async () => {
      calls.push('warehouse');
      await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2');
      return new Response(JSON.stringify({ warehouses: [{ warehouse_id: 2001, name: 'Own warehouse', status: 'active' }], has_next: true, cursor: 'next' }));
    };
    await assert.rejects(onlineProductWarehousesMysql({ shop_id: 20 }, 2, { session: actor }), error => error.statusCode === 403);
    assert.equal(calls.length, 1, 'membership revocation stops before a later warehouse page');
  } finally { globalThis.fetch=previousFetch;await closeMysqlPool();await fixture.cleanup(); }
});
