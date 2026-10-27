import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { SKU_ORDER_TRACKERS_SCHEMA, skuOrderTrackerSchemaState } from '../src/services/sku-order-tracking-schema.js';
import { applyTenantSkuOrderTrackers, inspectTenantSkuOrderTrackers } from '../scripts/lib/tenant-sku-order-trackers-migration.mjs';
import { migrationNeedsApply } from '../scripts/lib/release-database-plan.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/migrate-tenant-sku-order-trackers.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));
const legacySchema = SKU_ORDER_TRACKERS_SCHEMA
  .replace('  tenant_id BIGINT UNSIGNED NOT NULL,\n', '')
  .replace('UNIQUE KEY uk_sku_order_tracker_tenant_shop_sku (tenant_id, shop_id, ozon_sku)', 'UNIQUE KEY uk_sku_order_tracker (shop_id, ozon_sku)')
  .replace(',\n  KEY idx_sku_order_tracker_tenant_active_shop (tenant_id, active, shop_id)', '');

test('SKU tracking preserves legacy assignments and enforces A/B isolation after reviewed migration', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated TCP-disabled test MySQL socket', timeout: 90000
}, async t => {
  const fixture = await createTenantMysqlFixture('sku_tracking');
  const q = fixture.query;
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const cli = async apply => {
      const result = await execute(process.execPath, [script, `--database=${fixture.database}`, `--mysql-admin-socket=${process.env.TENANT_TEST_MYSQL_SOCKET}`, ...(apply ? ['--apply'] : [])], {
        cwd, timeout: 30000, env: { ...process.env, DB_NAME: 'must_not_use_application_database' }
      });
      return JSON.parse(result.stdout);
    };
    await q("INSERT INTO tenants(id,slug,name) VALUES (1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO shops(id,tenant_id,name,ozon_client_id) VALUES (10,NULL,'Legacy','10'),(11,1,'Default','11'),(20,2,'A','20'),(30,3,'B','30')");
    await q("INSERT INTO people(id,name,role) VALUES(1,'Default owner','operations'),(2,'A owner','operations'),(3,'B owner','operations')");
    await q('INSERT INTO tenant_members(tenant_id,person_id) VALUES(1,1),(2,2),(3,3)');
    await t.test('fresh initializer installs the same tenant-aware schema as runtime', async () => {
      const state = skuOrderTrackerSchemaState(await q('SHOW COLUMNS FROM sku_order_trackers'), await q('SHOW INDEX FROM sku_order_trackers'));
      assert.equal(state.ready, true);
    });
    await t.test('an unrecognized global unique key requires review and is never automatically dropped', async () => {
      await q('ALTER TABLE sku_order_trackers ADD UNIQUE KEY wrong_global_sku (ozon_sku)');
      const report = await inspectTenantSkuOrderTrackers(q);
      assert.equal(report.ready, false);
      assert.deepEqual(report.invalid_named_indexes, ['wrong_global_sku']);
      await assert.rejects(applyTenantSkuOrderTrackers(q), /unexpected indexes=1/);
      assert.equal((await q("SHOW INDEX FROM sku_order_trackers WHERE Key_name='wrong_global_sku'")).length, 1);
    });
    await q('DROP TABLE sku_order_trackers');
    await q(legacySchema);
    await q(`INSERT INTO sku_order_trackers(id,shop_id,ozon_sku,owner_person_id,decline_weeks,decline_percent,active,last_notified_at,created_by_person_id,created_at,updated_at)
      VALUES(101,10,'same-sku',1,3,33.25,1,'2026-10-01 10:11:12',1,'2026-09-01 01:02:03','2026-09-02 04:05:06'),
      (102,11,'same-sku',1,2,20,0,NULL,1,'2026-09-01','2026-09-02'),
      (201,20,'same-sku',2,2,25,1,NULL,2,'2026-09-01','2026-09-02'),
      (301,30,'same-sku',3,3,30,1,NULL,3,'2026-09-01','2026-09-02')`);
    const before = await q('SELECT * FROM sku_order_trackers ORDER BY id');
    const originalJson = JSON.stringify(before);
    const service = await import('../src/services/sku-order-tracking.js');
    ({ closeMysqlPool } = await import('../src/mysql-pool.js'));
    await t.test('legacy runtime fails closed with a business-readable 503 and leaves records intact', async () => {
      await assert.rejects(service.skuOrderTrackingList({}, '2'), error => error.code === 'TENANT_SKU_TRACKER_MIGRATION_REQUIRED' && error.status === 503);
      assert.equal(JSON.stringify(await q('SELECT * FROM sku_order_trackers ORDER BY id')), originalJson);
      assert.equal((await q("SHOW COLUMNS FROM sku_order_trackers LIKE 'tenant_id'")).length, 0);
    });
    await t.test('CLI dry-run uses only its explicit database, reports pending work and changes nothing', async () => {
      const report = await cli(false);
      assert.equal(report.mode, 'dry-run');
      assert.equal(report.changes_database, false);
      assert.equal(report.before.tracker_count, 4);
      assert.equal(migrationNeedsApply('migrate-tenant-sku-order-trackers.mjs', report), true);
      assert.equal(JSON.stringify(await q('SELECT * FROM sku_order_trackers ORDER BY id')), originalJson);
      assert.equal((await q("SHOW COLUMNS FROM sku_order_trackers LIKE 'tenant_id'")).length, 0);
    });
    await t.test('explicit apply preserves every original field and derives ownership only from the shop', async () => {
      const report = await cli(true);
      assert.equal(report.original_rows_preserved, true);
      assert.equal(report.after.ready, true);
      const after = await q('SELECT * FROM sku_order_trackers ORDER BY id');
      assert.deepEqual(after.map(row => Number(row.tenant_id)), [1, 1, 2, 3]);
      assert.equal(JSON.stringify(after.map(({ tenant_id, ...row }) => row)), originalJson);
      const ready = await cli(false);
      assert.equal(migrationNeedsApply('migrate-tenant-sku-order-trackers.mjs', ready), false);
    });
    await t.test('repeat apply performs no ownership update, index DDL or record changes', async () => {
      const calls = [];
      const result = await applyTenantSkuOrderTrackers(async (sql, params) => { calls.push(sql); return q(sql, params); });
      assert.equal(result.changes_database, false);
      assert.ok(!calls.some(sql => /^(?:ALTER|UPDATE|DELETE|INSERT|CREATE)\b/i.test(sql.trim())));
      const rows = await q('SELECT * FROM sku_order_trackers ORDER BY id');
      assert.equal(JSON.stringify(rows.map(({ tenant_id, ...row }) => row)), originalJson);
    });
    for (const [id, shop, quantity] of [[10, 10, 1], [11, 11, 2], [20, 20, 3], [30, 30, 4]]) {
      await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,'awaiting_packaging',UTC_TIMESTAMP())", [id, shop, `tracking-${id}`]);
      await q("INSERT INTO order_items(order_id,ozon_sku,ozon_name,quantity,sale_price) VALUES(?,'same-sku',?,?,10)", [id, `Item-${shop}`, quantity]);
      await q("INSERT INTO online_products(shop_id,ozon_sku,name,archived) VALUES(?,'same-sku',?,0)", [shop, `Item-${shop}`]);
    }
    await t.test('ordered and all-product scopes keep same-SKU sales and owner names inside each enterprise', async () => {
      for (const skuScope of ['ordered', 'all']) for (const [tenant, shops, quantities, owners] of [
        ['admin', [10, 11], [1, 2], ['Default owner', 'Default owner']], ['2', [20], [3], ['A owner']], ['3', [30], [4], ['B owner']]
      ]) {
        const result = await service.skuOrderTrackingList({ skuScope, pageSize: 100 }, tenant);
        result.rows.sort((a, b) => a.shop_id - b.shop_id);
        assert.equal(result.total, shops.length);
        assert.deepEqual(result.rows.map(row => Number(row.shop_id)), shops);
        assert.deepEqual(result.rows.map(row => Number(row.total_sales)), quantities);
        assert.deepEqual(result.rows.map(row => row.owner_name), owners);
      }
      assert.equal((await service.skuOrderTrackingList({ shopId: 30 }, '2')).total, 0);
      assert.equal((await service.skuOrderTrackingList({ keyword: 'Item-30' }, '2')).total, 0);
    });
    await t.test('tracker writes cannot target a foreign shop or assign a foreign enterprise owner', async () => {
      const foreign = await q('SELECT * FROM sku_order_trackers WHERE tenant_id=3');
      await assert.rejects(service.saveSkuOrderTracker({ shop_id: 30, ozon_sku: 'same-sku', owner_person_id: 2 }, 2, '2'), error => error.status === 404);
      await assert.rejects(service.saveSkuOrderTracker({ shop_id: 20, ozon_sku: 'same-sku', owner_person_id: 3 }, 2, '2'), error => error.status === 400);
      await service.saveSkuOrderTracker({ shop_id: 20, ozon_sku: 'same-sku', active: false, tenant_id: 3 }, 2, '2');
      assert.equal((await q('SELECT active FROM sku_order_trackers WHERE tenant_id=2'))[0].active, 0);
      assert.deepEqual(await q('SELECT * FROM sku_order_trackers WHERE tenant_id=3'), foreign);
    });
    await t.test('a conflicting existing enterprise or orphan shop blocks before mutation', async () => {
      await q("INSERT INTO sku_order_trackers(tenant_id,shop_id,ozon_sku) VALUES(3,20,'conflict')");
      const conflictRows = JSON.stringify(await q('SELECT * FROM sku_order_trackers ORDER BY id'));
      await assert.rejects(applyTenantSkuOrderTrackers(q), /ownership conflicts=1/);
      assert.equal(JSON.stringify(await q('SELECT * FROM sku_order_trackers ORDER BY id')), conflictRows);
      await q("DELETE FROM sku_order_trackers WHERE ozon_sku='conflict'");
      await q("INSERT INTO sku_order_trackers(tenant_id,shop_id,ozon_sku) VALUES(1,999,'orphan')");
      await assert.rejects(applyTenantSkuOrderTrackers(q), /orphan shops=1/);
      await q("DELETE FROM sku_order_trackers WHERE ozon_sku='orphan'");
    });
    await t.test('same-named incompatible indexes are rejected and never silently replaced', async () => {
      await q('ALTER TABLE sku_order_trackers DROP INDEX idx_sku_order_tracker_tenant_active_shop');
      await q('ALTER TABLE sku_order_trackers ADD KEY idx_sku_order_tracker_tenant_active_shop (shop_id,active,tenant_id)');
      const state = await inspectTenantSkuOrderTrackers(q);
      assert.deepEqual(state.invalid_named_indexes, ['idx_sku_order_tracker_tenant_active_shop']);
      await assert.rejects(applyTenantSkuOrderTrackers(q), /unexpected indexes=1/);
      assert.equal((await q("SHOW INDEX FROM sku_order_trackers WHERE Key_name='idx_sku_order_tracker_tenant_active_shop' AND Seq_in_index=1"))[0].Column_name, 'shop_id');
      await q('ALTER TABLE sku_order_trackers DROP INDEX idx_sku_order_tracker_tenant_active_shop');
      await q('ALTER TABLE sku_order_trackers ADD KEY idx_sku_order_tracker_tenant_active_shop (tenant_id,active,shop_id)');
    });
    await t.test('partially completed nullable ownership and old unique indexes can resume without losing records', async () => {
      await q('ALTER TABLE sku_order_trackers MODIFY tenant_id BIGINT UNSIGNED NULL');
      await q('ALTER TABLE sku_order_trackers ADD UNIQUE KEY uk_sku_order_tracker (shop_id,ozon_sku)');
      await q("INSERT INTO sku_order_trackers(tenant_id,shop_id,ozon_sku,owner_person_id,updated_at) VALUES(NULL,20,'partial',2,'2026-09-01')");
      const beforeRows = await q('SELECT * FROM sku_order_trackers ORDER BY id');
      const applied = await applyTenantSkuOrderTrackers(q);
      assert.equal(applied.after.ready, true);
      const afterRows = await q('SELECT * FROM sku_order_trackers ORDER BY id');
      assert.equal(afterRows.length, beforeRows.length);
      assert.deepEqual(afterRows.map(({ tenant_id, ...row }) => row), beforeRows.map(({ tenant_id, ...row }) => row));
      assert.equal(Number(afterRows.find(row => row.ozon_sku === 'partial').tenant_id), 2);
    });
    await t.test('duplicate natural keys remain untouched for review instead of deleting or choosing a winner', async () => {
      await q('ALTER TABLE sku_order_trackers DROP INDEX uk_sku_order_tracker_tenant_shop_sku');
      await q("INSERT INTO sku_order_trackers(tenant_id,shop_id,ozon_sku) VALUES(2,20,'same-sku')");
      const snapshot = JSON.stringify(await q('SELECT * FROM sku_order_trackers ORDER BY id'));
      await assert.rejects(applyTenantSkuOrderTrackers(q), /duplicate keys=1/);
      assert.equal(JSON.stringify(await q('SELECT * FROM sku_order_trackers ORDER BY id')), snapshot);
    });
  } finally {
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
