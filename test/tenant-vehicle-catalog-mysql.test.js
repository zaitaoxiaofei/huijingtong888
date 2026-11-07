import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { AI_VEHICLE_CATALOG_SCHEMA, migrateAiVehicleCatalogSchema } from '../src/services/ai-vehicle-catalog-schema.js';
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey } from '../src/services/business-task-tenant.js';
import { normalizeVehicleBrand, VEHICLE_BRAND_CHINESE } from '../src/shared/vehicle-brand.js';
import { hasPermission } from '../src/shared/permissions.js';
import { readDevelopmentPlan, developmentPlanProgress } from '../src/services/development-task-plan.js';
import { normalizeVehicleModelKey } from '../src/services/product-development-meta.js';
import { resolveInventoryTenantScope, inventoryTenantSql, assertInventoryReferences, assertInventoryMember } from '../src/services/inventory-tenant-scope.js';
import { AI_VARIANT_SOURCE_COLUMN_SQL, AI_VARIANT_SOURCE_INDEX_SQL } from '../src/services/ai-variant-draft-history-schema.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const load = (context, file) => vm.runInContext(read(file).replace(/^import[^;]*;\r?\n/gm, '').replaceAll('export ', ''), context, { filename: file });
const session = (id, personId = 7) => ({ personId, tenant: { id, slug: id === 1 ? 'default' : `enterprise-${id}` } });
const native = value => JSON.parse(JSON.stringify(value));

