import test from 'node:test';
import assert from 'node:assert/strict';
import {unlink} from 'node:fs/promises';
import {inspectCollationRepair,applyCollationRepair} from '../scripts/repair-inventory-numbering-collation.mjs';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {prepareInventoryNumberingV2Schema,installInventoryNumberingV2Triggers,inventoryNumberTriggerSqlV2} from '../src/services/inventory-numbering-v2.js';
test('V2 creation survives a unicode database with 0900 product columns; old trigger reproduces error 1267',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated local MySQL socket',timeout:120000
},async()=>{
 const f=await createTenantMysqlFixture('inv_collation');const q=async(sql,args=[])=>(await f.connection.query(sql,args))[0];
 try{
  await q(`ALTER DATABASE \`${f.database}\` COLLATE utf8mb4_unicode_ci`);
  await q("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
  await q("INSERT INTO tenants(id,slug,name) VALUES(7,'default','Default')");
  await prepareInventoryNumberingV2Schema(f.connection);await installInventoryNumberingV2Triggers(f.connection);
  await q('UPDATE inventory_numbering_state SET version=2 WHERE id=1');
  for(const event of ['INSERT','UPDATE']){await q('DROP TRIGGER products_inventory_number_'+event.toLowerCase());await q(inventoryNumberTriggerSqlV2(event).replaceAll(' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',''));}
  const seed=async code=>{const r=await q("INSERT INTO products(tenant_id,name,code) VALUES(7,'draft',?)",[code]);return Number(r.insertId);};
  const id=await seed('COLLATION-FAILED');
  const save=product=>q("UPDATE products SET name='Door sill CHERY TIGGO 7L',inventory_category='Door sill',vehicle_brand='CHERY',fitment_type='specific',vehicle_model='TIGGO 7L',vehicle_models_json=JSON_ARRAY('TIGGO 7L') WHERE id=?",[product]);
  await assert.rejects(save(id),error=>error.errno===1267);
  const plan=await inspectCollationRepair(f.connection),backup='/private/tmp/'+f.database+'-triggers.json';
  assert.equal(plan.changed,2);
  await assert.rejects(applyCollationRepair(f.connection,{expectedSha:'outdated',backupFile:backup}),/changed/);
  const repaired=await applyCollationRepair(f.connection,{expectedSha:plan.sha,backupFile:backup});assert.equal(repaired.changed,2);assert.equal(repaired.product_rows_changed,0);await unlink(backup);
  assert.equal((await inspectCollationRepair(f.connection)).changed,0);
  await save(id);let [row]=await q('SELECT inventory_number FROM products WHERE id=?',[id]);assert.match(row.inventory_number,/^\d+-\d+-\d+$/);const original=row.inventory_number;
  await save(id);[row]=await q('SELECT inventory_number FROM products WHERE id=?',[id]);assert.equal(row.inventory_number,original,'ordinary saves retain issued number');
  const another=await seed('COLLATION-FIXED');await save(another);const [next]=await q('SELECT inventory_number FROM products WHERE id=?',[another]);assert.notEqual(next.inventory_number,original);
  await q("UPDATE products SET vehicle_brand='TENET' WHERE id=?",[id]);const [changed]=await q('SELECT inventory_number FROM products WHERE id=?',[id]);assert.notEqual(changed.inventory_number,original);
  const [alias]=await q('SELECT product_id FROM inventory_number_aliases WHERE alias_number=?',[original]);assert.equal(Number(alias.product_id),id,'historical aliases remain intact');
 }finally{await f.cleanup();}
});
