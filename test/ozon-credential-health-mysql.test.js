import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('credential expiry persists atomically with scoped, deduplicated notifications and rejects stale credentials', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires an isolated socket-only MySQL', timeout: 120000
}, async () => {
  const fixture = await createTenantMysqlFixture('key_health');
  fixture.useEnvironment();
  const { query } = fixture;
  const service = await import('../src/services/ozon-credential-health-mysql.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const originalFetch = globalThis.fetch;
  let expires = new Date(Date.now() + 14 * 86400000).toISOString();
  let resolveProbe;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ expires_at: expires, roles: [{ name: 'Admin', methods: ['/v1/roles'] }] }) });
  try {
    await query('ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL');
    await query("INSERT INTO tenants(id,slug,name,status,subscription_status) VALUES (1,'default','Default','active','active'),(2,'a','A','active','active'),(3,'b','B','active','active')");
    await query("INSERT INTO people(id,name,role) VALUES (10,'A owner','operations'),(11,'A manager','operations'),(12,'B owner','operations'),(13,'Legacy staff','operations')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,10,'owner',JSON_ARRAY('operations')),(2,11,'member',JSON_ARRAY('operations')),(3,12,'owner',JSON_ARRAY('operations')),(1,13,'owner',NULL)");
    await query("INSERT INTO shops(id,tenant_id,name,user_id,ozon_client_id,ozon_api_key) VALUES(20,2,'A shop',11,'client-a','key-a'),(30,3,'B shop',12,'client-b','key-b'),(10,NULL,'Legacy shop',NULL,'client-default','key-default')");
    const first = await service.checkOzonHealth(2, 20);
    assert.equal(first.status, 'expiring');
    let notices = await query("SELECT tenant_id,recipient_person_id,status,content FROM system_notifications ORDER BY recipient_person_id");
    assert.deepEqual(notices.map(n => Number(n.recipient_person_id)), [10,11]);
    assert.ok(notices.every(n => Number(n.tenant_id) === 2 && n.content.includes('北京时间')));
    const notifications = await import('../src/services/system-notifications.js');
    const [ownerNotice] = await query('SELECT id FROM system_notifications WHERE recipient_person_id=10');
    const ownerSession = { personId: 10, tenant: { id: 2, slug: 'a', role: 'owner' } };
    await notifications.markSystemNotificationRead(ownerNotice.id, ownerSession);
    await assert.rejects(notifications.resolveSystemNotification(ownerNotice.id, ownerSession), error => error.statusCode === 409);
    await query("UPDATE system_notifications SET status='read' WHERE recipient_person_id=10");
    await service.checkOzonHealth(2,20,{force:true});
    assert.equal((await query('SELECT COUNT(*) n FROM system_notifications'))[0].n,2);
    assert.equal((await query('SELECT status FROM system_notifications WHERE recipient_person_id=10'))[0].status,'read');
    expires = new Date(Date.now()+6*86400000).toISOString();
    await service.checkOzonHealth(2,20,{force:true});
    assert.equal((await query("SELECT COUNT(*) n FROM system_notifications WHERE status!='resolved'"))[0].n,2);
    assert.equal((await service.readOzonHealth(3)).some(row=>row.shop_id===20),false);
    await assert.rejects(service.checkOzonHealth(3,20), error=>error.statusCode===404);
    await service.checkOzonHealth(1,10);
    assert.equal((await query("SELECT COUNT(*) n FROM system_notifications WHERE recipient_person_id=13"))[0].n,0,'legacy automatic owner does not gain management alerts');
    globalThis.fetch = () => new Promise(resolve => { resolveProbe = resolve; });
    const pending=service.checkOzonHealth(2,20,{force:true});
    for(let poll=0;!resolveProbe&&poll<100;poll++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(resolveProbe);
    await query("UPDATE shops SET ozon_api_key='replacement-key' WHERE id=20");
    resolveProbe({ok:true,json:async()=>({expires_at:expires,roles:[]})});
    assert.equal((await pending).status,'unchecked');
    globalThis.fetch=async()=>({ok:true,json:async()=>({expires_at:new Date(Date.now()+60*86400000).toISOString(),roles:[]})});
    const recovered=await service.checkOzonHealth(2,20);
    assert.equal(recovered.status,'valid');
    assert.equal((await query("SELECT COUNT(*) n FROM system_notifications WHERE tenant_id=2 AND status!='resolved'"))[0].n,0);
    const [shop]=await service.ozonHealthShops(2,20);
    await service.recordOzonSyncHealth(shop,2,'orders',{startedAt:'2026-11-04T00:00:00Z',success:true,coverage:'range A'});
    const success=(await service.readOzonHealth(2))[0].sync.orders.last_success_at;
    await service.recordOzonSyncHealth(shop,2,'orders',{startedAt:'2026-11-04T01:00:00Z',success:false,error:new Error('network'),coverage:'range B'});
    const failed=(await service.readOzonHealth(2))[0].sync.orders;
    assert.equal(failed.last_success_at,success);assert.equal(failed.last_success_coverage,'range A');assert.equal(failed.status,'failed');
    const raw=await query("SELECT value_json FROM system_settings WHERE `key` LIKE 'ozon.health:%'");
    assert.doesNotMatch(JSON.stringify(raw),/replacement-key|key-a|key-b|key-default/);
  } finally {
    globalThis.fetch=originalFetch;
    await closeMysqlPool();
    await fixture.cleanup();
  }
});
