import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { installInventoryNumberingV2Triggers, inspectInventoryNumberingV2Schema } from '../src/services/inventory-numbering-v2.js';
import { buildInventoryNumberingPlan, inventoryNumberingSourceSummary } from '../src/services/inventory-numbering-plan.js';
import { migrateInventoryNumberingV2, readInventoryNumberingSource, recoverInventoryNumberingCutover, runInventoryNumberingMigrationCli } from '../scripts/migrate-inventory-numbering-v2.mjs';

const enabled = Boolean(process.env.TENANT_TEST_MYSQL_SOCKET);
const snapshot = async db => JSON.parse(JSON.stringify((await db.query('SELECT * FROM products ORDER BY id'))[0]));
const numberKeys = new Set(['inventory_number','inventory_number_category','inventory_number_brand','inventory_number_sequence','inventory_number_version']);
const withoutNumbers = rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !numberKeys.has(key))));

async function fixture(t) {
  const f = await createTenantMysqlFixture('numbermigration');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inventory-number-migration-'));
  t.after(async () => {
    assert.ok(path.basename(directory).startsWith('inventory-number-migration-'));
    await rm(directory, { recursive: true, force: true });
    await f.cleanup();
  });
  await f.connection.query("INSERT INTO tenants(id,slug,name,status) VALUES(7,'default','default','active'),(8,'customer','customer','active')");
  f.useEnvironment();
  const { initializeInventoryNumberingSchemaMysql } = await import('../src/services/inventory-numbering.js');
  await initializeInventoryNumberingSchemaMysql(f.connection);
  await f.connection.query(`INSERT INTO products(id,tenant_id,name,code,inventory_category,vehicle_brand,fitment_type,vehicle_model,vehicle_models_json,active,product_type,selection_status) VALUES
    (1,NULL,'first','P-TEST-1','钥匙壳','TENET','specific','T7','["T7"]',1,'main','listed'),
    (2,7,'hidden','P-TEST-2','钥匙壳','','universal','','[]',0,'main','listed'),
    (3,8,'foreign','P-TEST-3','门槛条','GEELY','specific','X','["X"]',1,'main','listed'),
    (4,7,'pending brand','P-TEST-4','门槛条','','specific','CX-5','["CX-5"]',1,'main','listed'),
    (5,7,'unused selection','P-TEST-5','','','','','[]',1,'selection','draft'),
    (6,7,'pending core','P-TEST-6','','TENET','','T7','["T7"]',1,'main','listed')`);
  await migrateInventoryNumberingV2(f.connection, { apply: true });
  const source = await readInventoryNumberingSource(f.connection);
  const manifest = { ...buildInventoryNumberingPlan(source), reviewed_by: 'fixture-reviewer', reason: 'Explicit complete inventory numbering cutover test' };
  return { ...f, directory, manifest, backupPath: path.join(directory, 'products.before.json') };
}

test('numbering CLI refuses implicit application databases, TCP and mixed export/write requests', async () => {
  await assert.rejects(runInventoryNumberingMigrationCli([]), /显式指定/);
  await assert.rejects(runInventoryNumberingMigrationCli(['--database=test','--mysql-admin-socket=127.0.0.1']), /不接受TCP/);
  await assert.rejects(runInventoryNumberingMigrationCli(['--database=test','--mysql-admin-socket=/tmp/test.sock','--export-plan=/tmp/plan','--apply']), /仅允许只读/);
});

test('source digests normalize driver BIGINT and boolean encodings without changing identifiers', () => {
  const row = { id:1,tenant_id:null,code:'P-1',selection_id:null,name:'test',inventory_number:'1-1',inventory_number_category:1,
    inventory_number_brand:null,inventory_number_sequence:1,inventory_number_version:1,inventory_category:'钥匙壳',vehicle_brand:'TENET',
    fitment_type:'specific',vehicle_model:'T7',vehicle_models_json:['T7'],active:1,product_type:'main',selection_status:'listed',updated_at:'2026-11-05 00:00:00.000000',inventory_eligible:1 };
  assert.deepEqual(inventoryNumberingSourceSummary([row]), inventoryNumberingSourceSummary([{...row,id:'1',inventory_number_category:'1',inventory_number_sequence:'1',inventory_number_version:'1',active:true,inventory_eligible:true}]));
});

