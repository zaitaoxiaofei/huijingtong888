import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { migrateInventoryFlowCenter } from '../scripts/migrate-inventory-flow-center.mjs';
import { migrationNeedsApply } from '../scripts/lib/release-database-plan.mjs';

test('flow migration is planned before backup and applied before candidate activation',()=>{
  const source=fs.readFileSync('deploy/linux/remote-release.sh','utf8');
  assert.match(source,/for membership_schema in[^\n]*migrate-inventory-flow-center\.mjs/);
  const plan=source.indexOf('\nplan_database_changes\n'),backup=source.indexOf('\n  backup_database\n',plan),apply=source.indexOf('for membership_schema in',backup),candidate=source.lastIndexOf('\nstart_candidate\n');
  assert.ok(plan<backup&&backup<apply&&apply<candidate);
  assert.equal(migrationNeedsApply('migrate-inventory-flow-center.mjs',{mode:'dry-run',changes_database:false,ready:false,missing_tables:['inventory_flow_events'],problems:[]}),true);
  assert.throws(()=>migrationNeedsApply('migrate-inventory-flow-center.mjs',{mode:'dry-run',ready:false,missing_tables:[],problems:['unsafe']}));
});
test('read-only missing-table inspection, additive apply, idempotence and refusal of incompatible existing schema',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:120000
},async()=>{
  const f=await createTenantMysqlFixture('flow_migration');
  try{
    await f.query("INSERT INTO products(id,tenant_id,name) VALUES (99,1,'preserve old inventory')");
    for(const table of ['inventory_flow_settings','inventory_flow_tasks','inventory_flow_events'])await f.query('DROP TABLE '+table);
    const before=await migrateInventoryFlowCenter(f.connection);assert.equal(before.mode,'dry-run');assert.equal(before.missing_tables.length,3);
    assert.equal((await f.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'inventory_flow_%'"))[0].n,0);
    const applied=await migrateInventoryFlowCenter(f.connection,{apply:true});assert.equal(applied.ready,true);assert.equal(applied.changes_database,true);
    assert.equal((await f.query('SELECT name FROM products WHERE id=99'))[0].name,'preserve old inventory');
    assert.equal((await migrateInventoryFlowCenter(f.connection,{apply:true})).changes_database,false);
    await f.query('CREATE UNIQUE INDEX unsafe_global_request ON inventory_flow_tasks(request_key)');
    const incompatible=await migrateInventoryFlowCenter(f.connection);assert.match(incompatible.problems.join(','),/unscoped-unique/);
    await assert.rejects(migrateInventoryFlowCenter(f.connection,{apply:true}),/incompatible/);
    await f.query('DROP INDEX unsafe_global_request ON inventory_flow_tasks');
    await f.query('ALTER TABLE inventory_flow_tasks MODIFY request_key VARCHAR(32) NOT NULL');
    assert.match((await migrateInventoryFlowCenter(f.connection)).problems.join(','),/column:request_key/);
    await assert.rejects(migrateInventoryFlowCenter(f.connection,{apply:true}),/incompatible/);
  }finally{await f.cleanup();}
});
