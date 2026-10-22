import test from 'node:test';
import assert from 'node:assert/strict';
import { withOglDispatch, oglOrderDisplayStatus } from '../src/services/ogl-dispatch-state.js';
import { orderTransportEvidenceSql } from '../src/services/order-transport-evidence.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOrderFixtureSchema, loadTenantOrderService } from './helpers/tenant-order-service.js';
import { OGL_DISPATCH_REFRESH } from '../src/services/ogl-dispatch-access.js';

test('OGL display is derived from physical handover and gives platform terminal/online state priority', () => {
  const member = { batch_id: 1, batch_number: 'OGL-test', container_no: null, dispatched_at: '2026-10-22 01:00:00' };
  const waiting = { id: 1, status: 'awaiting_deliver', logistics_carrier: 'ogl' };
  assert.equal(withOglDispatch(waiting, member).display_status, 'ogl_dispatched');
  assert.equal(withOglDispatch(waiting, member).ogl_dispatch.container_no, null);
  for (const status of ['delivering', 'delivered', 'cancelled', 'returned_to_seller', 'arbitration']) {
    assert.equal(oglOrderDisplayStatus({ ...waiting, status }, member), '', status);
  }
  assert.equal(withOglDispatch({ ...waiting, status:'delivering', tracking_stage:'awaiting_deliver' }, member).display_status, 'delivering');
  assert.equal(withOglDispatch({ ...waiting, status:'cancelled', tracking_stage:'awaiting_deliver' }, member).display_status, 'cancelled');
  assert.equal(oglOrderDisplayStatus({ ...waiting, logistics_carrier: 'cel' }, member), '');
  assert.equal(oglOrderDisplayStatus(waiting, { ...member, withdrawn_at: '2026-10-22 02:00:00' }), '');
  assert.equal(oglOrderDisplayStatus(waiting, { ...member, dispatched_at: null }), '');
});

test('OGL routes allow only exact reviewed enterprise paths and preserve settings permission', () => {
  const session = { personId: 2, roles: ['packing'], tenant: { id: 2, slug: 'company', role: 'member' } };
  for (const [method, path] of [['GET', 'bootstrap'], ['POST', 'preview'], ['POST', 'batches'], ['GET', 'batch'], ['POST', 'action'], ['GET', 'file'], ['GET','official-carriages'], ['GET','official-carriage'], ['GET','official-carriage-tracking']]) {
    const parts = ['api', 'ogl-dispatch', path];
    assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);
    assert.equal(authorizeApiRequest({ _session: session, method }, parts).allowed, true);
  }
  assert.equal(authorizeApiRequest({ _session: session, method: 'PUT' }, ['api','ogl-dispatch','settings']).allowed, false);
  assert.equal(tenantIsolationDecision(session, ['api','ogl-dispatch','action','unreviewed'], 'POST').allowed, false);
  assert.equal(tenantIsolationDecision(session, ['api','ogl-dispatch','file'], 'POST').allowed, false);
  assert.equal(tenantIsolationDecision(session, ['api','ogl-dispatch','official-carriage'], 'POST').allowed, false);
  assert.equal(tenantIsolationDecision(session, ['api','ogl-dispatch','official-carriages','other'], 'GET').allowed, false);
  assert.equal(tenantIsolationDecision(session, ['api','ogl-dispatch','official-carriage-tracking'], 'POST').allowed, false);
});