test('real MySQL reviewed cutover preserves every non-number field, hidden ownership, old registry and old identifiers', {skip:!enabled}, async t => {
  const f = await fixture(t);
  const before = await snapshot(f.connection);
  const registry = JSON.parse(JSON.stringify(await f.query('SELECT * FROM inventory_number_categories ORDER BY id')));
  assert.equal((await migrateInventoryNumberingV2(f.connection,{manifest:f.manifest})).changes_database,false);
  assert.deepEqual(await snapshot(f.connection),before);
  const report = await migrateInventoryNumberingV2(f.connection,{apply:true,writersStopped:true,manifest:f.manifest,backupPath:f.backupPath});
  assert.equal(report.reviewed_product_count,5);
  assert.equal(report.old_aliases_preserved,4);
  const after = await snapshot(f.connection);
  assert.deepEqual(withoutNumbers(after),withoutNumbers(before));
  for(const row of after) {
    const target=f.manifest.products.find(target=>target.product_id===Number(row.id));
    assert.equal(row.inventory_number,target?target.new_inventory_number:null);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(await f.query('SELECT * FROM inventory_number_categories ORDER BY id'))),registry);
  const aliases = await f.query('SELECT alias_number,product_id,tenant_id FROM inventory_number_aliases ORDER BY product_id');
  assert.deepEqual(aliases.map(row=>[row.alias_number,Number(row.product_id),Number(row.tenant_id)]),before.filter(row=>row.inventory_number).map(row=>[row.inventory_number,Number(row.id),row.tenant_id===null?7:Number(row.tenant_id)]));
  assert.equal((await inspectInventoryNumberingV2Schema(f.connection)).active,true);
  const backup=JSON.parse(await readFile(f.backupPath,'utf8'));
  assert.deepEqual(backup.products,before);
  await f.connection.query('DROP TRIGGER products_inventory_number_alias_update');
  assert.equal((await recoverInventoryNumberingCutover(f.connection,f.backupPath)).preserved_committed_v2,true);
  assert.equal((await inspectInventoryNumberingV2Schema(f.connection)).active,true);
  assert.deepEqual(await snapshot(f.connection),after);
});

test('real MySQL stale snapshots, missing backup and absent stop confirmation refuse before product or trigger changes', {skip:!enabled}, async t => {
  const f = await fixture(t);
  const before = await snapshot(f.connection);
  await assert.rejects(migrateInventoryNumberingV2(f.connection,{apply:true,manifest:f.manifest,backupPath:f.backupPath}), /writers-stopped/);
  await assert.rejects(migrateInventoryNumberingV2(f.connection,{apply:true,writersStopped:true,manifest:f.manifest,backupPath:path.join(f.directory,'missing','before.json')}));
  assert.deepEqual(await snapshot(f.connection),before);
  await f.connection.query("UPDATE products SET name='edited after review' WHERE id=1");
  const changed=await snapshot(f.connection);
  await assert.rejects(migrateInventoryNumberingV2(f.connection,{apply:true,writersStopped:true,manifest:f.manifest,backupPath:f.backupPath}), /前值或编号映射已变化/);
  assert.deepEqual(await snapshot(f.connection),changed);
  assert.equal((await inspectInventoryNumberingV2Schema(f.connection)).numbering_version,1);
});

test('real MySQL unexpected trigger side effects roll back and interrupted inactive triggers recover before legacy writers restart', {skip:!enabled}, async t => {
  const f = await fixture(t);
  const before = await snapshot(f.connection);
  await f.connection.query("CREATE TRIGGER test_numbering_side_effect BEFORE UPDATE ON products FOR EACH ROW SET NEW.name='unexpected side effect'");
  await assert.rejects(migrateInventoryNumberingV2(f.connection,{apply:true,writersStopped:true,manifest:f.manifest,backupPath:f.backupPath}), /Unexpected changes beyond numbering fields/);
  assert.deepEqual(await snapshot(f.connection),before);
  assert.equal((await inspectInventoryNumberingV2Schema(f.connection)).numbering_version,1);
  await f.connection.query('DROP TRIGGER test_numbering_side_effect');
  await installInventoryNumberingV2Triggers(f.connection);
  await assert.rejects(f.connection.query("UPDATE products SET name='blocked' WHERE id=1"));
  const report=await recoverInventoryNumberingCutover(f.connection,f.backupPath);
  assert.equal(report.restored_legacy_triggers,true);
  await f.connection.query("UPDATE products SET name='legacy writes restored' WHERE id=1");
  assert.equal((await f.query('SELECT inventory_number FROM products WHERE id=1'))[0].inventory_number,before[0].inventory_number);
});

