import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('committed physical stocktake emits only its owned inventory for incremental demand reconciliation',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:90000},async()=>{
 const f=await createTenantMysqlFixture('incremental_db');f.useEnvironment();const q=f.query;
 const legacy=await import('../src/services/mysql-cutover.js'),{closeMysqlPool}=await import('../src/mysql-pool.js');
 const {workflowRevision,inventoryWorkflowChanges}=await import('../src/services/inventory-workflow-cache.js');
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'A operator','operations')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('operations'),1)");
  await legacy.prepareInventoryFlowMysql();await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  await q("INSERT INTO products(id,tenant_id,name) VALUES(200,2,'A stock'),(201,2,'Untouched A'),(300,3,'B private')");
  const before=await legacy.procurementLedgerMysql({product_id:200,include_fbp:false},2),epoch=workflowRevision();
  await legacy.applyInventoryStocktakeMysql({action_type:'stocktake',stocktake_type:'physical',product_id:200,revision:before.revision,counted_quantity:7,reason_code:'other',reason_note:'独立测试核实实物',request_key:randomUUID()},1,2);
  assert.deepEqual(inventoryWorkflowChanges(epoch,2),[200]);assert.deepEqual(inventoryWorkflowChanges(epoch,3),[]);
  const after=await legacy.procurementLedgerMysql({product_id:200,include_fbp:false},2);assert.equal(after.physical_estimate,7);
  const nextEpoch=workflowRevision();await assert.rejects(legacy.applyInventoryStocktakeMysql({action_type:'stocktake',stocktake_type:'physical',product_id:300,counted_quantity:8,request_key:randomUUID()},1,2));assert.equal(workflowRevision(),nextEpoch,'failed foreign writes must not publish dirty inventory');
 }finally{await closeMysqlPool();await f.cleanup();}
});
