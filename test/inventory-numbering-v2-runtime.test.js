import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';
import mysql from 'mysql2/promise';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { classifyInventoryNumberIdentity } from '../src/services/inventory-numbering-plan.js';
import { inventoryNumberingVersion, inspectInventoryNumberingV2Schema, prepareInventoryNumberingV2Schema,
  inventoryNumberTriggerSqlV2, inventoryNumberAliasTriggerSqlV2, installInventoryNumberingV2Triggers } from '../src/services/inventory-numbering-v2.js';
import { runInventoryNumberingSchemaCli } from '../scripts/init-inventory-numbering.mjs';

test('V2 SQL preserves old initializer markers and restricts administrative bypass', () => {
  for (const event of ['INSERT', 'UPDATE']) {
    const sql = inventoryNumberTriggerSqlV2(event);
    assert.match(sql, /old\.inventory_number_category = category_id/i);
    assert.doesNotMatch(sql.toLowerCase(), /new\.product_type|lpad/);
    assert.match(sql, /SUBSTRING_INDEX\(USER\(\), '@', 1\) = 'root'/);
    assert.match(sql, /inventory_number_sequences_v2\.category_id = category_id/);
    assert.match(sql, /inventory_number_sequences_v2\.brand_id = brand_id/);
  }
  assert.match(inventoryNumberAliasTriggerSqlV2(), /AFTER UPDATE/);
  assert.throws(() => inventoryNumberTriggerSqlV2('DELETE'));
});

test('schema CLI cannot infer a database, connect over TCP or request cutover', async () => {
  await assert.rejects(runInventoryNumberingSchemaCli([]), /Explicit database/);
  await assert.rejects(runInventoryNumberingSchemaCli(['--database=test', '--mysql-admin-socket=127.0.0.1']), /Explicit database/);
  await assert.rejects(runInventoryNumberingSchemaCli(['--apply']), /never cuts over/);
});

test('schema inspection refuses nontransactional products before additive preparation', async () => {
  let writes = 0;
  const db = async sql => {
    if (sql.startsWith('SELECT TABLE_NAME, ENGINE')) return [{ TABLE_NAME: 'products', ENGINE: 'MyISAM' }];
    if (/^(SELECT|SHOW) /.test(sql)) return [];
    writes++;
    throw new Error('Unexpected schema write');
  };
  const schema = await inspectInventoryNumberingV2Schema(db);
  assert.equal(schema.schema_ready, false);
  assert.deepEqual(schema.issues, ['Nontransactional numbering table: products']);
  await assert.rejects(prepareInventoryNumberingV2Schema(db), /Nontransactional numbering table: products/);
  assert.equal(writes, 0);
});

