import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { AI_BACKGROUND_TENANT_TABLES } from '../src/services/ai-background-tenant-tables.js';
import { migrateTenantAiBackground } from '../scripts/migrate-tenant-ai-background.mjs';
import { AI_VEHICLE_CATALOG_SCHEMA, migrateAiVehicleCatalogSchema } from '../src/services/ai-vehicle-catalog-schema.js';
import { AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA, AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA } from '../src/services/ai-material-optimization-schema.js';

test('actual startup readiness rejects legacy global keys, nonunique replacements and nullable ownership',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
  const fixture=await createTenantMysqlFixture('unique_schema');
  fixture.useEnvironment();
  const { assertTenantPilotSchemaReady } = await import('../src/services/tenant-pilot-schema.js');
  const {query}=fixture;
  try{
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default')");
    await t.test('fresh canonical and absent optional AI tables are ready without fabricated recipe ownership',async()=>{
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
      const recipe=await query("SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='sku_inventory_recipes' AND column_name='tenant_id'");
      assert.equal(recipe.length,0);
    });
    for(const [table,index,scopeColumns,legacyColumns]of[
      ['procurement_platform_orders','uk_procurement_platform_order','tenant_id,platform,platform_order_no','platform,platform_order_no'],
      ['procurement_payment_transactions','uk_procurement_payment_transaction','tenant_id,provider,external_no','provider,external_no'],
      ['procurement_payment_matches','uk_procurement_payment_match_order','tenant_id,platform_order_id','platform_order_id']
    ])await t.test(`${table} cannot start with the old global or nonunique replacement key`,async()=>{
      await query(`ALTER TABLE ${table} DROP INDEX ${index}, ADD UNIQUE INDEX ${index} (${legacyColumns})`);
      await assert.rejects(assertTenantPilotSchemaReady(query),{statusCode:503});
      await query(`ALTER TABLE ${table} DROP INDEX ${index}, ADD INDEX ${index} (${scopeColumns})`);
      await assert.rejects(assertTenantPilotSchemaReady(query),{statusCode:503});
      await query(`ALTER TABLE ${table} DROP INDEX ${index}, ADD UNIQUE INDEX ${index} (${scopeColumns})`);
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
    });
    await t.test('templates require the scoped primary key and reject a leftover global scenario index',async()=>{
      await query('ALTER TABLE customer_message_templates DROP PRIMARY KEY, ADD PRIMARY KEY (scenario)');
      await assert.rejects(assertTenantPilotSchemaReady(query),{statusCode:503});
      await query('ALTER TABLE customer_message_templates DROP PRIMARY KEY, ADD PRIMARY KEY (tenant_id,scenario), ADD UNIQUE INDEX unsafe_global_scenario(scenario)');
      await assert.rejects(assertTenantPilotSchemaReady(query),/unsafe_global_scenario/);
      await query('ALTER TABLE customer_message_templates DROP INDEX unsafe_global_scenario');
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
    });
    await t.test('numeric import ownership cannot remain nullable after key replacement',async()=>{
      await query('ALTER TABLE procurement_platform_orders MODIFY tenant_id BIGINT UNSIGNED NULL');
      await assert.rejects(assertTenantPilotSchemaReady(query),/NOT NULL/);
      await query('ALTER TABLE procurement_platform_orders MODIFY tenant_id BIGINT UNSIGNED NOT NULL');
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
      await query('ALTER TABLE procurement_platform_orders ALTER tenant_id SET DEFAULT 3');
      await assert.rejects(assertTenantPilotSchemaReady(query),/实际默认企业/);
      await query('ALTER TABLE procurement_platform_orders ALTER tenant_id DROP DEFAULT');
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
    });
    await t.test('an existing vehicle catalog requires the scoped key and exact owner type/default',async()=>{
      await query(AI_VEHICLE_CATALOG_SCHEMA);
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
      await query('ALTER TABLE ai_vehicle_catalog DROP INDEX uniq_ai_vehicle_catalog_tenant_brand_model, ADD UNIQUE INDEX uniq_ai_vehicle_catalog_brand_model(brand_key,model_key)');
      await assert.rejects(assertTenantPilotSchemaReady(query),/ai_vehicle_catalog/);
      await migrateAiVehicleCatalogSchema(fixture.connection,{apply:true});
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
      await query("ALTER TABLE ai_vehicle_catalog MODIFY tenant_id VARCHAR(80) NOT NULL DEFAULT 'admin'");
      await assert.rejects(assertTenantPilotSchemaReady(query),/ai_vehicle_catalog/);
      await query("ALTER TABLE ai_vehicle_catalog MODIFY tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin'");
      await query('ALTER TABLE ai_vehicle_catalog ADD UNIQUE INDEX uniq_ai_vehicle_catalog_brand_model(brand_key,model_key)');
      await assert.rejects(assertTenantPilotSchemaReady(query),/uniq_ai_vehicle_catalog_brand_model/);
      await migrateAiVehicleCatalogSchema(fixture.connection,{apply:true});
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
    });
    await t.test('material batch/item ownership must be complete, nonnullable, typed and scoped before startup',async()=>{
      await query(AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA);
      await assert.rejects(assertTenantPilotSchemaReady(query), { statusCode:503 });
      await query(AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA);
      assert.equal((await assertTenantPilotSchemaReady(query)).ok, true);
      for (const sql of [
        "ALTER TABLE ai_material_optimization_items MODIFY tenant_id VARCHAR(64) NULL DEFAULT 'legacy_review'",
        "ALTER TABLE ai_material_optimization_items MODIFY tenant_id VARCHAR(80) NOT NULL DEFAULT 'legacy_review'",
        "ALTER TABLE ai_material_optimization_items MODIFY tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin'"
      ]) {
        await query(sql);
        await assert.rejects(assertTenantPilotSchemaReady(query), /素材优化/);
        await query("ALTER TABLE ai_material_optimization_items MODIFY tenant_id VARCHAR(64) NOT NULL DEFAULT 'legacy_review'");
      }
      await query('ALTER TABLE ai_material_optimization_items ADD UNIQUE KEY unsafe_material_key(item_no)');
      await assert.rejects(assertTenantPilotSchemaReady(query), /素材优化/);
      await query('ALTER TABLE ai_material_optimization_items DROP INDEX unsafe_material_key');
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
      await query('DROP TABLE ai_material_optimization_items,ai_material_optimization_batches');
    });
    await t.test('each optional AI unique-key migration is required only after that table exists',async()=>{
      for(const [table,index,key]of AI_BACKGROUND_TENANT_TABLES){
        if(!index)continue;
        // Minimal historical storage shape accepted by the real migration;
        // no business queries are faked and every index is created in MySQL.
        await query(`CREATE TABLE ${table}(id BIGINT UNSIGNED PRIMARY KEY,tenant_id VARCHAR(64) NOT NULL DEFAULT 'admin',${key} VARCHAR(64) NOT NULL, UNIQUE INDEX ${index}(${key})) ENGINE=InnoDB`);
        await assert.rejects(assertTenantPilotSchemaReady(query),{statusCode:503});
        await migrateTenantAiBackground(fixture.connection,{apply:true});
        assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
        await query(`ALTER TABLE ${table} ADD UNIQUE INDEX unsafe_global_key(${key})`);
        await assert.rejects(assertTenantPilotSchemaReady(query),/unsafe_global_key/);
        await query(`ALTER TABLE ${table} DROP INDEX unsafe_global_key`);
        await query(`DROP TABLE ${table}`);
        assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
      }
    });
    await t.test('the actual fresh runtime initializers produce the same ownership and unique shapes',async()=>{
      await query("INSERT INTO people(id,name,role) VALUES(1,'Default schema operator','admin')");
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(1,1,'admin',JSON_ARRAY('admin'))");
      const session={personId:1,tenant:{id:1,slug:'default',role:'admin'}};
      const {aiVariantLabBatchJobs}=await import('../src/services/ai-variant-lab.js');
      const {ensureAiGenerationTaskSchema}=await import('../src/services/ai-generation-tasks.js');
      const {ensureAiVariantDraftSaveBatchSchema}=await import('../src/services/ai-variant-draft-save-batches.js');
      const {assetVariantBootstrap}=await import('../src/services/asset-variant-engine.js');
      const {ensureListingAutomationSchema}=await import('../src/services/listing-automation.js');
      await aiVariantLabBatchJobs({},session);
      await ensureAiGenerationTaskSchema();
      await ensureAiVariantDraftSaveBatchSchema();
      await assetVariantBootstrap({},session);
      await ensureListingAutomationSchema();
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
      const migrated=await migrateTenantAiBackground(fixture.connection,{apply:true});
      assert.ok(migrated.tables.every(row=>!row.exists||(!row.add_tenant_column&&!row.replace_unique)),'Fresh runtime must require no ownership or unique-key repair');
    });
  }finally{await (await import('../src/mysql-pool.js')).closeMysqlPool();await fixture.cleanup();}
});
