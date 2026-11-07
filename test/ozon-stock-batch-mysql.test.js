import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('actual stock batch uses own live credentials and saves each accepted or rejected audit outcome', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('stock_receipt'); fixture.useEnvironment();
  const q = fixture.query;
  const { batchUpdateOnlineProductStocksMysql } = await import('../src/services/mysql-cutover.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const previousFetch = globalThis.fetch;
  let mutation = null, rejectSecond = false;
  const calls = [];
  const actor = { personId: 7, roles: ['operations'], tenant: { id: 2, slug: 'a', role: 'member' } };
  const run = (body = {}) => batchUpdateOnlineProductStocksMysql({ shop_id: 20, online_product_ids: [101, 102], stock: 0, warehouse_id: 22, ...body }, 7, 2, { session: actor });
  globalThis.fetch = async (url, options) => {
    const stocks = JSON.parse(options.body).stocks; calls.push({ path: new URL(url).pathname, key: options.headers['Api-Key'], stocks });
    if (rejectSecond && calls.length === 2) return new Response('{"message":"forbidden batch fixture"}', { status: 403 });
    await mutation?.();
    return new Response(JSON.stringify({ result: stocks.map(row => ({ ...row, updated: row.product_id !== 1002, errors: row.product_id === 1002 ? [{ code: 'PRODUCT_IS_ARCHIVED', message: 'Product is archived' }] : [] })) }));
  };
  try {
    for (const sql of [
      "ALTER TABLE tenants ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'active'",
      'ALTER TABLE tenants ADD COLUMN subscription_expires_at DATETIME NULL'
    ]) try { await q(sql); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name,role,active) VALUES(7,'Operator','operations',1)");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,7,'member',JSON_ARRAY('operations'),1)");
    await q("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,api_key_hint) VALUES(20,2,'A','active','a-client','fixture-key'),(30,3,'B','active','b-client','foreign-key')");
    await q("INSERT INTO online_products(id,shop_id,ozon_product_id,ozon_sku,offer_id,name) VALUES(101,20,'1001','__MISSING_SKU__:1001','offer-1','No SKU'),(102,20,'1002','10002','offer-2','Rejected'),(103,30,'1001','10001','offer-1','Foreign')");
    await t.test('no-SKU products remain writable by authoritative offer/product ID and partial errors are visible', async () => {
      const result = await run();
      assert.equal(result.ok, false); assert.equal(result.success_count, 1); assert.equal(result.failed_count, 1);
      assert.deepEqual(result.results.map(row => [row.online_product_id, row.accepted]), [[101, true], [102, false]]);
      assert.ok(calls.every(call => call.path === '/v2/products/stocks' && call.key === 'fixture-key'));
      assert.ok(calls.flatMap(call => call.stocks).every(row => row.stock === 0));
      const audits = await q('SELECT tenant_id,online_product_id,status FROM online_product_actions ORDER BY online_product_id');
      assert.deepEqual(audits.map(row => [row.tenant_id, row.online_product_id, row.status]), [['2', 101, 'success'], ['2', 102, 'failed']]);
      assert.equal((await q('SELECT raw_json FROM online_products WHERE id=101'))[0]?.raw_json, null, 'supplier acceptance does not invent product stock snapshots');
    });
    await t.test('foreign row and invalid quantity are denied before external requests', async () => {
      calls.length = 0;
      await assert.rejects(run({ online_product_ids: [103], tenant_id: 3 }), /其他企业|不存在|没有找到/);
      await assert.rejects(run({ stock: -1 }), /整数/);
      await assert.rejects(run({ stock: 1.5 }), /整数/);
      assert.equal(calls.length, 0);
    });
    await t.test('in-flight key changes stop before subsequent batches', async () => {
      calls.length = 0;
      mutation = () => q("UPDATE shops SET api_key_hint='rotated-fixture-key' WHERE id=20");
      await assert.rejects(run(), /授权已变更/);
      assert.equal(calls.length, 1);
      mutation = null;
    });
    await t.test('a later 403 preserves accepted earlier audit rows and never starts another batch', async () => {
      calls.length = 0; rejectSecond = true;
      const ids = [101];
      for (let index = 0; index < 200; index++) {
        const id = index + 200; ids.push(id);
        await q('INSERT INTO online_products(id,shop_id,ozon_product_id,ozon_sku,offer_id,name) VALUES(?,20,?,?,?,?)', [id, String(id + 2000), String(id + 20000), 'batch-' + id, 'Batch fixture']);
      }
      const before = Number((await q('SELECT COALESCE(MAX(id),0) id FROM online_product_actions'))[0].id);
      await assert.rejects(run({ online_product_ids: ids }), error => {
        assert.equal(error.statusCode, 403); assert.equal(error.stockResult.success_count, 100); assert.equal(error.stockResult.failed_count, 101); return true;
      });
      const audits = await q('SELECT status,COUNT(*) count FROM online_product_actions WHERE id>? GROUP BY status', [before]);
      assert.deepEqual(Object.fromEntries(audits.map(row => [row.status, Number(row.count)])), { failed: 101, success: 100 });
      assert.equal(calls.length, 2); rejectSecond = false;
    });
    await t.test('revoked membership denies new writes before network', async () => {
      calls.length = 0;
      await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2');
      await assert.rejects(run(), /成员|不可用|权限|企业/);
      assert.equal(calls.length, 0);
    });
  } finally { globalThis.fetch = previousFetch; await closeMysqlPool(); await fixture.cleanup(); }
});