test('real V2 numbering: old writers, aliases, global counters, pending identity and restart safety', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires independent TCP-disabled test MySQL socket', timeout: 120000
}, async t => {
  const f = await createTenantMysqlFixture('number_v2');
  const q = async (sql, params = []) => (await f.connection.query(sql, params))[0];
  const username = `inv_v2_${randomBytes(5).toString('hex')}`;
  let pool, application, userCreated = false, writes = 0;
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(7,'default','Default'),(8,'other','Other')");
    const state = await prepareInventoryNumberingV2Schema(f.connection);
    assert.equal(state.schema_ready, true); assert.equal(state.numbering_version, 1); assert.equal(state.active, false);
    const runtimeSource = readFileSync(new URL('../src/services/inventory-numbering.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
    const context = vm.createContext({ inventoryNumberingVersion, inspectInventoryNumberingV2Schema, prepareInventoryNumberingV2Schema,
      mysqlQuery: q, mysqlExecute: async (sql, params) => { writes++; return (await f.connection.execute(sql, params))[0]; },
      withMysqlTransaction: async work => { await f.connection.beginTransaction(); try { const value = await work(f.connection); await f.connection.commit(); return value; } catch (error) { await f.connection.rollback(); throw error; } } });
    vm.runInContext(runtimeSource, context);
    await context.initializeInventoryNumberingSchemaMysql(f.connection);
    await q("INSERT INTO products(id,tenant_id,name,code,inventory_category,vehicle_brand,fitment_type,active) VALUES(1,7,'first','OLD-1','钥匙壳','TENET','specific',1),(2,8,'hidden','OLD-2','钥匙壳','TENET','specific',0),(3,NULL,'selection','OLD-3','门槛条','','universal',1)");
    await q("UPDATE products SET product_type='selection',selection_status='draft' WHERE id=3");
    const legacy = await q('SELECT id,inventory_number FROM products ORDER BY id');
    const oldRegistry = JSON.stringify(await q('SELECT * FROM inventory_number_categories ORDER BY id'));
    const installed = await installInventoryNumberingV2Triggers(f.connection, { triggerDefiner: 'CURRENT_USER' });
    assert.equal(installed.triggers_ready, true); assert.equal(installed.active, false);
    await assert.rejects(q("INSERT INTO products(name,inventory_category,vehicle_brand,fitment_type) VALUES('blocked','钥匙壳','TENET','specific')"), /not active/);
    await q('SET @inventory_numbering_v2_migration=1'); await f.connection.beginTransaction();
    await q("INSERT INTO inventory_number_core_categories_v2(id,core_name,initial_product_count) VALUES(1,'钥匙壳',2),(2,'门槛条',1)");
    await q("INSERT INTO inventory_number_brands_v2(id,brand_key,initial_product_count) VALUES(2,'TENET',2),(3,'BMW',0)");
    for (const row of legacy) {
      const id = Number(row.id), category = id === 3 ? 2 : 1, brand = id === 3 ? 1 : 2, sequence = id === 2 ? 2 : 1;
      await q('INSERT INTO inventory_number_aliases(alias_number,product_id,tenant_id) VALUES(?,?,?)', [row.inventory_number, id, id === 2 ? 8 : 7]);
      await q('UPDATE products SET inventory_number=?,inventory_number_category=?,inventory_number_brand=?,inventory_number_sequence=?,inventory_number_version=2,updated_at=updated_at WHERE id=?', [`${category}-${brand}-${sequence}`, category, brand, sequence, id]);
    }
    await q('INSERT INTO inventory_number_sequences_v2 VALUES(1,2,2),(2,1,1)');
    await q('UPDATE inventory_numbering_state SET version=2 WHERE id=1'); await f.connection.commit(); await q('SET @inventory_numbering_v2_migration=0');
    assert.equal((await inspectInventoryNumberingV2Schema(f.connection)).active, true);

    await t.test('ordinary edits and obsolete explicit number fields retain issued identities', async () => {
      const before = (await q('SELECT id,code,inventory_number,inventory_number_category,inventory_number_brand,inventory_number_sequence FROM products WHERE id=1'))[0];
      await q("UPDATE products SET name='renamed',is_consumable=1,inventory_number='99-99',inventory_number_category=999,inventory_number_brand=999,inventory_number_sequence=999 WHERE id=1");
      assert.deepEqual((await q('SELECT id,code,inventory_number,inventory_number_category,inventory_number_brand,inventory_number_sequence FROM products WHERE id=1'))[0], before);
    });
    await t.test('concurrent old writers share a global sequence and never reuse a hidden number', async () => {
      pool = mysql.createPool({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: 'root', database: f.database, connectionLimit: 8 });
      await Promise.all(Array.from({ length: 24 }, (_, index) => pool.query("INSERT INTO products(tenant_id,name,code,inventory_category,vehicle_brand,fitment_type) VALUES(?,? ,?,'钥匙壳','TENET','specific')", [index % 2 ? 7 : 8, `parallel-${index}`, `PAR-${index}`])));
      const rows = await q('SELECT inventory_number FROM products WHERE inventory_number_category=1 AND inventory_number_brand=2 ORDER BY inventory_number_sequence');
      assert.equal(new Set(rows.map(row => row.inventory_number)).size, 26);
      assert.deepEqual(rows.slice(0, 3).map(row => row.inventory_number), ['1-2-1', '1-2-2', '1-2-3']);
      assert.equal((await q('SELECT active FROM products WHERE id=2'))[0].active, 0);
    });
    await t.test('regrouping saves aliases, including actual default ownership for legacy NULL', async () => {
      await q("UPDATE products SET vehicle_brand='BMW' WHERE id=1");
      const row = (await q('SELECT id,code,inventory_number FROM products WHERE id=1'))[0];
      assert.equal(row.inventory_number, '1-3-1'); assert.equal(row.code, 'OLD-1');
      assert.equal((await q("SELECT tenant_id FROM inventory_number_aliases WHERE alias_number='1-2-1'"))[0].tenant_id, 7);
      await q("UPDATE products SET vehicle_brand='TENET',fitment_type='specific' WHERE id=3");
      assert.equal((await q("SELECT tenant_id FROM inventory_number_aliases WHERE alias_number='2-1-1'"))[0].tenant_id, 7);
    });
    await t.test('unstructured initial inserts stay unnumbered until structured update', async () => {
      const result = await q("INSERT INTO products(tenant_id,name,code) VALUES(7,'initial','INITIAL')");
      assert.equal((await q('SELECT inventory_number FROM products WHERE id=?', [result.insertId]))[0].inventory_number, null);
      await q("UPDATE products SET inventory_category='钥匙壳',vehicle_brand='TENET',fitment_type='specific' WHERE id=?", [result.insertId]);
      assert.match((await q('SELECT inventory_number FROM products WHERE id=?', [result.insertId]))[0].inventory_number, /^1-2-\d+$/);
      await assert.rejects(q("INSERT INTO products(name,inventory_category,vehicle_brand,fitment_type) VALUES('invalid','钥匙壳','TENET','')"), /identity is incomplete/);
    });
    await t.test('complete V2 identities reject missing facts and permit an explicit universal conversion', async () => {
      const inserted = await q("INSERT INTO products(tenant_id,name,code,inventory_category,vehicle_brand,fitment_type,vehicle_model,vehicle_models_json) VALUES(7,'complete identity','COMPLETE-IDENTITY','钥匙壳','TENET','specific','T7','[\"T7\"]')");
      const before = (await q('SELECT inventory_number,inventory_category,vehicle_brand,fitment_type,vehicle_model,vehicle_models_json FROM products WHERE id=?', [inserted.insertId]))[0];
      for (const assignment of ["inventory_category=''", "vehicle_brand=''", "fitment_type=''", "vehicle_models_json='{}'"]) {
        await assert.rejects(q(`UPDATE products SET ${assignment} WHERE id=?`, [inserted.insertId]), /identity is incomplete/);
      }
      assert.deepEqual((await q('SELECT inventory_number,inventory_category,vehicle_brand,fitment_type,vehicle_model,vehicle_models_json FROM products WHERE id=?', [inserted.insertId]))[0], before);
      await q("UPDATE products SET fitment_type='universal',vehicle_brand='',vehicle_model='',vehicle_models_json='[]' WHERE id=?", [inserted.insertId]);
      assert.match((await q('SELECT inventory_number FROM products WHERE id=?', [inserted.insertId]))[0].inventory_number, /^1-1-\d+$/);
      assert.equal(Number((await q('SELECT product_id FROM inventory_number_aliases WHERE alias_number=?', [before.inventory_number]))[0].product_id), Number(inserted.insertId));
    });
    await t.test('pending history permits ordinary edits, keeps known brands and aliases subsequent regrouping', async () => {
      await q('SET @inventory_numbering_v2_migration=1');
      await q("INSERT INTO products(id,tenant_id,name,code,inventory_number,inventory_number_category,inventory_number_brand,inventory_number_sequence,inventory_number_version,vehicle_brand,fitment_type) VALUES(700,7,'pending','PENDING-700','0-2-1',0,2,1,2,'TENET','')");
      await q('INSERT INTO inventory_number_sequences_v2 VALUES(0,2,1)'); await q('SET @inventory_numbering_v2_migration=0');
      await q("UPDATE products SET name='ordinary edit' WHERE id=700");
      assert.equal((await q('SELECT inventory_number FROM products WHERE id=700'))[0].inventory_number, '0-2-1');
      await q("UPDATE products SET vehicle_model='T7',vehicle_models_json='[\"T7\"]' WHERE id=700");
      assert.equal((await q('SELECT inventory_number FROM products WHERE id=700'))[0].inventory_number, '0-2-1');
      await q("UPDATE products SET inventory_category='门槛条',fitment_type='specific' WHERE id=700");
      assert.match((await q('SELECT inventory_number FROM products WHERE id=700'))[0].inventory_number, /^2-2-\d+$/);
      assert.equal((await q("SELECT product_id FROM inventory_number_aliases WHERE alias_number='0-2-1'"))[0].product_id, 700);
    });
    await t.test('historical SQL brand grouping agrees with the reviewed pure classifier', async () => {
      const cases = [ ['特耐|TENET','',null], ['ＴＥＮＥＴ','specific',null], ['NONE','universal','[]'], ['', 'universal','[""]'], ['TENET','specific','{}'], ['', 'universal','[]'], ['UNIVERSAL','specific',null], ['TENET','mystery',null] ];
      for (let index = 0; index < cases.length; index++) {
        const [brand, fitment, models] = cases[index], expected = classifyInventoryNumberIdentity({ inventory_category:'钥匙壳', vehicle_brand:brand, fitment_type:fitment, vehicle_model:'', vehicle_models_json:models });
        await q('SET @inventory_numbering_v2_migration=1');
        const result = await q("INSERT INTO products(tenant_id,name,code,inventory_number_version) VALUES(7,?,?,2)", [`case-${index}`, `CASE-${index}`]);
        await q('SET @inventory_numbering_v2_migration=0');
        await q('UPDATE products SET inventory_category=?,vehicle_brand=?,fitment_type=?,vehicle_models_json=? WHERE id=?', ['钥匙壳',brand,fitment,models,result.insertId]);
        assert.equal((await q('SELECT b.brand_key FROM products p JOIN inventory_number_brands_v2 b ON b.id=p.inventory_number_brand WHERE p.id=?', [result.insertId]))[0].brand_key, expected.brand_key, JSON.stringify(cases[index]));
      }
    });
    await t.test('large sequences expand and new brands keep the same number across categories', async () => {
      await q('UPDATE inventory_number_sequences_v2 SET last_sequence=9999 WHERE category_id=1 AND brand_id=2');
      await q("INSERT INTO products(tenant_id,name,code,inventory_category,vehicle_brand,fitment_type) VALUES(7,'large','LARGE','钥匙壳','TENET','specific')");
      assert.equal((await q("SELECT inventory_number FROM products WHERE code='LARGE'"))[0].inventory_number, '1-2-10000');
      await q("INSERT INTO products(tenant_id,name,code,inventory_category,vehicle_brand,fitment_type) VALUES(7,'new','NEW-BRAND','钥匙壳','CUSTOM','specific'),(8,'same','SAME-BRAND','门槛条','CUSTOM','specific')");
      assert.equal((await q("SELECT id FROM inventory_number_brands_v2 WHERE brand_key='CUSTOM'")).length, 1);
      assert.equal(new Set((await q("SELECT inventory_number_brand FROM products WHERE vehicle_brand='CUSTOM'")).map(row => row.inventory_number_brand)).size, 1);
    });
    await t.test('allocator skips collisions and code/selection edits cannot capture another identity', async () => {
      await q('SET @inventory_numbering_v2_migration=1');
      await q("INSERT INTO products(tenant_id,name,code,selection_id) VALUES(7,'reserved','1-2-10001','1-2-10002')");
      await q("INSERT INTO inventory_number_aliases(alias_number,product_id,tenant_id) VALUES('1-2-10003',2,8)"); await q('SET @inventory_numbering_v2_migration=0');
      await q("INSERT INTO products(tenant_id,name,code,inventory_category,vehicle_brand,fitment_type) VALUES(7,'skipped','SKIPPED','钥匙壳','TENET','specific')");
      assert.equal((await q("SELECT inventory_number FROM products WHERE code='SKIPPED'"))[0].inventory_number, '1-2-10004');
      await assert.rejects(q("UPDATE products SET code='1-2-10003' WHERE id=1"), /identifier belongs/);
      await assert.rejects(q("UPDATE products SET selection_id='1-2-10004' WHERE id=1"), /identifier belongs/);
    });
    await t.test('application users cannot enable the root migration bypass', async () => {
      await q(`CREATE USER '${username}'@'localhost' IDENTIFIED BY ''`); userCreated = true;
      await q(`GRANT SELECT,INSERT,UPDATE ON \`${f.database}\`.* TO '${username}'@'localhost'`);
      application = await mysql.createConnection({ socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:username,database:f.database });
      await application.query('SET @inventory_numbering_v2_migration=1');
      await assert.rejects(application.query("INSERT INTO products(tenant_id,name,inventory_category,vehicle_brand,fitment_type) VALUES(7,'invalid writer','钥匙壳','','specific')"), /identity is incomplete/);
    });
    await t.test('V2 startup never runs V1 repair, backfill or trigger replacement', async () => {
      writes=0; const before=await inspectInventoryNumberingV2Schema(f.connection);
      await context.ensureInventoryNumberingMysql(); await context.repairInventoryNumberCategoryMismatchMysql();
      await context.initializeInventoryNumberingSchemaMysql(f.connection,{triggerDefiner:'CURRENT_USER'});
      assert.equal(writes,0); assert.deepEqual((await inspectInventoryNumberingV2Schema(f.connection)).trigger_definitions,before.trigger_definitions);
      assert.equal(JSON.stringify(await q('SELECT * FROM inventory_number_categories ORDER BY id')),oldRegistry);
    });
  } finally {
    if(application) await application.end(); if(pool) await pool.end();
    if(userCreated) await q(`DROP USER IF EXISTS '${username}'@'localhost'`);
    await f.cleanup();
  }
});
