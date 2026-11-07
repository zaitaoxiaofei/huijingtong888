import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('historical shipment evidence pins recipes consistently across narrow and bulk inventory reads',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated local MySQL'
},async()=>{
 const fixture=await createTenantMysqlFixture('history_scope');fixture.useEnvironment();
 const q=fixture.query;
 const {prepareInventoryFlowMysql,financeInventoryCapitalDetailsMysql}=await import('../src/services/mysql-cutover.js');
 const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const {ensureProcurementLedgerSchema}=await import('../src/services/procurement-ledger.js');
 const {mysqlExecute}=await import('../src/mysql-pool.js');
 try{
  await q("INSERT INTO tenants(id,slug,name,status) VALUES(2,'history-a','History A','active')");
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'History shop','active')");
  await prepareInventoryFlowMysql();await ensureProcurementLedgerSchema(mysqlExecute);
  await q("INSERT INTO products(id,tenant_id,name,code,inventory_category,purchase_cost,production_lead_days,warehouse_logistics_days) VALUES(200,2,'Part A','PART-A','Test',10,7,2),(201,2,'Part B','PART-B','Test',10,7,2),(202,2,'Bundle','BUNDLE','Test',20,7,2)");
  await q("INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,202,200,1),(2,202,201,1)");
  await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(20,2,20,202,'BUNDLE-SKU',1)");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at,delivered_at) VALUES(20,20,'bundle-history','delivered','delivered',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 DAY),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY))");
  await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(20,20,20,'BUNDLE-SKU',1,100)");
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status) VALUES(2,200,'initial_stock',10,'LOCAL','posted'),(2,201,'initial_stock',10,'LOCAL','posted')");
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status,related_order_item_id) VALUES(2,200,'order_outbound',-1,'LOCAL','posted',20)");
  const workflow=createInventoryWorkflowService();
  const [single]=await workflow.batch([201],2,{localOnly:true,fresh:true,cache:false});
  const bulk=await workflow.batch([200,201],2,{localOnly:true,fresh:true,cache:false});
  const same=bulk.find(row=>row.product_id===201);
  assert.equal(single.safety_target,0,'Frozen physical evidence must not invent consumption of an unrecorded current component');
  assert.equal(same.safety_target,single.safety_target,'Reading a recorded sibling must not change the historical evidence boundary');
  assert.equal(same.free,single.free,'Available quantity must not depend on selected product scope');
  const detail=await financeInventoryCapitalDetailsMysql({kind:'local'},2);
  const capital=detail.rows.find(row=>row.product_id===201);
  assert.equal(capital.quantity,single.free);assert.equal(capital.inventory_value,single.free*10);
  const aSingle=(await workflow.batch([200],2,{localOnly:true,fresh:true,cache:false}))[0];
  const aBulk=bulk.find(row=>row.product_id===200);assert.equal(aSingle.free,aBulk.free);
  await q("INSERT INTO tenants(id,slug,name,status) VALUES(3,'history-b','History B','active')");
  await q("INSERT INTO products(id,tenant_id,name,purchase_cost) VALUES(300,3,'Foreign evidence',10)");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at,delivered_at) VALUES(21,20,'without-owned-evidence','delivered','delivered',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 DAY),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY))");
  await q("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(21,21,20,'BUNDLE-SKU',1,100)");
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,stock_location,status,related_order_item_id) VALUES(3,300,'order_outbound',-1,'LOCAL','posted',21)");
  const [owned]=await workflow.batch([201],2,{localOnly:true,fresh:true,cache:false});
  assert.ok(owned.safety_target>0,'Foreign-tenant evidence must not suppress current-enterprise historical consumption');
  assert.equal(owned.safety_target,(await workflow.batch([200,201],2,{localOnly:true,fresh:true,cache:false})).find(row=>row.product_id===201).safety_target);

 }finally{await closeMysqlPool();await fixture.cleanup();}
});