test('vehicle catalog, inventory use, draft binding and AI references isolate A/B/default in real MySQL', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires the independent TENANT_TEST_MYSQL_SOCKET', timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture('vehicle_catalog');
  const { query, connection } = fixture;
  try {
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'enterprise-2','A'),(3,'enterprise-3','B')");
    await query("INSERT INTO people(id,name,role) VALUES(7,'Same person','operations'),(8,'Packing','packing'),(9,'Procurement','procurement'),(10,'Technical','technical'),(11,'Platform','admin')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,7,'member',JSON_ARRAY('operations')),(2,7,'member',JSON_ARRAY('operations')),(3,7,'member',JSON_ARRAY('operations')),(2,8,'member',JSON_ARRAY('packing')),(2,9,'member',JSON_ARRAY('procurement')),(2,10,'member',JSON_ARRAY('technical'))");
    await query('DROP TABLE IF EXISTS ai_vehicle_catalog');
    await query(AI_VEHICLE_CATALOG_SCHEMA.replace("      tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',\n", '').replace('uniq_ai_vehicle_catalog_tenant_brand_model (tenant_id, brand_key, model_key)', 'uniq_ai_vehicle_catalog_brand_model (brand_key, model_key)'));
    await query("INSERT INTO ai_vehicle_catalog(brand_key,brand_name,model_key,model_name,source,created_by_person_id,vehicle_reference_image_url,updated_at) VALUES('legacy','LEGACY','private','Private','user',7,'https://example.invalid/legacy.jpg','2020-01-01'),('custom','CUSTOM','private','Private','custom',7,'','2020-01-01'),('seed','SEED','shared','Shared','builtin',NULL,'','2020-01-01')");
    await t.test('migration is read-only by default, repeatable, and preserves legacy source records', async () => {
      const before = await query('SELECT * FROM ai_vehicle_catalog ORDER BY id');
      assert.equal((await migrateAiVehicleCatalogSchema(connection)).mode, 'dry-run');
      assert.deepEqual(await query('SELECT * FROM ai_vehicle_catalog ORDER BY id'), before);
      await migrateAiVehicleCatalogSchema(connection, { apply: true });
      await migrateAiVehicleCatalogSchema(connection, { apply: true });
      const rows = await query('SELECT * FROM ai_vehicle_catalog ORDER BY id');
      assert.deepEqual(rows.map(row => row.tenant_id), ['admin', 'admin', 'builtin']);
      assert.deepEqual(rows.map(({ tenant_id, ...row }) => row), before);
    });
    const transaction = async action => {
      await connection.beginTransaction();
      try { const result = await action(connection); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
    };
    const context = vm.createContext({
      console, Date, Map, Set, Number, String, Object, Array, JSON, Promise,
      mysqlQuery: query, mysqlExecute: query, withMysqlTransaction: transaction,
      normalizeVehicleBrand, VEHICLE_BRAND_CHINESE, hasPermission, businessTaskTenantKey, migrateAiVehicleCatalogSchema,
      authorizeBusinessTaskSession: value => authorizeBusinessTaskSession(value, query), assertBusinessTaskPermission,
      readDevelopmentPlan, developmentPlanProgress, normalizeVehicleModelKey
    });
    load(context, 'src/services/ai-vehicle-catalog.js');
    const saved = new Map();
    await t.test('custom catalog entries are enterprise-owned even with forged ownership or source fields', async () => {
      for (const id of [1, 2, 3]) {
        saved.set(id, await context.addAiVehicleCatalogEntry({ brand: 'PRIVATEBRAND', model: 'Same Model', tenant_id: '3', source: 'builtin', created_by_person_id: 11, vehicleReferenceImageUrl: `https://example.invalid/${id}.jpg` }, session(id)));
      }
      assert.equal(new Set([...saved.values()].map(row => row.id)).size, 3);
      for (const id of [1, 2, 3]) {
        const catalog = await context.aiVehicleCatalog({ tenant_id: id === 2 ? '3' : '2' }, session(id));
        const model = catalog.brands.find(row => row.name === 'PRIVATEBRAND').models[0];
        assert.equal(model.vehicleReferenceImageUrl, `https://example.invalid/${id}.jpg`);
        assert.equal(model.source, 'user');
        assert.ok(catalog.brands.some(row => row.name === 'SEED'));
        assert.equal(catalog.brands.some(row => row.name === 'LEGACY'), id === 1);
        assert.equal(catalog.brands.some(row => row.name === 'CUSTOM'), id === 1);
      }
      assert.deepEqual((await query("SELECT tenant_id,source,created_by_person_id FROM ai_vehicle_catalog WHERE brand_key='privatebrand' ORDER BY tenant_id")).map(row => [row.tenant_id, row.source, Number(row.created_by_person_id)]), [['2', 'user', 7], ['3', 'user', 7], ['admin', 'user', 7]]);
    });
    await t.test('customizing a seeded model preserves shared seed data and other enterprise rows', async () => {
      const before = await query("SELECT * FROM ai_vehicle_catalog WHERE tenant_id='builtin' AND brand_key='haval' AND model_key='jolion'");
      const foreign = await query("SELECT * FROM ai_vehicle_catalog WHERE tenant_id IN ('3','admin') AND brand_key='privatebrand'");
      const own = await context.addAiVehicleCatalogEntry({ brand: 'HAVAL', model: 'Jolion', vehicleReferenceImageUrl: 'https://example.invalid/own.jpg' }, session(2));
      await context.addAiVehicleCatalogEntry({ brand: 'PRIVATEBRAND', model: 'SAME MODEL', tags: ['hot_used'], vehicleReferenceImageUrl: 'https://example.invalid/updated.jpg' }, session(2));
      assert.equal((await context.aiVehicleCatalog({}, session(2))).brands.find(row => row.name === 'HAVAL').models.filter(row => row.name === 'Jolion').length, 1);
      assert.equal((await context.aiVehicleCatalog({}, session(2))).brands.find(row => row.name === 'HAVAL').models.find(row => row.name === 'Jolion').id, own.id);
      assert.deepEqual(await query("SELECT * FROM ai_vehicle_catalog WHERE tenant_id='builtin' AND brand_key='haval' AND model_key='jolion'"), before);
      assert.deepEqual(await query("SELECT * FROM ai_vehicle_catalog WHERE tenant_id IN ('3','admin') AND brand_key='privatebrand'"), foreign);
      assert.equal((await query('SELECT model_name FROM ai_vehicle_catalog WHERE id=?', [saved.get(2).id]))[0].model_name, 'Same Model');
      await query('UPDATE ai_vehicle_catalog SET enabled=0 WHERE id=?', [saved.get(2).id]);
      const disabled = await query('SELECT * FROM ai_vehicle_catalog WHERE id=?', [saved.get(2).id]);
      await assert.rejects(context.addAiVehicleCatalogEntry({ brand: 'PRIVATEBRAND', model: 'Same Model', vehicleReferenceImageUrl: 'https://example.invalid/rejected.jpg' }, session(2)), { statusCode: 409 });
      assert.deepEqual(await query('SELECT * FROM ai_vehicle_catalog WHERE id=?', [saved.get(2).id]), disabled);
      await query('UPDATE ai_vehicle_catalog SET enabled=1 WHERE id=?', [saved.get(2).id]);
    });
    await t.test('inventory/team readers keep business access while write permission and fresh membership fail closed', async () => {
      for (const person of [8, 9, 10]) assert.ok((await context.aiVehicleCatalog({}, session(2, person))).brands.length);
      await assert.rejects(context.addAiVehicleCatalogEntry({ brand: 'PACKING', model: 'No' }, session(2, 8)), { statusCode: 403 });
      await assert.rejects(context.addAiVehicleCatalogEntry({ brand: 'TECHNICAL', model: 'No' }, { ...session(2, 10), platform_role: 'super_admin' }), { statusCode: 403 });
      await context.addAiVehicleCatalogEntry({ brand: 'PROCUREMENT', model: 'Allowed' }, session(2, 9));
      await assert.rejects(context.aiVehicleCatalog(), { statusCode: 403 });
      await assert.rejects(context.aiVehicleCatalog({}, { personId: 11, platform_role: 'super_admin' }), { statusCode: 403 });
      await assert.rejects(context.aiVehicleCatalog({}, { ...session(2, 11), platform_role: 'super_admin' }), { statusCode: 403 });
      await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7');
      await assert.rejects(context.aiVehicleCatalog({}, session(2)), { statusCode: 403 });
      await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7');
    });
    const listingSource = read('src/services/listing-automation.js');
    for (const table of ['listing_drafts', 'listing_category_templates', 'listing_shop_copies', 'listing_publish_records']) {
      const sql = listingSource.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`))?.[0];
      assert.ok(sql, `Runtime schema missing: ${table}`);
      await query(sql.replaceAll('${AI_VARIANT_SOURCE_COLUMN_SQL}', AI_VARIANT_SOURCE_COLUMN_SQL).replaceAll('${AI_VARIANT_SOURCE_INDEX_SQL}', AI_VARIANT_SOURCE_INDEX_SQL));
    }
    const bindings = vm.createContext({ ...context });
    load(bindings, 'src/services/listing-draft-bindings.js');
    const drafts = new Map();
    for (const id of [1, 2, 3]) {
      const key = id === 1 ? 'admin' : String(id);
      drafts.set(id, (await query("INSERT INTO listing_drafts(tenant_id,product_name,source_urls_json,source_images_json,manual_facts_json,ai_payload_json) VALUES(?,?,'[]','[]','{}','{}')", [key, `Draft ${id}`])).insertId);
      await query("INSERT INTO team_tasks(tenant_id,title,work_type) VALUES(?,?,'product_development')", [key, `Task ${id}`]);
    }
    await t.test('draft options and binding reject foreign vehicles and malformed historical links', async () => {
      for (const id of [1, 2, 3]) {
        const options = await bindings.listingDraftBindingOptions({}, session(id));
        assert.ok(options.vehicles.some(row => Number(row.id) === saved.get(id).id));
        assert.ok(!options.vehicles.some(row => Number(row.id) === saved.get(id === 2 ? 3 : 2).id));
        assert.deepEqual(Array.from(options.tasks, row => row.title), [`Task ${id}`]);
        await bindings.bindListingDrafts({ mode: 'vehicle', draft_ids: [drafts.get(id)], vehicle_ids: [saved.get(id).id] }, session(id));
      }
      const before = await query('SELECT * FROM listing_draft_vehicle_links ORDER BY tenant_id,draft_id');
      await assert.rejects(bindings.bindListingDrafts({ mode: 'vehicle', draft_ids: [drafts.get(2)], vehicle_ids: [saved.get(3).id] }, session(2)), /不存在或已停用/);
      assert.deepEqual(await query('SELECT * FROM listing_draft_vehicle_links ORDER BY tenant_id,draft_id'), before);
      await query("INSERT INTO listing_draft_vehicle_links(tenant_id,draft_id,vehicle_catalog_id) VALUES('2',?,?)", [drafts.get(2), saved.get(3).id]);
      const rows = await bindings.listingDraftBindings({ ids: String(drafts.get(2)) }, session(2));
      assert.deepEqual(native(rows[0].vehicle_bindings).map(row => Number(row.id)), [saved.get(2).id]);
      await assert.rejects(bindings.listingDraftBindingOptions(), { statusCode: 403 });
    });
    await t.test('AI target reference image lookup consumes only shared and current-enterprise rows', async () => {
      context.aiTenantId = () => '2';
      context.cleanText = value => String(value || '').trim();
      for (const name of ['vehicleIdentityParts', 'vehicleReferenceImagesByTarget']) {
        const source = read('src/services/ai-variant-lab.js').match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))?.[0];
        assert.ok(source);
        vm.runInContext(source, context);
      }
      const references = await context.vehicleReferenceImagesByTarget(['PRIVATEBRAND Same Model', 'LEGACY Private']);
      assert.equal(references.get('privatebrand same model'), 'https://example.invalid/updated.jpg');
      assert.equal(references.has('legacy private'), false);
    });
    await t.test('draft brand/model filtering cannot match a forged link to another enterprise catalog', async () => {
      const foreign = await context.addAiVehicleCatalogEntry({ brand: 'BPRIVATE', model: 'Secret' }, session(3));
      await query("INSERT INTO listing_draft_vehicle_links(tenant_id,draft_id,vehicle_catalog_id) VALUES('2',?,?)", [drafts.get(2), foreign.id]);
      const all = async (sql, params = []) => (await connection.query(sql, params))[0];
      const list = vm.createContext({ ...context, ensureListingListReadSchema: async () => {},
        listingTenantId: businessTaskTenantKey, row: async (sql, params) => (await all(sql, params))[0], all,
        normalizeDraftRow: row => row, resolveMappedMediaInValue: async value => value
      });
      vm.runInContext(listingSource.match(/^export async function listingDrafts\([^]*?^}/m)[0].replace('export ', ''), list);
      for (const filter of [{ vehicleBrand: 'bprivate' }, { vehicleModel: 'secret' }, { vehicleBrand: 'bprivate', vehicleModel: 'secret' }]) {
        const result = await list.listingDrafts({ paged: '1', lightweight: '1', ...filter }, session(2));
        assert.equal(result.total, 0);
      }
      assert.equal((await list.listingDrafts({ paged: '1', lightweight: '1', vehicleBrand: 'privatebrand', vehicleModel: 'same model' }, session(2))).total, 1);
    });
    await t.test('inventory request approval creates private models without treating another enterprise model as approved', async () => {
      await query("INSERT INTO people(id,name,role) VALUES(12,'Inventory reviewer','manager')");
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,12,'member',JSON_ARRAY('manager'))");
      const namingSchema = read('src/services/inventory-product-naming.js').match(/CREATE TABLE IF NOT EXISTS inventory_product_naming_options \([\s\S]*?ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci/)[0];
      await query(namingSchema);
      await query('ALTER TABLE inventory_product_naming_options ADD COLUMN reviewed_by_person_id BIGINT NULL, ADD COLUMN reviewed_at DATETIME NULL');
      await query("INSERT INTO inventory_product_naming_options(tenant_id,option_type,value,label,status) VALUES(2,'category','part','part','active'),(2,'accessory','普通款','普通款','active')");
      const inventory = vm.createContext({ ...context, randomUUID: () => 'inventory-vehicle',
        resolveInventoryTenantScope: value => resolveInventoryTenantScope(value, query), inventoryTenantSql,
        assertInventoryMember: (scope, person) => assertInventoryMember(scope, person, query),
        assertInventoryReferences: (scope, body, run = query) => assertInventoryReferences(scope, body, run),
        validateVehicleBrand: normalizeVehicleBrand,
        ensureInventoryProductNamingSchema: async () => {}, prepareInventoryProductCreationMysql: async () => {},
        createProductMysql: async (body, tx, tenant) => ({ id: (await tx.execute('INSERT INTO products(tenant_id,name) VALUES(?,?)', [Number(tenant), body.name]))[0].insertId })
      });
      vm.runInContext(read('src/services/mysql-cutover.js').match(/^export function normalizeStructuredNamingMysql\([^]*?^}/m)[0].replace('export ', ''), inventory);
      load(inventory, 'src/services/inventory-product-requests.js');
      const foreign = await query("SELECT * FROM ai_vehicle_catalog WHERE tenant_id='3' AND brand_key='bprivate'");
      const pending = await inventory.submitInventoryProductRequest({ owner_person_id: 7, structured_naming: { category: 'part', vehicle_brand: 'BPRIVATE', vehicle_models: ['Secret'] } }, session(2));
      assert.equal(pending.status, 'pending');
      const detail = await inventory.inventoryProductRequestDetail(pending.request_id, session(2));
      assert.ok(detail.new_options.some(row => row.type === 'vehicle_model' && row.value === 'Secret'));
      const reviewed = await inventory.reviewInventoryProductRequest(pending.request_id, { action: 'approve', revision: 1 }, { ...session(2, 12), role: 'manager', roles: ['manager'] });
      assert.equal(reviewed.status, 'approved');
      const own = await query("SELECT tenant_id,source,created_by_person_id FROM ai_vehicle_catalog WHERE tenant_id='2' AND brand_key='bprivate'");
      assert.deepEqual(own.map(row => [row.tenant_id, row.source, Number(row.created_by_person_id)]), [['2', 'user', 12]]);
      assert.deepEqual(await query("SELECT * FROM ai_vehicle_catalog WHERE tenant_id='3' AND brand_key='bprivate'"), foreign);
    });
  } finally { await fixture.cleanup(); }
});
