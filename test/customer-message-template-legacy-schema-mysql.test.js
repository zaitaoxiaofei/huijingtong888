import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { inspectCustomerMessageTemplateOwnership, migrateCustomerMessageTemplateOwnership } from '../src/services/customer-message-template-schema.js';

test('real legacy customer template id/shop schema migrates without losing IDs or old-writer isolation', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('legacy_templates');
  fixture.useEnvironment();
  const { assertTenantPilotSchemaReady } = await import('../src/services/tenant-pilot-schema.js');
  const { query } = fixture;
  async function reset() {
    await query('DROP TABLE IF EXISTS customer_message_templates');
    // Exact legacy identity/scope constraints found in the full-row recovery
    // clone: seven shop_id=0 global templates, id INT AUTO_INCREMENT PRIMARY.
    await query(`CREATE TABLE customer_message_templates (
      id INT NOT NULL AUTO_INCREMENT,scenario VARCHAR(64) NOT NULL,name VARCHAR(128) NOT NULL DEFAULT '',
      template_text TEXT NOT NULL,enabled TINYINT NOT NULL DEFAULT 0,shop_id INT NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      template_translation TEXT NULL,label VARCHAR(64) NOT NULL DEFAULT '',deleted TINYINT(1) NOT NULL DEFAULT 0,
      enabled_defaults_version INT NOT NULL DEFAULT 0,trigger_condition VARCHAR(64) NOT NULL DEFAULT '',
      delay_hours INT NOT NULL DEFAULT 1,rule_defaults_version INT NOT NULL DEFAULT 0,
      PRIMARY KEY(id),UNIQUE KEY uk_customer_message_template_scope(scenario,shop_id)
    ) ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    for (let n=0;n<7;n++) await query("INSERT INTO customer_message_templates(id,scenario,name,template_text,shop_id,updated_at) VALUES (?,?,?,?,0,'2025-01-02 03:04:05')", [10+n,`scenario_${n}`,`Original ${n}`,`Original template ${n}`]);
  }
  const apply = () => migrateCustomerMessageTemplateOwnership(query, { assignLegacyDefault: true });
  try {
    await query("INSERT INTO tenants(id,slug,name) VALUES(17,'default','Default'),(18,'a','A'),(19,'b','B')");
    await reset();
    await t.test('inspection and missing explicit apply flag never change the legacy schema or data', async () => {
      const before = await query('SHOW CREATE TABLE customer_message_templates');
      const state = await inspectCustomerMessageTemplateOwnership(query);
      assert.equal(state.known_legacy_id_shop_schema,true);
      assert.equal(state.legacy_null_count,7);
      assert.deepEqual(state.conflicting_unique_keys,[]);
      await assert.rejects(migrateCustomerMessageTemplateOwnership(query), /explicit/);
      assert.deepEqual(await query('SHOW CREATE TABLE customer_message_templates'),before);
    });
    await t.test('migration preserves all IDs, template bytes, update times and AUTO_INCREMENT', async () => {
      const before = await query('SELECT * FROM customer_message_templates ORDER BY id');
      const result = await apply();
      assert.equal(result.legacy_default_rows_assigned,7);
      const after = await query('SELECT * FROM customer_message_templates ORDER BY id');
      assert.deepEqual(after.map(({tenant_id,...row})=>row),before);
      assert.ok(after.every(row=>Number(row.tenant_id)===17));
      const indexes=await query('SHOW INDEX FROM customer_message_templates');
      assert.deepEqual(indexes.filter(row=>row.Key_name==='PRIMARY').sort((a,b)=>a.Seq_in_index-b.Seq_in_index).map(row=>row.Column_name),['tenant_id','scenario']);
      assert.deepEqual(indexes.filter(row=>row.Key_name==='uk_customer_message_template_legacy_id').map(row=>row.Column_name),['id']);
      assert.ok(!indexes.some(row=>row.Key_name==='uk_customer_message_template_scope'));
      const [column]=(await query('SHOW COLUMNS FROM customer_message_templates')).filter(row=>row.Field==='tenant_id');
      assert.equal(column.Null,'NO'); assert.equal(Number(column.Default),17);
      const [status]=await query("SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_message_templates'");
      assert.ok(Number(status.AUTO_INCREMENT)>=100);
      assert.equal((await assertTenantPilotSchemaReady(query)).ok,true);
    });
    await t.test('overlapping old/new writers dedupe independently for default/A/B and repeated migration is inert', async () => {
      for(const tenant of [18,19]) await query("INSERT INTO customer_message_templates(tenant_id,scenario,template_text) VALUES(?,'scenario_0',?)",[tenant,`Enterprise ${tenant}`]);
      await query("INSERT INTO customer_message_templates(scenario,shop_id,template_text) VALUES('scenario_0',0,'Old writer updated') ON DUPLICATE KEY UPDATE template_text=VALUES(template_text)");
      const expected=await query("SELECT tenant_id,template_text FROM customer_message_templates WHERE scenario='scenario_0' ORDER BY tenant_id");
      assert.deepEqual(expected,[{tenant_id:17,template_text:'Old writer updated'},{tenant_id:18,template_text:'Enterprise 18'},{tenant_id:19,template_text:'Enterprise 19'}]);
      await query("INSERT INTO customer_message_templates(scenario,shop_id,template_text) VALUES('old_new_scenario',0,'Old writer inserted') ON DUPLICATE KEY UPDATE template_text=VALUES(template_text)");
      const [inserted]=await query("SELECT id,tenant_id FROM customer_message_templates WHERE scenario='old_new_scenario'");
      assert.ok(Number(inserted.id)>=100); assert.equal(Number(inserted.tenant_id),17);
      const snapshot=await query('SELECT * FROM customer_message_templates ORDER BY id');
      for(let i=0;i<2;i++) assert.equal((await apply()).legacy_default_rows_assigned,0);
      assert.deepEqual(await query('SELECT * FROM customer_message_templates ORDER BY id'),snapshot);
      assert.deepEqual((await inspectCustomerMessageTemplateOwnership(query)).conflicting_unique_keys,[]);
    });
    await t.test('unknown/prefix unique keys remain refused before any schema mutation', async () => {
      await reset();
      await query('ALTER TABLE customer_message_templates ADD UNIQUE KEY unknown_identity(id)');
      await assert.rejects(apply(), /Unexpected.*unique/);
      assert.equal((await inspectCustomerMessageTemplateOwnership(query)).tenant_column,false);
      await query('ALTER TABLE customer_message_templates DROP INDEX unknown_identity,DROP INDEX uk_customer_message_template_scope,ADD UNIQUE KEY uk_customer_message_template_scope(scenario(20),shop_id)');
      await assert.rejects(apply(), /Unexpected.*unique/);
      assert.equal((await inspectCustomerMessageTemplateOwnership(query)).tenant_column,false);
    });
    await t.test('nonzero shop scopes and final enterprise/scenario collisions require manual review', async () => {
      await reset();
      await query('UPDATE customer_message_templates SET shop_id=28 WHERE id=10');
      await assert.rejects(apply(), /shop scopes.*manual enterprise/);
      assert.equal((await inspectCustomerMessageTemplateOwnership(query)).tenant_column,false);
      await query("INSERT INTO customer_message_templates(scenario,shop_id,template_text) VALUES('scenario_0',0,'Conflicting scope')");
      assert.equal((await inspectCustomerMessageTemplateOwnership(query)).duplicate_count,1);
      await assert.rejects(apply(), /ownership conflicts/);
      assert.equal((await query('SELECT COUNT(*) n FROM customer_message_templates'))[0].n,8);
    });
    await t.test('partially added tenant column preserves explicit customer ownership', async () => {
      await reset();
      await query('ALTER TABLE customer_message_templates ADD COLUMN tenant_id BIGINT UNSIGNED NULL');
      await query('UPDATE customer_message_templates SET tenant_id=18 WHERE id=16');
      const result=await apply();
      assert.equal(result.legacy_default_rows_assigned,6);
      assert.equal((await query('SELECT tenant_id FROM customer_message_templates WHERE id=16'))[0].tenant_id,18);
      assert.equal((await query('SELECT COUNT(*) n FROM customer_message_templates WHERE tenant_id=17'))[0].n,6);
    });
    await t.test('missing old shop default and foreign references do not silently become compatible', async () => {
      await reset();
      await query('ALTER TABLE customer_message_templates ALTER shop_id DROP DEFAULT');
      await assert.rejects(apply(), /Unexpected.*unique/);
      assert.equal((await inspectCustomerMessageTemplateOwnership(query)).tenant_column,false);
      await query('ALTER TABLE customer_message_templates ALTER shop_id SET DEFAULT 0');
      await query('CREATE TABLE old_template_consumer(id INT PRIMARY KEY,template_id INT,FOREIGN KEY(template_id) REFERENCES customer_message_templates(id)) ENGINE=InnoDB');
      try {
        await assert.rejects(apply(), /ID references.*manual/);
        assert.equal((await inspectCustomerMessageTemplateOwnership(query)).tenant_column,false);
      } finally { await query('DROP TABLE old_template_consumer'); }
    });
  } finally { await fixture.cleanup(); }
});
