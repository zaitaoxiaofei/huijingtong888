import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('private material assets, startup guard and scheduled orchestration use real tenant schema', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('business_support');
  fixture.useEnvironment();
  const assets = await import('../src/services/material-assets.js');
  const { assertTenantPilotSchemaReady } = await import('../src/services/tenant-pilot-schema.js');
  const { runTenantScheduledWork } = await import('../src/services/tenant-scheduled-work.js');
  const { migrateTenantMaterialAssets } = await import('../scripts/migrate-tenant-material-assets.mjs');
  const notifications = await import('../src/services/system-notifications.js');
  const { migrateTenantSystemNotifications } = await import('../scripts/migrate-tenant-system-notifications.mjs');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const { query } = fixture;
  const session = id => ({ personId: id, tenant: { id, slug: id === 1 ? 'default' : `company-${id}` } });
  try {
    for (const id of [1, 2, 3]) {
      await query('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)', [id, id === 1 ? 'default' : `company-${id}`, `Company ${id}`]);
      await query("INSERT INTO people(id,name,role) VALUES(?,?,'operations')", [id, `Operator ${id}`]);
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'member',JSON_ARRAY('operations'))", [id, id]);
      await query('INSERT INTO products(id,tenant_id,name,code) VALUES(?,?,?,?)', [id * 10, id === 1 ? null : id, `Source ${id}`, `SRC-${id}`]);
    }
    const owned = new Map();
    for (const id of [1, 2, 3]) owned.set(id, await assets.createMaterialAsset({ asset_type: 'text', title: `Private text ${id}`, source_selection_id: id * 10, content_text: `Only ${id}`, tenant_id: 3, created_by: 3 }, 3, session(id)));
    await query("INSERT INTO material_assets(title,asset_type,content_text) VALUES('Legacy private','text','Default only')");
    await t.test('list, counts, detail, edits, archive and delete isolate A/B and legacy default assets', async () => {
      for (const id of [1, 2, 3]) {
        const list = await assets.materialAssets({ paged: 1, tenant_id: 3 }, session(id));
        assert.equal(list.total, id === 1 ? 2 : 1);
        assert.ok(!JSON.stringify(list).includes(`Private text ${id === 2 ? 3 : 2}`));
        assert.equal(Number(owned.get(id).created_by), id);
        await assert.rejects(assets.materialAssetDetail(owned.get(id === 2 ? 3 : 2).id, session(id)), /不存在/);
      }
      await assert.rejects(assets.updateMaterialAsset(owned.get(3).id, { title: 'stolen' }, session(2)), /不存在/);
      await assert.rejects(assets.archiveMaterialAsset(owned.get(2).id, session(1)), /不存在/);
      await assert.rejects(assets.deleteMaterialAsset(owned.get(3).id, session(2)), /不存在/);
      await assert.rejects(assets.createMaterialAsset({ asset_type: 'text', source_selection_id: 30 }, 2, session(2)), /当前企业/);
      assert.equal((await assets.updateMaterialAsset(owned.get(2).id, { title: 'A edited' }, session(2))).title, 'A edited');
      assert.equal((await assets.archiveMaterialAsset(owned.get(2).id, session(2))).status, 'archived');
      assert.equal((await assets.deleteMaterialAsset(owned.get(2).id, session(2))).ok, true);
      assert.equal((await assets.materialAssetDetail(owned.get(3).id, session(3))).title, 'Private text 3');
    });
    await t.test('migration dry-run is read only and repeated apply preserves ownership and content', async () => {
      const before = await query('SELECT id,tenant_id,content_text FROM material_assets ORDER BY id');
      assert.equal((await migrateTenantMaterialAssets(fixture.connection)).mode, 'dry-run');
      await migrateTenantMaterialAssets(fixture.connection, { apply: true });
      await migrateTenantMaterialAssets(fixture.connection, { apply: true });
      assert.deepEqual(await query('SELECT id,tenant_id,content_text FROM material_assets ORDER BY id'), before);
    });
    await t.test('startup fails closed when a required ownership column is missing', async () => {
      assert.equal((await assertTenantPilotSchemaReady(query)).ok, true);
      await query('ALTER TABLE material_assets DROP INDEX idx_material_assets_tenant, DROP COLUMN tenant_id');
      await assert.rejects(assertTenantPilotSchemaReady(query), /material_assets.tenant_id/);
      await migrateTenantMaterialAssets(fixture.connection, { apply: true });
      assert.equal((await assertTenantPilotSchemaReady(query)).ok, true);
    });
    await t.test('notifications isolate a shared member, generation totals, dedupe and mutations across enterprises', async () => {
      await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('admin')");
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(3,2,'member',JSON_ARRAY('admin'))");
      for (const id of [1, 2, 3]) {
        await query("INSERT INTO procurement_requests(tenant_id,product_id,quantity,status) VALUES(?,?,?,'pending')", [id === 1 ? null : id, id * 10, id * 10]);
        await notifications.generateOperationalNotifications(String(id));
      }
      const a = await notifications.listSystemNotifications({}, session(2));
      const bSession = { personId: 2, tenant: { id: 3, slug: 'company-3' } };
      const b = await notifications.listSystemNotifications({}, bSession);
      assert.equal(a.total, 1);
      assert.equal(b.total, 1);
      assert.ok(a.rows[0].content.includes('20'));
      assert.ok(!a.rows[0].content.includes('30'));
      assert.ok(b.rows[0].content.includes('30'));
      await notifications.generateOperationalNotifications('2');
      assert.equal((await notifications.listSystemNotifications({}, session(2))).total, 1, 'Retry remains idempotent');
      await notifications.markSystemNotificationRead(b.rows[0].id, session(2));
      assert.equal((await notifications.listSystemNotifications({}, bSession)).unread, 1);
      await notifications.markAllSystemNotificationsRead(session(2));
      assert.equal((await notifications.listSystemNotifications({}, session(2))).unread, 0);
      assert.equal((await notifications.listSystemNotifications({}, bSession)).unread, 1);
      await notifications.resolveSystemNotification(b.rows[0].id, bSession);
      assert.equal((await notifications.listSystemNotifications({}, bSession)).rows[0].status, 'resolved');
      await query("INSERT INTO system_notifications(recipient_person_id,title,dedupe_key) VALUES(1,'Legacy default notice','legacy-default')");
      assert.equal((await notifications.listSystemNotifications({}, session(1))).total, 2);
      const before = await query('SELECT id,tenant_id,content FROM system_notifications ORDER BY id');
      await migrateTenantSystemNotifications(fixture.connection);
      await migrateTenantSystemNotifications(fixture.connection, { apply: true });
      assert.deepEqual(await query('SELECT id,tenant_id,content FROM system_notifications ORDER BY id'), before);
    });
    await t.test('scheduler rechecks subscriptions, continues independent tenants and reports partial failure', async () => {
      const initial = [];
      const result = await runTenantScheduledWork(async id => { initial.push(id); return { updated: 1 }; }, query);
      assert.deepEqual(initial, ['1', '2', '3']);
      assert.equal(result.updated, 3);
      const seen = [];
      await assert.rejects(runTenantScheduledWork(async id => {
        seen.push(id);
        if (id === '1') await query("UPDATE tenants SET subscription_status='expired' WHERE id=2");
        if (id === '3') throw new Error('Expected isolated test error');
        return { updated: 1 };
      }, query), error => error.result.updated === 1 && error.result.errors.length === 1);
      assert.deepEqual(seen, ['1', '3']);
    });
  } finally { await closeMysqlPool(); await fixture.cleanup(); }
});
