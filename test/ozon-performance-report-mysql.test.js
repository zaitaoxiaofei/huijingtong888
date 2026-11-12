import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

const payload = { campaigns: ['123'], dateFrom: '2026-11-01', dateTo: '2026-11-02', groupBy: 'DATE' };
const endpoint = '/api/client/statistics/json';
test('durable advertising report receipts use real MySQL across workers and restarts', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('ad_report_receipts');
  fixture.useEnvironment();
  const { query } = fixture;
  const { createPerformanceReportCheckpoints } = await import('../src/services/ozon-performance-report-checkpoint.js');
  const { withAdvertisingTenant, withAdvertisingTenantSession } = await import('../src/services/advertising-tenant-context.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const shop = { id: 20, performance_client_id: 'fake-client-2', performance_client_secret: 'fake-secret-2' };
  const store = options => createPerformanceReportCheckpoints({ shop, ...options });
  const scoped = run => withAdvertisingTenant(2, run);
  const clear = () => query("DELETE FROM system_settings WHERE `key` LIKE 'ozon.ad.report:%'");
  try {
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO people(id,name,role) VALUES(2,'Operator','operations')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,2,'member',JSON_ARRAY('operations'))");
    for (const id of [1,2,3]) await query('INSERT INTO shops(id,tenant_id,name,performance_client_id,performance_client_secret) VALUES(?,?,?,?,?)', [id * 10, id === 1 ? null : id, 'Shop ' + id, 'fake-client-' + id, 'fake-secret-' + id]);

    await t.test('a separate Node process persists a UUID; another process instance resumes it', async () => {
      const code = `import {createPerformanceReportCheckpoints} from './src/services/ozon-performance-report-checkpoint.js';
        import {withAdvertisingTenant} from './src/services/advertising-tenant-context.js';
        import {closeMysqlPool} from './src/mysql-pool.js';
        await withAdvertisingTenant(2,async()=>{const s=createPerformanceReportCheckpoints({shop:${JSON.stringify(shop)}});
          const h=await s.claim(${JSON.stringify(payload)},${JSON.stringify(endpoint)});await s.save(h,'cross-process-uuid');});await closeMysqlPool();`;
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: { ...process.env, ...fixture.env } });
      await scoped(async () => {
        const h = await store().claim(payload, endpoint);
        assert.equal(h.uuid, 'cross-process-uuid');assert.equal(h.resumed, true);
        assert.equal((await store().list()).length, 1);
        await store().complete(h);assert.equal((await store().list()).length, 0);
      });
    });
    await t.test('concurrent workers claim one create; a crashed create claim is never blindly expired', async () => {
      await clear();
      const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => scoped(() => store().claim(payload, endpoint))));
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'OZON_AD_REPORT_PENDING').length, 5);
      await assert.rejects(scoped(() => store({ now: () => Date.now() + 86400000 }).claim(payload, endpoint)), e => e.code === 'OZON_AD_REPORT_PENDING');
    });
    await t.test('stable campaign-set identity deduplicates ordering and separates query dates', async () => {
      await clear();
      await scoped(async () => {
        const s = store(), h = await s.claim({ ...payload, campaigns: ['456','123','123'] }, endpoint);
        await s.save(h, 'canonical-uuid');
        assert.equal((await s.claim({ ...payload, campaigns: ['123','456'] }, endpoint)).uuid, 'canonical-uuid');
        const second = await s.claim({ ...payload, dateTo: '2026-11-03' }, endpoint);
        assert.notEqual(second.key, h.key);
      });
    });
    await t.test('late completion or rejection cannot delete a newer creation claim', async () => {
      await clear();
      await scoped(async () => {
        const s = store(), old = await s.claim(payload, endpoint);await s.save(old, 'old');old.uuid = 'old';
        await s.complete(old);
        const current = await s.claim(payload, endpoint);await s.save(current, 'new');
        await s.complete(old);await s.rejected(old);
        assert.equal((await s.claim(payload, endpoint)).uuid, 'new');
      });
    });
    await t.test('Retry-After remains effective after recreating the service instance', async () => {
      await clear();
      await scoped(async () => {
        const s = store({ now: () => 1000 }), h = await s.claim(payload, endpoint);await s.save(h, 'deferred');await s.defer(h, 120000);
        await assert.rejects(store({ now: () => 120999 }).claim(payload, endpoint), e => e.code === 'OZON_AD_REPORT_PENDING');
        assert.equal((await store({ now: () => 121000 }).claim(payload, endpoint)).uuid, 'deferred');
      });
    });
    await t.test('tenant/shop boundaries, membership revocation and credential rotation fail closed', async () => {
      await clear();
      await scoped(async () => { const s = store(), h = await s.claim(payload, endpoint);await s.save(h, 'owned'); });
      await assert.rejects(withAdvertisingTenant(3, () => store().list()), /当前企业/);
      const session = { personId: 2, tenant: { id: 2, slug: 'a' } };
      await withAdvertisingTenantSession(session, async () => {
        await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
        await assert.rejects(store().list());
      });
      await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
      await query("UPDATE shops SET performance_client_secret='new-test-secret' WHERE id=20");
      await assert.rejects(scoped(() => store().list()), /密钥已变化/);
      await scoped(async () => {
        const updated = store({ shop: { ...shop, performance_client_secret: 'new-test-secret' } });
        assert.deepEqual(await updated.list(), []);
      });
      await query('UPDATE shops SET performance_client_secret=? WHERE id=20', [shop.performance_client_secret]);
      await query("UPDATE shops SET status='disabled' WHERE id=20");
      await assert.rejects(scoped(() => store().list()));
      await query("UPDATE shops SET status='active' WHERE id=20");
      await query('UPDATE shops SET tenant_id=3 WHERE id=20');
      await assert.rejects(scoped(() => store().list()));
      await query('UPDATE shops SET tenant_id=2 WHERE id=20');
    });
    await t.test('receipts retain minimal metadata and never contain credentials or tokens', async () => {
      const rows = await query("SELECT `key`,value_json FROM system_settings WHERE `key` LIKE 'ozon.ad.report:%'");
      assert.equal(rows.length, 1);
      const value = JSON.stringify(rows);
      for (const secret of [shop.performance_client_id, shop.performance_client_secret, 'access_token', 'Authorization']) assert.ok(!value.includes(secret));
      assert.ok(Buffer.byteLength(value) < 2000);
    });
    await t.test('public daily sync resumes a prior-date UUID and clears it only after real SQL import', async () => {
      await clear();
      await scoped(async () => { const s = store(), h = await s.claim(payload, endpoint);await s.save(h, 'import-recovery-uuid'); });
      const service = await import('../src/services/advertising-analytics.js');
      const original = globalThis.fetch;
      let creates = 0, polls = 0;
      globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname;
        let data;
        if (path === '/api/client/token') data = { access_token: 'test-only-token' };
        else if (path === '/api/client/campaign') data = { list: [{ id: '123', title: 'Restored campaign', advObjectType: 'SKU', state: 'RUNNING' }] };
        else if (path.endsWith('/v2/products')) data = { products: [{ sku: '456' }] };
        else if (path === '/api/client/statistics/report') {
          polls++;assert.equal(new URL(url).searchParams.get('UUID'), 'import-recovery-uuid');
          data = { '123': { report: { rows: [{ date: '2026-11-01', sku: '456', moneySpent: '12.34', views: 100, clicks: 10, orders: 2 }] } } };
        } else if (options.method === 'POST' && path.includes('/statistics/')) { creates++;throw Error('Must resume original UUID'); }
        else throw Error('Unexpected mocked path: ' + path);
        return new Response(JSON.stringify(data), { status: 200 });
      };
      try {
        await fixture.connection.query("CREATE TRIGGER reject_test_ad_import BEFORE INSERT ON ozon_ad_sku_daily FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='forced test import failure'");
        const failed = await scoped(() => service.syncAdvertisingDailyFromOzonMysql({ shop_id: 20, from: '2026-11-03', to: '2026-11-04' }));
        assert.equal(failed.results[0].status, 'error');
        assert.equal((await scoped(() => store().list()))[0].uuid, 'import-recovery-uuid');
        await fixture.connection.query('DROP TRIGGER reject_test_ad_import');
        const result = await scoped(() => service.syncAdvertisingDailyFromOzonMysql({ shop_id: 20, from: '2026-11-03', to: '2026-11-04' }));
        assert.equal(result.results[0].status, 'report_pending', JSON.stringify(result));
        assert.equal(result.results[0].recovered_prior_window_campaigns, 1);
        assert.equal(creates, 0);assert.equal(polls, 2);
        const rows = await query("SELECT date_key,spend_rub,clicks,orders FROM ozon_ad_sku_daily WHERE shop_id=20 AND campaign_id='123' AND ozon_sku='456'");
        assert.equal(rows.length, 1);assert.equal(rows[0].date_key, '2026-11-01');assert.equal(Number(rows[0].spend_rub), 12.34);assert.equal(rows[0].clicks, 10);
        assert.deepEqual(await scoped(() => store().list()), []);
      } finally { globalThis.fetch = original; }
    });
  } finally { await closeMysqlPool();await fixture.cleanup(); }
});
