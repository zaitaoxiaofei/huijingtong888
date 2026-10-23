import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { bindingEnterprises, bindingPersonId, bindingSession, seedDraftBindingsReadFixture } from './helpers/draft-bindings-read-fixture.js';
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey } from '../src/services/business-task-tenant.js';
import { readDevelopmentPlan } from '../src/services/development-task-plan.js';

test('draft binding reads preserve ordinary default/A/B scope, private owner identity and fresh authorization', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent socket-only MySQL', timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture('binding_reads');
  fixture.useEnvironment();
  const { vehicleCatalogTenantPredicate } = await import('../src/services/ai-vehicle-catalog.js');
  const q = fixture.query;
  let afterRead;
  const source = readFileSync(new URL('../src/services/listing-draft-bindings.js', import.meta.url), 'utf8').replace(/^import[^;]*;\r?\n/gm, '').replaceAll('export ', '');
  const context = vm.createContext({ console, Number, String, Set, Map, JSON, Promise, readDevelopmentPlan, vehicleCatalogTenantPredicate,
    authorizeBusinessTaskSession: session => authorizeBusinessTaskSession(session, q), assertBusinessTaskPermission, businessTaskTenantKey,
    ensureVehicleCatalogSchema: async () => {}, mysqlExecute: q,
    mysqlQuery: async (sql, params) => { const rows = await q(sql, params); if (afterRead && (sql.includes('FROM listing_drafts draft') || sql.includes('ORDER BY task.created_at'))) await afterRead(); return rows; }
  });
  vm.runInContext(source, context, { filename: 'src/services/listing-draft-bindings.js' });
  try {
    const records = await seedDraftBindingsReadFixture(fixture);
    await context.listingDraftBindings({}, bindingSession(bindingEnterprises[0]));
    for (const tenant of bindingEnterprises) {
      const direct = records.get(tenant.key)[0];
      await q('INSERT INTO listing_draft_bindings(tenant_id,draft_id,task_id) VALUES(?,?,?)', [tenant.key, direct.draft, direct.task]);
    }
    await t.test('ordinary default with numeric enterprise 7, A and B read only their four actual draft/task chains', async () => {
      const ids = [...records.values()].flat().map(row => row.draft).join(',');
      for (const tenant of bindingEnterprises) {
        const rows = await context.listingDraftBindings({ ids, tenant_id: '3', tenantId: 3 }, bindingSession(tenant));
        assert.deepEqual(Array.from(rows, row => Number(row.draft_id)).sort(), records.get(tenant.key).map(row => row.draft).sort());
        for (const row of rows) {
          assert.match(row.task_title, new RegExp(`^Owned task ${tenant.id}/`));
          assert.equal(row.task_owner_name, `Owner ${tenant.id}/2`);
          assert.equal(row.task_owner_avatar_url, `https://example.invalid/private-owner-${tenant.id}-2.png`);
        }
        const other = records.get(tenant.key === '2' ? '3' : '2')[0];
        assert.deepEqual(Array.from(await context.listingDraftBindings({ ids: String(other.draft), tenant_id: tenant.key === '2' ? '3' : '2' }, bindingSession(tenant))), []);
      }
    });
    for (const tenant of bindingEnterprises) await t.test(`${tenant.key}: direct/model/unallocated/idea links never expose a foreign owner's name or avatar`, async () => {
      const owned = records.get(tenant.key), foreign = bindingEnterprises.find(item => item.key !== tenant.key);
      for (const row of owned) await q('UPDATE team_tasks SET owner_person_id=? WHERE id=?', [bindingPersonId(foreign, 2), row.task]);
      const rows = await context.listingDraftBindings({ ids: owned.map(row => row.draft).join(',') }, bindingSession(tenant));
      assert.equal(rows.length, 4);
      assert.ok(rows.every(row => row.task_title && row.task_owner_name === '' && row.task_owner_avatar_url === ''));
      const options = await context.listingDraftBindingOptions({}, bindingSession(tenant));
      assert.equal(options.tasks.length, 4);
      assert.ok(options.tasks.every(row => row.owner_person_id === null && row.owner_name === null && row.owner_avatar_url === null));
      for (const row of owned) await q('UPDATE team_tasks SET owner_person_id=? WHERE id=?', [bindingPersonId(tenant, 2), row.task]);
    });
    await t.test('disabled people and disabled enterprise membership suppress owner identity on all read paths', async () => {
      const tenant = bindingEnterprises[1], owned = records.get(tenant.key), session = bindingSession(tenant);
      for (const [disable, restore] of [
        ["UPDATE people SET active=0 WHERE id=?", "UPDATE people SET active=1 WHERE id=?"],
        ["UPDATE tenant_members SET active=0 WHERE person_id=?", "UPDATE tenant_members SET active=1 WHERE person_id=?"]
      ]) {
        await q(disable, [bindingPersonId(tenant, 2)]);
        const rows = await context.listingDraftBindings({ ids: owned.map(row => row.draft).join(',') }, session);
        assert.ok(rows.every(row => row.task_owner_name === '' && row.task_owner_avatar_url === ''));
        assert.ok((await context.listingDraftBindingOptions({}, session)).tasks.every(row => row.owner_name === null && row.owner_avatar_url === null));
        await q(restore, [bindingPersonId(tenant, 2)]);
      }
    });
    await t.test('poisoned foreign task bindings, development links and vehicle IDs do not widen the owned draft response', async () => {
      const tenant = bindingEnterprises[1], owned = records.get(tenant.key), foreign = records.get('3');
      await q('UPDATE listing_draft_bindings SET task_id=? WHERE tenant_id=? AND draft_id=?', [foreign[0].task, tenant.key, owned[0].draft]);
      await q('UPDATE team_tasks SET related_object=? WHERE id=?', [JSON.stringify({ kind: 'development_matrix', models: [{ draft_ids: [owned[0].draft] }] }), foreign[1].task]);
      await q("INSERT INTO ai_vehicle_catalog(id,tenant_id,brand_key,brand_name,model_key,model_name,source) VALUES(999,'3','private','B private','secret','B secret','user')");
      await q('INSERT INTO listing_draft_vehicle_links(tenant_id,draft_id,vehicle_catalog_id) VALUES(?,?,999)', [tenant.key, owned[0].draft]);
      const [row] = await context.listingDraftBindings({ ids: String(owned[0].draft) }, bindingSession(tenant));
      assert.equal(row.task_id, null); assert.equal(row.task_title, ''); assert.equal(row.task_owner_name, ''); assert.equal(row.vehicle_bindings.length, 0);
      await q('UPDATE listing_draft_bindings SET task_id=? WHERE tenant_id=? AND draft_id=?', [owned[0].task, tenant.key, owned[0].draft]);
    });
    for (const [name, revoke, restore] of [
      ['member', 'UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=201', 'UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=201'],
      ['job duty', "UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=201", "UPDATE tenant_members SET business_roles_json=JSON_ARRAY('operations') WHERE tenant_id=2 AND person_id=201"],
      ['subscription', "UPDATE tenants SET subscription_status='expired' WHERE id=2", "UPDATE tenants SET subscription_status='active' WHERE id=2"],
      ['person', 'UPDATE people SET active=0 WHERE id=201', 'UPDATE people SET active=1 WHERE id=201']
    ]) for (const endpoint of ['listingDraftBindings', 'listingDraftBindingOptions']) await t.test(`${endpoint}: ${name} revoked after the data query prevents returning saved rows`, async () => {
      let called = false;
      afterRead = async () => { if (!called) { called = true; await q(revoke); } };
      try {
        await assert.rejects(context[endpoint]({ ids: records.get('2').map(row => row.draft).join(',') }, bindingSession(bindingEnterprises[1])), { statusCode: 403 });
        assert.ok(called);
      } finally { afterRead = null; await q(restore); }
    });
  } finally { await fixture.cleanup(); }
});