test('real MySQL explicit identity corrections and numbers commit together, preserving old names and every other field', {skip:!enabled}, async t => {
  const f=await fixture(t);
  await f.connection.query(`CREATE TABLE product_name_aliases(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,tenant_id BIGINT UNSIGNED NULL,product_id BIGINT UNSIGNED NOT NULL,alias_name VARCHAR(500) NOT NULL,alias_type VARCHAR(32) NOT NULL,active TINYINT NOT NULL DEFAULT 1,UNIQUE KEY(product_id,alias_name)) ENGINE=InnoDB`);
  await f.connection.query("UPDATE products SET updated_at='2026-01-01' WHERE id IN(4,6)");
  const before=await snapshot(f.connection);
  const identityCorrections=[{product_id:4,fields:{vehicle_brand:'MAZDA',name:'MAZDA CX-5 reviewed product'}},{product_id:6,fields:{inventory_category:'车窗饰条',vehicle_brand:'TENET',fitment_type:'specific',vehicle_model:'T7',vehicle_models_json:['T7']}}];
  const source=await readInventoryNumberingSource(f.connection);
  const manifest={...buildInventoryNumberingPlan({...source,identityCorrections}),reviewed_by:'user-confirmed-fixture',reason:'Explicit reviewed brand and core-name correction'};
  await f.connection.query("CREATE TRIGGER test_correction_side_effect BEFORE UPDATE ON products FOR EACH ROW BEGIN IF NEW.id=6 THEN SET NEW.purchase_cost=999; END IF; END");
  await assert.rejects(migrateInventoryNumberingV2(f.connection,{apply:true,writersStopped:true,manifest,backupPath:f.backupPath}),/Unexpected changes beyond numbering fields/);
  assert.deepEqual(await snapshot(f.connection),before);
  assert.equal((await f.query('SELECT COUNT(*) AS n FROM product_name_aliases'))[0].n,0);
  assert.equal((await inspectInventoryNumberingV2Schema(f.connection)).numbering_version,1);
  await f.connection.query('DROP TRIGGER test_correction_side_effect');
  const report=await migrateInventoryNumberingV2(f.connection,{apply:true,writersStopped:true,manifest,backupPath:path.join(f.directory,'success.before.json')});
  assert.equal(report.reviewed_identity_correction_count,2);
  const after=await snapshot(f.connection);
  for(let index=0;index<before.length;index++) {
    const fields=identityCorrections.find(row=>row.product_id===Number(before[index].id))?.fields || {};
    const omit=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!numberKeys.has(key)&&!(Object.keys(fields).length&&key==='updated_at')));
    assert.deepEqual(omit(after[index]),omit({...before[index],...fields}));
    if(Object.keys(fields).length)assert.notEqual(after[index].updated_at,before[index].updated_at);
  }
  const aliases=await f.query('SELECT tenant_id,product_id,alias_name,active FROM product_name_aliases');
  assert.deepEqual(aliases.map(row=>[Number(row.tenant_id),Number(row.product_id),row.alias_name,Number(row.active)]),[[7,4,'pending brand',1]]);
  assert.ok(manifest.products.filter(row=>[4,6].includes(row.product_id)).every(row=>row.category_id>0&&row.brand_id>0));
});

test('real MySQL an inactive or foreign old-name alias refuses explicit renaming without changing facts or numbers', {skip:!enabled}, async t => {
  const f=await fixture(t);
  await f.connection.query(`CREATE TABLE product_name_aliases(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,tenant_id BIGINT UNSIGNED NULL,product_id BIGINT UNSIGNED NOT NULL,alias_name VARCHAR(500) NOT NULL,alias_type VARCHAR(32) NOT NULL,active TINYINT NOT NULL DEFAULT 1,UNIQUE KEY(product_id,alias_name)) ENGINE=InnoDB`);
  await f.connection.query("INSERT INTO product_name_aliases(tenant_id,product_id,alias_name,alias_type,active) VALUES(8,4,'pending brand','previous_name',0)");
  const source=await readInventoryNumberingSource(f.connection);
  const manifest={...buildInventoryNumberingPlan({...source,identityCorrections:[{product_id:4,fields:{vehicle_brand:'MAZDA',name:'reviewed'}}]}),reviewed_by:'fixture',reason:'Explicit reviewed correction'};
  const before=await snapshot(f.connection);
  await assert.rejects(migrateInventoryNumberingV2(f.connection,{apply:true,writersStopped:true,manifest,backupPath:f.backupPath}),/旧名称别名已停用或归属异常/);
  assert.deepEqual(await snapshot(f.connection),before);
});
