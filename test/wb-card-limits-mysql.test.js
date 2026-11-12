import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { WB_SCHEMA } from '../src/services/wb-schema.js';
import { createWbPlatform, wbPlatform } from '../src/services/wb-platform.js';

test('WB capacity cache cannot bypass real SQL shop ownership, authorization verification or active status', { skip: !process.env.TENANT_TEST_MYSQL_SOCKET }, async () => {
  const fixture = await createTenantMysqlFixture('wb_capacity');
  try {
    const { query, connection } = fixture;
    for (const sql of WB_SCHEMA) await query(sql);
    await query("INSERT INTO tenants(id,slug,name,status,shop_limit) VALUES(2,'a','A','active',10),(3,'b','B','active',10)");
    await query("INSERT INTO people(id,name,active) VALUES(2,'A owner',1),(3,'B owner',1)");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,active) VALUES(2,2,'owner',1),(3,3,'owner',1)");
    let requests = 0;
    const service = createWbPlatform({ query, transaction: async work => { await connection.beginTransaction(); try { const result = await work(connection); await connection.commit(); return result; } catch (error) { await connection.rollback(); throw error; } }, request: async (account, kind, path) => {
      requests++;
      assert.equal(Number(account.tenant_id), 2);
      return path.endsWith('/limits') ? { data: { freeLimits: 600, paidLimits: 50 } } : { cards: [{ nmID: 123 }], cursor: { total: 1 } };
    } });
    const shop = await service.saveShop(2, { name: 'WB A', user_id: 2, wb_token: 'capacity-secret-A' });
    await query("UPDATE wb_shop_credentials SET seller_id='capacity-A',checked_at=UTC_TIMESTAMP() WHERE shop_id=?", [shop.id]);
    await assert.rejects(service.cardLimits(3, { shop_id: shop.id }), error => error.statusCode === 404);
    assert.equal(requests, 0);
    await service.cardLimits(2, { shop_id: shop.id });
    await new Promise(resolve => setTimeout(resolve, 20));
    const result = await service.cardLimits(2, { shop_id: shop.id });
    assert.equal(result.total.limit, 650);
    assert.equal(result.total.usage, 1);
    assert.equal(result.total.remaining, 649);
    const before = requests;
    await query('UPDATE wb_shop_credentials SET checked_at=NULL WHERE shop_id=?', [shop.id]);
    await assert.rejects(service.cardLimits(2, { shop_id: shop.id }), /检查授权/);
    await query('UPDATE wb_shop_credentials SET checked_at=UTC_TIMESTAMP() WHERE shop_id=?', [shop.id]);
    await query("UPDATE shops SET status='inactive' WHERE id=?", [shop.id]);
    await assert.rejects(service.cardLimits(2, { shop_id: shop.id }), error => error.statusCode === 404);
    assert.equal(requests, before);
    assert.ok(!JSON.stringify(result).includes('capacity-secret-A'));
    await query("UPDATE shops SET status='active' WHERE id=?", [shop.id]);
    await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('operations') WHERE person_id=2 AND tenant_id=2");
    fixture.useEnvironment();
    const session = { personId: 2, roles: ['operations'], tenant: { id: 2, slug: 'a', role: 'owner' } };
    const liveService = await wbPlatform(session, 'orders.read');
    assert.equal((await liveService.cardLimits(2, { shop_id: shop.id })).total.remaining, 649);
    const runtime = await import('../src/services/mysql-cutover.js');
    await query("INSERT INTO shops(tenant_id,name,platform,ozon_client_id,api_key_hint) VALUES(2,'Ozon A','ozon','123','real-test-key'),(3,'Foreign Ozon','ozon','999','foreign-key')");
    const originalFetch = globalThis.fetch;
    let ozonCalls = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://api-seller.ozon.ru/v4/product/info/limit');
      assert.equal(options.headers['Client-Id'], '123');
      ozonCalls++;
      return new Response(JSON.stringify({ result: { total: { limit: 1000, usage: 20 }, daily_create: { limit: 100, usage: 10 } } }));
    };
    try {
      const limits = await runtime.onlineProductLimitsMysql({}, '2', { session });
      assert.equal(limits.rows.length, 2);
      assert.equal(limits.rows.find(row => row.platform === 'wb').limit.total.remaining, 649);
      assert.equal(limits.rows.find(row => row.platform === 'ozon').limit.daily_create.remaining, 90);
      assert.equal(ozonCalls, 1);
      const filtered = await runtime.onlineProductLimitsMysql({ shop_id: shop.id }, '2', { session });
      assert.equal(filtered.rows.length, 1);
      assert.equal(filtered.rows[0].platform, 'wb');
      await query('UPDATE tenant_members SET active=0 WHERE person_id=2 AND tenant_id=2');
      await assert.rejects(liveService.cardLimits(2, { shop_id: shop.id }), error => error.statusCode === 403);
      const revoked = await runtime.onlineProductLimitsMysql({ shop_id: shop.id }, '2', { session });
      assert.equal(revoked.rows[0].ok, false);
      assert.equal(revoked.rows[0].limit, null);
    } finally { globalThis.fetch = originalFetch; }

  } finally { const { closeMysqlPool } = await import('../src/mysql-pool.js'); await closeMysqlPool(); await fixture.cleanup(); }
});
