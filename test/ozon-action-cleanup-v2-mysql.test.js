import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

const session = { personId: 7, tenant: { id: 2, slug: 'enterprise-2' } };
const isWrite = endpoint => /products\/(?:update|deactivate|delete)$/.test(endpoint);

test('automatic voucher exits require v2 product receipts and a verified reread', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('cleanup_v2');
  const originalFetch = globalThis.fetch;
  let closeMysqlPool;
  try {
    fixture.useEnvironment(); const q = fixture.query;
    await q("INSERT INTO tenants(id,slug,name) VALUES(2,'enterprise-2','Fixture')");
    await q("INSERT INTO people(id,name,role) VALUES(7,'Operator','operations')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,business_roles_json) VALUES(2,7,JSON_ARRAY('operations'))");
    const columns = await q('SHOW COLUMNS FROM shops');
    if (!columns.some(row => row.Field === 'ozon_api_key')) await q('ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL');
    await q("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(20,2,'A','fixture-client','fixture-key')");
    ({ closeMysqlPool } = await import('../src/mysql-pool.js'));
    const actions = await import('../src/services/ozon-actions.js');
    await actions.getOzonActionCleanupConfigMysql({ storeId: 20 }, session);
    let receipt = ['501'], exited = false, listStatus = 200;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      const endpoint = new URL(url).pathname;
      assert.equal(new URL(url).origin, 'https://api-seller.ozon.ru');
      assert.equal(options.headers['Client-Id'], 'fixture-client');
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ endpoint, body });
      assert.ok(!['/v1/actions/products','/v1/actions/products/deactivate'].includes(endpoint));
      let data, status = 200;
      if (endpoint === '/v1/actions') data = { result: [{ id: 123, action_type: 'COUPON', is_voucher_action: true }] };
      else if (endpoint === '/v2/actions/products') {
        status = listStatus;
        data = status !== 200 ? { message: status === 404 ? 'resource not found' : 'temporary unavailable' }
          : { products: [...(exited ? [] : [{ id: 501, add_mode: 'AUTO' }]), { id: 502, add_mode: 'SELLER' }], total: exited ? 1 : 2, last_id: '' };
      } else if (endpoint === '/v2/actions/products/deactivate') {
        assert.deepEqual(body, { action_id: 123, product_ids: ['501'] });
        exited = true; data = { product_ids: receipt };
      } else throw Error('Unexpected endpoint ' + endpoint);
      return new Response(JSON.stringify(data), { status });
    };
    const run = async () => {
      await q("DELETE FROM system_settings WHERE `key`='ozon.actions.cleanup:20'");
      calls.length = 0; exited = false;
      return actions.saveOzonActionCleanupConfigMysql({ storeId: 20, enabled: true }, session);
    };
    await t.test('automatic voucher exit skips manually added products and verifies actual removal', async () => {
      const result = await run();
      assert.equal(result.success, true); assert.equal(result.immediateRun.count, 1);
      assert.equal(result.config.lastResult.actionSummaries[0].verified, true);
      assert.equal(calls.filter(row => row.endpoint === '/v2/actions/products/deactivate').length, 1);
      assert.ok(!calls.some(row => row.endpoint === '/v1/actions/products/update'));
    });
    await t.test('empty, unrelated and duplicate receipts cannot claim an exit even if a later read would be empty', async () => {
      for (const value of [[], ['999'], ['501','501']]) {
        receipt = value; const result = await run();
        assert.equal(result.success, false); assert.equal(result.immediateRun.count, 0);
        assert.match(result.config.lastError, /未确认全部商品已退出/);
        assert.equal(calls.filter(row => isWrite(row.endpoint)).length, 1);
      }
    });
    await t.test('a v2 404 never causes a retry through the retired API or a mutation', async () => {
      receipt = ['501']; listStatus = 404; const result = await run();
      assert.ok(!calls.some(row => isWrite(row.endpoint)));
      assert.ok(calls.some(row => row.endpoint === '/v2/actions/products'));
      // A known activity disappearing can be skipped, but must not produce removals.
      assert.equal(result.immediateRun.count, 0);
    });
    await t.test('a failed v2 query preserves the failure and prevents an exit', async () => {
      listStatus = 500; const result = await run();
      assert.equal(result.success, false); assert.equal(result.immediateRun.count, 0);
      assert.ok(!calls.some(row => isWrite(row.endpoint)));
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
