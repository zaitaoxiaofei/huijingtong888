import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('receiving tabs share exact product matching, status, demand type and enterprise boundaries', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET,timeout:180000},async t=>{
 const f=await createTenantMysqlFixture('receiving_search');f.useEnvironment();const q=f.query;const api=await import('../src/services/mysql-cutover.js');const {closeMysqlPool}=await import('../src/mysql-pool.js');
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A shop','active'),(30,3,'B shop','active')");
  await api.prepareInventoryFlowMysql();
  await api.procurementRequestsMysql({paged:'1',grouped:'1',compact:'1'},2);
  await q("INSERT INTO products(id,tenant_id,name,inventory_category,vehicle_brand,vehicle_model,color,material,is_accessory) VALUES(200,2,'黑色 钥匙壳','钥匙壳','TENET','T4','黑色','TPU',0),(201,2,'红色 配件','配件','TENET','T7','红色','金属',1),(300,3,'黑色 钥匙壳','钥匙壳','TENET','T4','黑色','TPU',0)");
  await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(200,2,200,20,'20001',1),(201,2,201,20,'20002',1),(300,3,300,30,'30001',1)");
  await q("INSERT INTO procurement_requests(id,tenant_id,product_id,quantity,amount,status,demand_type,request_reason_code,source_type) VALUES(1,2,200,5,10,'purchased','warehouse_request','flow_real_order','warehouse'),(2,2,200,7,14,'purchased','advance_stock','flow_local_safety','warehouse'),(3,2,201,9,18,'purchased','warehouse_request','flow_fbp_stock','fbp'),(4,3,300,99,999,'purchased','warehouse_request','flow_real_order','warehouse')");
  await q("INSERT INTO inbound_records(id,tenant_id,product_id,procurement_request_id,quantity,amount,status) VALUES(1,2,200,1,5,10,'pending_arrival'),(2,2,200,2,7,14,'pending_arrival'),(3,2,201,3,9,18,'pending_arrival'),(4,3,300,4,99,999,'pending_arrival'),(5,2,200,1,2,4,'approved'),(6,2,201,3,3,6,'approved')");
  const read=(query,tenant=2)=>api.inboundRecordsMysql({paged:'1',pageSize:20,...query},tenant);
  await t.test('pending and received records remain separate with correct totals',async()=>{const pending=await read({status:'pending_arrival'}),approved=await read({status:'approved'});assert.equal(pending.total,3);assert.equal(approved.total,2);assert.ok(pending.rows.every(r=>r.status==='pending_arrival'));assert.ok(approved.rows.every(r=>r.status==='approved'));});
  await t.test('three demand types use request purpose, not whether an FBP application happens to have an order ID',async()=>{for(const [demandType,id] of [['real_order',1],['local_safety',2],['fbp_stock',3]]){const result=await read({status:'pending_arrival',demandType,pageSize:1});assert.equal(result.total,1,demandType);assert.equal(Number(result.rows[0].id),id);}});
  await t.test('exact SKU and structured attributes apply before pagination',async()=>{const result=await read({status:'pending_arrival',searchMode:'sku',query:'20001',color:'黑色',vehicleModel:'T4',material:'TPU',pageSize:1});assert.equal(result.total,2);assert.equal(result.rows.length,1);assert.equal((await read({status:'pending_arrival',searchMode:'sku',query:'2000'})).total,0);assert.equal((await read({status:'approved',inventoryType:'accessory'})).total,1);});
  await t.test('foreign enterprise records cannot be selected by SKU or direct product ID',async()=>{assert.equal((await read({status:'pending_arrival',searchMode:'sku',query:'30001'})).total,0);assert.equal((await read({status:'all',productId:300})).total,0);});
  assert.equal(Number((await q('SELECT SUM(quantity) n FROM inbound_records'))[0].n),125,'Read-only filters never change receipt quantities');
 }finally{await closeMysqlPool();await f.cleanup();}
});
