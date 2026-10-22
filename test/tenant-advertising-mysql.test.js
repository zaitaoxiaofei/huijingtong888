import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('advertising reads, imports and remote mutations use current enterprise', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('advertising');
  fixture.useEnvironment();
  const service = await import('../src/services/advertising-analytics.js');
  const { withAdvertisingTenant, withAdvertisingTenantSession } = await import('../src/services/advertising-tenant-context.js');
  const { createAdvertisingRoutes } = await import('../src/server/routes/advertising.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const { query } = fixture;
  const scoped = (id, run) => withAdvertisingTenant(id === 1 ? 'admin' : id, run);
  try {
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    for (const id of [1, 2, 3]) {
      await query("INSERT INTO people(id,name,role) VALUES(?,?,'operations')", [id, `Staff ${id}`]);
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'member',JSON_ARRAY('operations'))", [id, id]);
      await query('INSERT INTO shops(id,tenant_id,name,performance_client_id,performance_client_secret) VALUES(?,?,?,?,?)', [id * 10, id === 1 ? null : id, `Shop only ${id}`, `fake-client-${id}`, 'test-only-secret']);
      await query('INSERT INTO products(id,tenant_id,name,code,purchase_cost) VALUES(?,?,?,?,?)', [id * 10, id === 1 ? null : id, `Product only ${id}`, `P-${id}`, id]);
    }
    for (const id of [1, 2, 3]) await scoped(id, () => service.upsertAdvertisingDailyRowsMysql({ rows: [{ shop_id: id * 10, product_id: id * 10, date_key: '2026-10-02', ozon_sku: 'same-sku', campaign_id: 'same-campaign', product_name: `Owned ad ${id}`, spend_rub: id * 100, revenue_rub: id * 1000 }] }));
    const range = { from: '2026-10-01', to: '2026-10-31' };
    await t.test('summary, list, details, quality, audit and pilot shop isolate A/B/default+NULL', async () => {
      for (const id of [1, 2, 3]) await scoped(id, async () => {
        const result = await service.advertisingDailyMysql(range);
        assert.deepEqual(result.rows.map(row => Number(row.shop_id)), [id * 10]);
        assert.equal(result.rows[0].spend_rub, id * 100);
        assert.equal((await service.advertisingDailySummaryMysql(range)).spend_rub, id * 100);
        assert.deepEqual((await service.advertisingDailyDetailsMysql(range)).rows.map(row => Number(row.shop_id)), [id * 10]);
        const quality = await service.advertisingDailyQualityMysql(range);
        assert.ok(!JSON.stringify(quality).includes(`Shop only ${id === 2 ? 3 : 2}`));
        assert.deepEqual((await service.advertisingHistoryAuditMysql(range)).rows.map(row => Number(row.shop_id)), [id * 10]);
        assert.equal(Number((await service.advertisingPilotShopMysql()).id), id * 10);
        assert.equal((await service.advertisingDailyMysql({ ...range, shop_id: id === 2 ? 30 : 20 })).total, 0);
      });
    });
    await t.test('mixed imports and foreign product references fail before any own or foreign row changes', async () => {
      const before = await query('SELECT SUM(spend_rub) total FROM ozon_ad_sku_daily');
      await assert.rejects(scoped(2, () => service.upsertAdvertisingDailyRowsMysql({ tenant_id: 3, rows: [
        { shop_id: 20, date_key: '2026-10-02', ozon_sku: 'same-sku', campaign_id: 'same-campaign', spend_rub: 9999 },
        { shop_id: 30, date_key: '2026-10-02', ozon_sku: 'same-sku', campaign_id: 'same-campaign', spend_rub: 9999 }
      ] })), /当前企业/);
      await assert.rejects(scoped(1, () => service.upsertAdvertisingDailyRowsMysql({ rows: [{ shop_id: 10, product_id: 30, date_key: '2026-10-02', ozon_sku: 'bad' }] })), /当前企业/);
      assert.deepEqual(await query('SELECT SUM(spend_rub) total FROM ozon_ad_sku_daily'), before);
    });
    await t.test('foreign campaign mutations and repairs never contact Ozon', async () => {
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => { calls++; throw new Error('Unexpected external call'); };
      try {
        await assert.rejects(scoped(2, () => service.stopAdvertisingCampaignMysql({ shop_id: 30, campaign_id: 'same-campaign', ...range })), /当前企业/);
        await assert.rejects(scoped(1, () => service.repairAdvertisingHistoryMysql({ ...range, apply: true, shop_ids: [30] })), /当前企业/);
        await assert.rejects(scoped(2, () => service.applyAdvertisingCampaignProductSettingMysql({ shop_id: 30, campaign_id: 'same-campaign', ozon_sku: 'same-sku', mode: 'bid', bid_rub: 5 })), /当前企业/);
        assert.equal(calls, 0);
        await scoped(2, () => service.applyAdvertisingCampaignProductSettingMysql({ shop_id: 20, campaign_id: 'same-campaign', ozon_sku: 'same-sku', mode: 'bid', bid_rub: 5, ...range }));
        assert.equal(Number((await query('SELECT campaign_bid_rub n FROM ozon_ad_sku_daily WHERE shop_id=20'))[0].n), 5);
        assert.equal(Number((await query('SELECT campaign_bid_rub n FROM ozon_ad_sku_daily WHERE shop_id=30'))[0].n), 0);
      } finally { globalThis.fetch = original; }
    });
    await t.test('current membership is checked at HTTP entry and after a remote response', async () => {
      const session = { personId: 2, tenant: { id: 2, slug: 'a' } };
      const routes = createAdvertisingRoutes({ services: { advertisingDaily: service.advertisingDailyMysql }, readJson: async req => req.body });
      const result = await routes['GET /api/advertising/daily']({ _session: session }, new URL('http://localhost:8788/api/advertising/daily?from=2026-10-01&to=2026-10-31&tenant_id=3'));
      assert.equal(Number(result.rows[0].shop_id), 20);
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
        return new Response(JSON.stringify({ access_token: 'fake-test-token' }), { status: 200 });
      };
      try {
        await assert.rejects(withAdvertisingTenantSession(session, () => service.stopAdvertisingCampaignMysql({ shop_id: 20, campaign_id: 'same-campaign', ...range })), /不可用|失效/);
        assert.equal(calls, 1, 'Revoked member cannot issue the subsequent campaign mutation');
        await assert.rejects(routes['GET /api/advertising/daily']({ _session: session }, new URL('http://localhost:8788/api/advertising/daily')), /不可用/);
      } finally { globalThis.fetch = original; }
    });
  } finally { await closeMysqlPool(); await fixture.cleanup(); }
});
