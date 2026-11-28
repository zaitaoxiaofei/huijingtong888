import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('real FBS-first allocation, approved FBP demand, shipment protection and component posting remain atomic',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET,timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('fbs_fbp_priority');f.useEnvironment();const q=f.query;
 const api=await import('../src/services/mysql-cutover.js');
 const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const {invalidateOrderProcurementCoverage}=await import('../src/services/mysql-order-procurement-coverage.js');
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'Proposer','packing'),(2,'Buyer','procurement'),(3,'Other enterprise','procurement')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('packing'),1),(2,2,'member',JSON_ARRAY('procurement'),1),(3,3,'member',JSON_ARRAY('procurement'),1)");
  await api.prepareInventoryFlowMysql();
  await api.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  await q('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A shop','active'),(30,3,'Other shop','active')");
  await q("INSERT INTO products(id,tenant_id,name,production_lead_days,warehouse_logistics_days) VALUES(200,2,'Actual stock',7,2),(201,2,'Virtual bundle',7,2),(300,3,'Foreign',7,2)");
  await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,201,200,1)');
  await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(200,2,200,20,'SKU-A',1),(201,2,201,20,'SKU-B',1),(300,3,300,30,'PRIVATE',1)");
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,200,'opening_stock',17,'posted','LOCAL'),(3,300,'opening_stock',100,'posted','LOCAL')");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(2000,20,'FBS-REAL','awaiting_packaging',UTC_TIMESTAMP())");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(2000,2000,'SKU-A',200,4)");
  await q("INSERT INTO fbp_replenishment_orders(id,order_no,shop_id,order_date,status,created_by) VALUES(79,'FBP-79',20,CURRENT_DATE,'approved',1),(83,'FBP-83',20,CURRENT_DATE,'approved',1)");
  await q("INSERT INTO fbp_replenishment_order_items(id,order_id,shop_id,product_id,mapping_id,ozon_sku,requested_qty,approved_qty) VALUES(501,79,20,201,201,'SKU-B',12,10),(558,83,20,200,200,'SKU-A',5,5)");
  await q("INSERT INTO inventory_flow_settings(tenant_id,product_id,settings_json) VALUES(2,200,JSON_OBJECT('local_safety_override',9))");
  const workflow=createInventoryWorkflowService(),state=()=>workflow.batch([200],2,{fresh:true,cache:false});
  const stock=async()=>Number((await q("SELECT SUM(quantity_delta) n FROM inventory_movements WHERE product_id=200 AND status='posted' AND stock_location='LOCAL'"))[0].n);
  const counts=async()=>[(await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n,(await q('SELECT COUNT(*) n FROM fbp_transfer_records'))[0].n];
  await t.test('approved requests show 15 actual demand and FBS gets 4 before the FBP 2-unit gap',async()=>{
   const [s]=await state();assert.equal(s.order_demand,4);assert.equal(s.supply_plan.required_fbs,0);assert.equal(s.supply_plan.required_fbp,2);assert.equal(s.supply_plan.formal_fbp_quantity,15);assert.equal(s.supply_plan.fbp_ready_stock,13);assert.equal(s.supply_plan.optional_local,9);assert.equal(s.supply_plan.fbp_in_transit_quantity,0);
   const sources=await workflow.workspaceSources([200],2);const bundle=sources.applications.find(a=>Number(a.item_id)===501);assert.equal(Number(bundle.sku_requested_quantity),12);assert.equal(Number(bundle.sku_final_quantity),10);
  });
  await t.test('direct physical dispatch cannot consume the four FBS units and rolls back all records',async()=>{
   const before=await counts();await assert.rejects(api.createFbpTransferRecordMysql({product_id:200,mapping_id:200,shop_id:20,ozon_sku:'SKU-A',quantity:15,status:'sent'},2,2),/须优先保障FBS 4 件，可发仓 13 件/);assert.deepEqual(await counts(),before);assert.equal(await stock(),17);
  });
  await t.test('confirmed bundle dispatch posts physical child consumption, and the next FBP shipment cannot take remaining FBS stock',async()=>{
   await assert.rejects(api.updateFbpReplenishmentOrderStatusMysql({id:79,status:'sent'},2,2), /未填写快递单号/);
   await api.updateFbpReplenishmentOrderStatusMysql({id:79,action:'save_tracking',express_tracking_number:'  SF123456  '},2,2);
   const saved=(await api.fbpReplenishmentOrdersMysql({orderId:79},2)).rows[0];
   assert.equal(saved.status,'approved');
   assert.equal(saved.express_tracking_number,'SF123456');
   assert.ok(saved.express_tracking_recorded_at);
   assert.equal(saved.shipment_confirmed_at,'');
   assert.equal(await stock(),17);
   await api.updateFbpReplenishmentOrderStatusMysql({id:79,status:'sent'},2,2);
   assert.equal(await stock(),7);
   const shipment=(await api.fbpReplenishmentOrdersMysql({orderId:79},2)).rows[0];
   assert.equal(shipment.express_tracking_number,'SF123456');
   assert.ok(shipment.shipment_confirmed_at);
   assert.deepEqual(shipment.express_tracking_recorded_at,saved.express_tracking_recorded_at);
   const sent=await q("SELECT product_id,quantity_delta FROM inventory_movements WHERE source_type='fbp_transfer_outbound'");assert.deepEqual(sent.map(r=>[Number(r.product_id),Number(r.quantity_delta)]),[[200,-10]]);
   const before=await counts();await assert.rejects(api.updateFbpReplenishmentOrderStatusMysql({id:83,status:'sent',confirm_without_tracking:true},2,2),/可发仓 3 件/);assert.deepEqual(await counts(),before);assert.equal((await q('SELECT status FROM fbp_replenishment_orders WHERE id=83'))[0].status,'approved');
   invalidateOrderProcurementCoverage();const [s]=await state();assert.equal(s.supply_plan.required_fbs,0);assert.equal(s.supply_plan.formal_fbp_quantity,5);assert.equal(s.supply_plan.required_fbp,2);assert.equal(s.supply_plan.fbp_in_transit_quantity,10);
   await api.updateFbpReplenishmentOrderStatusMysql({id:79,status:'sent',confirm_without_tracking:true},2,2);
   assert.deepEqual(await counts(),before);
   const retried=(await api.fbpReplenishmentOrdersMysql({orderId:79},2)).rows[0];
   assert.equal(retried.express_tracking_number,shipment.express_tracking_number);
   assert.deepEqual(retried.shipment_confirmed_at,shipment.shipment_confirmed_at);
  });
  await t.test('concurrent bundles in different shops cannot both spend the same child stock',async()=>{
   await q("INSERT INTO products(id,tenant_id,name) VALUES(202,2,'Another virtual bundle')");
   await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,202,200,1)');
   await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(21,2,'A second shop','active')");
   await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(202,2,202,21,'SKU-C',1)");
   await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,200,'opening_stock',10,'posted','LOCAL')");
   const outcomes=await Promise.allSettled([
    api.createFbpTransferRecordMysql({product_id:201,mapping_id:201,shop_id:20,ozon_sku:'SKU-B',quantity:10,status:'sent'},2,2),
    api.createFbpTransferRecordMysql({product_id:202,mapping_id:202,shop_id:21,ozon_sku:'SKU-C',quantity:10,status:'sent'},2,2)
   ]);
   assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(await stock(),7);
   const denied=outcomes.find(r=>r.status==='rejected').reason;assert.ok(denied.statusCode===409||denied.code==='ER_LOCK_DEADLOCK',denied.message);
  });
  await t.test('finished kits ship as kits and only the loose remainder consumes child inventory',async()=>{
   await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,201,'bundle_assembly',3,'posted','LOCAL')");
   const childBefore=await stock();
   const result=await api.createFbpTransferRecordMysql({product_id:201,mapping_id:201,shop_id:20,ozon_sku:'SKU-B',quantity:5,status:'sent'},2,2);
   assert.equal(await stock(),childBefore-2);
   const rows=await q("SELECT product_id,quantity_delta,stock_location_source FROM inventory_movements WHERE source_type='fbp_transfer_outbound' AND source_ref LIKE ? ORDER BY product_id",[`fbp_transfer:${result.id}:outbound%`]);
   assert.deepEqual(rows.map(r=>[Number(r.product_id),Number(r.quantity_delta),r.stock_location_source]),[[200,-2,'fbp_transfer'],[201,-3,'bundle_finished']]);
  });
  await t.test('a different enterprise cannot ship this product',async()=>{await assert.rejects(api.createFbpTransferRecordMysql({product_id:200,quantity:1,status:'sent'},3,3),{statusCode:404});});
 }finally{await closeMysqlPool();await f.cleanup();}
});
