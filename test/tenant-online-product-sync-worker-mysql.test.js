import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import mysql from 'mysql2/promise';
import { createOrderFixtureSchema, orderFunctionSource } from './helpers/tenant-order-service.js';
import { resolveInventoryTenantScope, assertInventoryRecord, assertInventoryReferences, inventoryTenantSql } from '../src/services/inventory-tenant-scope.js';
import { authorizeBusinessTaskSession } from '../src/services/business-task-tenant.js';
import { hasPermission } from '../src/shared/permissions.js';
import * as sku from '../src/services/mysql-online-product-sku.js';
import * as client from '../src/ozonClient.js';
import { prepareOnlineProductMediaForStorage } from '../src/services/online-product-media-storage.js';
import { requestPublicMediaStream } from '../src/http/public-image-request.js';

test('actual product sync worker scopes reads/writes, stops after revocation and avoids full-catalog empty pulls', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL'
}, async t => {
  const database = 'ozon_online_worker_' + randomBytes(8).toString('hex');
  const connection = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: 'root', dateStrings: true });
  let created = false;
  const originalFetch = globalThis.fetch;
  let hook = null, mediaHook = null, empty = false, archive = false, withStocks = false;
  const requests = [], progress = [];
  try {
    assert.equal(Number((await connection.query('SELECT @@skip_networking isolated'))[0][0].isolated), 1);
    await connection.query('CREATE DATABASE `' + database + '`'); created = true;
    await connection.changeUser({ database });
    await createOrderFixtureSchema(connection);
    const query = async (sql, params = []) => (await connection.execute(sql, params))[0];
    await query("INSERT INTO tenants(id,slug,name,status,subscription_status) VALUES(1,'default','Default','active','active'),(2,'a','A','active','active'),(3,'b','B','active','active')");
    await query("INSERT INTO people(id,name,role,active) VALUES(7,'Operator','operations',1)");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(1,7,'member',JSON_ARRAY('operations'),1),(2,7,'member',JSON_ARRAY('operations'),1),(3,7,'member',JSON_ARRAY('operations'),1)");
    await query("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,ozon_api_key) VALUES(10,NULL,'Legacy','active','10','fixture-key'),(11,1,'Default','active','11','fixture-key'),(20,2,'A','active','20','fixture-key'),(30,3,'B','active','30','fixture-key')");
    const actor = id => ({ personId: 7, roles: ['operations'], tenant: { id, slug: id === 1 ? 'default' : id === 2 ? 'a' : 'b', role: 'member' } });
    const restore = async () => {
      hook = null; mediaHook = null; empty = false; archive = false; withStocks = false; requests.length = 0; progress.length = 0;
      await query("UPDATE people SET active=1");
      await query("UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY('operations')");
      await query("UPDATE tenants SET subscription_status='active'");
      await query("UPDATE shops SET tenant_id=CASE id WHEN 10 THEN NULL WHEN 11 THEN 1 WHEN 20 THEN 2 ELSE 3 END,status='active'");
    };
    globalThis.fetch = async (url, options) => {
      const endpoint = new URL(url).pathname, body = JSON.parse(options.body);
      const shop = Number(options.headers['Client-Id']);
      requests.push({ endpoint, body, shop });
      await hook?.({ endpoint, shop, body });
      let data;
      if (endpoint === '/v3/product/list') data = { result: { items: empty || !['EMPTY_STOCK', ...(archive ? ['ARCHIVED'] : [])].includes(body.filter.visibility) ? [] : [{ product_id: 101, offer_id: 'shared-offer' }], last_id: '' } };
      else if (endpoint === '/v4/product/info/stocks') data = { result: { items: withStocks
        ? [{ product_id: 101, sku: 1101, offer_id: 'shared-offer', stocks: [{ type: 'fbs', warehouse_id: 'fbs-1', present: 0 }] }] : [], cursor: '' } };
      else if (endpoint === '/v3/product/info/list') data = { items: body.product_id.map(id => ({ id, sku: id + 1, offer_id: 'offer-' + shop, name: 'Product ' + shop, price: '10', images: [] })) };
      else throw new Error('Unexpected external request ' + endpoint);
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const names = ['syncOzonOnlineProductsMysql', 'mapWithConcurrencyMysql', 'assertOrderTaskAccessMysql',
      'upsertOnlineProductDualWrite', 'buildOnlineProductPayload', 'archiveOnlineProductSkuAliasRowsMysql',
      'reconcileArchivedOnlineProductsMysql', 'refreshPendingListingStockSnapshotsMysql', 'clearStockSnapshotsForSyncMysql', 'upsertStockSnapshotMysql'];
    const context = vm.createContext({ Date, Map, Set, Object, Array, Number, String, Boolean, Math, Promise, Error,
      ...client, ...sku, hasPermission, authorizeBusinessTaskSession, inventoryTenantSql, requestPublicMediaStream,
      mysqlQuery: query, mysqlQueryOne: async (sql, params) => (await query(sql, params))[0] || null, mysqlExecute: query,
      resolveInventoryTenantScope: tenant => resolveInventoryTenantScope(tenant, query),
      assertInventoryRecord: (scope, kind, id) => assertInventoryRecord(scope, kind, id, query),
      assertInventoryReferences: (scope, body) => assertInventoryReferences(scope, body, query),
      ensureMysqlCutoverEnabled() {}, ensureOzonStockStorageSchemaMysql: async () => {}, invalidateMasterDataCachePrefix() {},
      throwIfAbortedMysql(signal) { if (signal?.aborted) throw signal.reason; }, OGL_DISPATCH_REFRESH: Symbol('fixture'),
      nullableNumber: value => Number(value) || null, normalizeMysqlNullableDateTime: value => value || null,
      normalizeMysqlNullableDate: value => value || null, snapshotStockNumberMysql: value => Number(value || 0),
      stockWarehouseRulesEnabledMysql: async () => [], resolveStockTypeMysql: row => row.stock_type,
      isRealOnlineProductSkuMysql: value => /^\d+$/.test(String(value)), onlineProductSkuRepairCandidateMysql: sku.onlineProductSkuRepairCandidateMysql,
      normalizeMysqlDateTime: value => value || '2026-10-22 00:00:00',
      prepareOnlineProductMediaForStorage: async (item, options) => {
        const result = await prepareOnlineProductMediaForStorage(item, { ...options, env: { OSS_ENABLED: 'false' } });
        await mediaHook?.();
        return result;
      }
    });
    vm.runInContext(names.map(orderFunctionSource).join('\n'), context);
    const run = (tenant, body = {}, options = {}) => context.syncOzonOnlineProductsMysql({ pending_listing: true, ...body }, {
      session: actor(tenant), tenantId: String(tenant), onProgress: item => progress.push(item), ...options
    });
    await t.test('default legacy, A and B operators write only their original shop, including equal product identifiers', async () => {
      for (const [tenant, shops] of [[1, [10, 11]], [2, [20]], [3, [30]]]) {
        await restore(); const result = await run(tenant, { tenant_id: 999 });
        assert.deepEqual(Array.from(result.shops, row => row.shop_id).sort(), shops);
        assert.ok(requests.every(row => shops.includes(row.shop)));
        assert.equal(result.upserted, shops.length);
        assert.ok(progress.some(row => row.phase === 'stocks'));
        assert.equal(progress.at(-1).completed_shops, shops.length);
      }
      assert.deepEqual((await query('SELECT shop_id FROM online_products ORDER BY shop_id')).map(row => row.shop_id), [10, 11, 20, 30]);
    });
    await t.test('foreign shop and foreign selected product fail before any Ozon request', async () => {
      await restore(); const foreign = (await query('SELECT id FROM online_products WHERE shop_id=30'))[0].id;
      await assert.rejects(run(2, { shop_id: 30 }), /不属于当前企业/);
      await assert.rejects(run(2, { online_product_ids: [foreign] }), /不属于当前企业/);
      assert.equal(requests.length, 0);
    });
    await t.test('stock snapshots update only the authorized original shop, even with the same SKU in another enterprise', async () => {
      await restore(); withStocks = true;
      await query("INSERT INTO ozon_stock_snapshots(shop_id,ozon_product_id,ozon_sku,warehouse_id,stock_type,present) VALUES(30,'101','1101','fbs-1','fbs_virtual',77)");
      await run(2);
      const rows = await query("SELECT shop_id,present FROM ozon_stock_snapshots WHERE ozon_sku='1101' ORDER BY shop_id");
      assert.deepEqual(rows.map(row => [row.shop_id, Number(row.present)]), [[20, 0], [30, 77]]);
    });
    await t.test('empty pending refs never send the unfiltered ALL stock request or clear saved stock', async () => {
      await restore(); empty = true;
      const before = await query('SELECT * FROM online_products ORDER BY id');
      const stocks = await query('SELECT * FROM ozon_stock_snapshots ORDER BY id');
      assert.equal((await run(2)).upserted, 0);
      assert.equal(requests.filter(row => row.endpoint.includes('stocks')).length, 0);
      assert.deepEqual(await query('SELECT * FROM online_products ORDER BY id'), before);
      assert.deepEqual(await query('SELECT * FROM ozon_stock_snapshots ORDER BY id'), stocks);
    });
    for (const mutation of [
      "UPDATE tenant_members SET active=0 WHERE tenant_id=2", "UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2",
      "UPDATE tenants SET subscription_status='expired' WHERE id=2", "UPDATE shops SET tenant_id=3 WHERE id=20", "UPDATE shops SET status='inactive' WHERE id=20"
    ]) await t.test('request-return revocation stops all subsequent writes: ' + mutation.split(' SET ')[1], async () => {
      await restore(); const before = await query('SELECT * FROM online_products ORDER BY id'); let changed = false;
      hook = async () => { if (!changed) { changed = true; await query(mutation); } };
      await assert.rejects(run(2), error => [403, 404].includes(error.statusCode));
      assert.deepEqual(await query('SELECT * FROM online_products ORDER BY id'), before);
      assert.equal(requests.filter(row => row.endpoint === '/v3/product/info/list').length, 0);
    });
    await t.test('archived reconciliation remains scoped and never invents stock or product rows', async () => {
      await restore(); archive = true;
      await run(2);
      const rows = await query('SELECT shop_id,archived FROM online_products ORDER BY shop_id');
      assert.deepEqual(rows.filter(row => Number(row.archived)).map(row => row.shop_id), [20]);
    });
    for (const mutation of ["UPDATE tenant_members SET active=0 WHERE tenant_id=2", "UPDATE shops SET tenant_id=3 WHERE id=20"])
      await t.test('authority is checked again after media work and before SQL writes: ' + mutation, async () => {
        await restore(); const before = await query('SELECT * FROM online_products ORDER BY id');
        mediaHook = () => query(mutation);
        await assert.rejects(run(2), error => [403, 404].includes(error.statusCode));
        assert.ok(requests.some(row => row.endpoint === '/v3/product/info/list'));
        assert.deepEqual(await query('SELECT * FROM online_products ORDER BY id'), before);
      });
    await t.test('selected sync uses product IDs directly rather than scanning all visibility buckets', async () => {
      await restore(); const own = (await query('SELECT id FROM online_products WHERE shop_id=20'))[0];
      const result = await run(2, { pending_listing: false, scope: 'selected', online_product_ids: [own.id] });
      assert.equal(result.upserted, 1);
      assert.deepEqual(requests.map(row => row.endpoint), ['/v3/product/info/list']);
    });
    await t.test('missing worker actor fails closed', async () => {
      await restore(); await assert.rejects(run(2, {}, { session: null }), /缺少有效的企业操作人员/);
      assert.equal(requests.length, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (created) await connection.query('DROP DATABASE `' + database + '`');
    await connection.end();
  }
});