test('OGL MySQL tabs, counts, rollback and stock transport evidence share one scoped handover record', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL'
}, async () => {
  const fixture = await createTenantMysqlFixture('ogl_state');
  try {
    await createOrderFixtureSchema(fixture.connection);
    const { service, query } = loadTenantOrderService(fixture.connection);
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO people(id,name,role) VALUES(2,'Packer','packing')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,2,'member',JSON_ARRAY('packing'))");
    const packing = {personId:2, roles:['packing'], tenant:{id:2, slug:'a', role:'member'}};
    await assert.rejects(service.assertOrderTaskAccessMysql({id:2},{session:packing}), /无权/);
    await assert.rejects(service.assertOrderTaskAccessMysql({id:2},{session:packing,oglDispatchRefresh:true}), /无权/);
    await service.assertOrderTaskAccessMysql({id:2},{session:packing,[OGL_DISPATCH_REFRESH]:true});
    await query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(20,2,'A'),(30,3,'B')");
    await query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(1,20,'OGL-1','awaiting_deliver','awaiting_deliver','2026-10-22'),(2,20,'CEL-2','awaiting_deliver','awaiting_deliver','2026-10-22'),(3,30,'OGL-B','awaiting_deliver','awaiting_deliver','2026-10-22'),(4,10,'OGL-legacy','awaiting_deliver','awaiting_deliver','2026-10-22')");
    await query("INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,created_by) VALUES(1,2,'A1','a1',20,3,2),(2,3,'B1','b1',30,1,3),(3,1,'D1','d1',10,1,1)");
    await query("INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,dispatched_at) VALUES(2,1,1,1,20,'OGL-1',UTC_TIMESTAMP()),(3,2,3,3,30,'OGL-B',UTC_TIMESTAMP()),(1,3,4,4,10,'OGL-legacy',UTC_TIMESTAMP())");
    const list = (status, tenant='2') => service.ordersPagedMysql({ status, includeRows:'0', includeLogisticsOptions:'0' }, tenant);
    let result = await list('ogl_dispatched');
    assert.equal(result.total, 1); assert.equal(result.counts.ogl_dispatched, 1); assert.equal(result.counts.awaiting_deliver, 1);
    assert.equal((await list('ogl_dispatched','3')).total, 1);
    assert.equal((await list('ogl_dispatched','admin')).total, 1);
    assert.equal((await list('awaiting_deliver')).total, 1, 'Existing CEL order stays in its original waiting tab');
    const evidence = async orderId => Number((await query(`SELECT ${orderTransportEvidenceSql('o')} AS entered_transport FROM orders o WHERE o.id=?`, [orderId]))[0].entered_transport);
    assert.equal(await evidence(1),1); assert.equal(await evidence(2),0);
    await query("UPDATE orders SET status='delivering',logistics_status='posting_in_transit' WHERE id=1");
    assert.equal((await list('ogl_dispatched')).total,0);
    assert.equal((await list('delivering')).total,1, 'Live online evidence overrides stale awaiting tracking stage');
    assert.equal((await list('awaiting_deliver')).total,1);
    await query("UPDATE orders SET status='cancelled',logistics_status='' WHERE id=1");
    assert.equal((await list('ogl_dispatched')).total,0);
    assert.equal((await list('awaiting_deliver')).total,1, 'Cancelled OGL member cannot leak into waiting via stale tracking stage');
    assert.equal((await list('cancelled')).total,1);
    await query("UPDATE orders SET status='delivered' WHERE id=1");
    assert.equal((await list('delivered')).total,1);
    assert.equal((await list('delivering')).total,0);
    await query("UPDATE orders SET status='awaiting_deliver',logistics_status='' WHERE id=1");
    await query("UPDATE ogl_dispatch_members SET withdrawn_at=UTC_TIMESTAMP(),active_order_id=NULL WHERE order_id=1");
    assert.equal((await list('awaiting_deliver')).total,2);
    assert.equal(await evidence(1),0, 'Withdrawal removes active handover evidence without changing platform status');
    await query('UPDATE ogl_dispatch_members SET active_order_id=1,withdrawn_at=NULL,tenant_id=3,batch_id=2 WHERE order_id=1');
    assert.equal((await list('ogl_dispatched')).total,0, 'Poisoned foreign membership cannot affect owned order state');
    assert.equal(await evidence(1),0);
  } finally { await fixture.cleanup(); }
});
