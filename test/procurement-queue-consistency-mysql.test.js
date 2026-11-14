import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';

test('required workspace and order queue share nested physical demand, selection stock and cancelled shortages across tenants',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated MySQL',timeout:180000
},async()=>{
 const f=await createTenantMysqlFixture('queue_consistency');f.useEnvironment();const q=f.query;
 const api=await import('../src/services/mysql-cutover.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const {loadOrderProcurementCoverage}=await import('../src/services/mysql-order-procurement-coverage.js');
 const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await api.prepareInventoryFlowMysql();
  await q('CREATE TABLE inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await api.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A shop','active'),(30,3,'B shop','active')");
  await q("INSERT INTO products(id,tenant_id,name,product_type,inventory_number) VALUES(200,2,'Root','main','1-1-1'),(201,2,'Middle','main','1-1-2'),(202,2,'Physical leaf','selection',NULL),(203,2,'Stock selection','selection','11-1-4'),(204,2,'Unused draft','selection',NULL),(205,3,'Foreign stock','main','3-1-1')");
  await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,200,201,2),(2,201,202,3)');
  await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(200,2,200,20,'NESTED',1),(203,2,203,20,'SELECTION',1),(205,3,205,30,'FOREIGN',1)");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(11,20,'NESTED-ORDER','awaiting_packaging',UTC_TIMESTAMP()),(12,20,'SELECTION-ORDER','awaiting_packaging',UTC_TIMESTAMP()),(13,30,'FOREIGN-ORDER','awaiting_packaging',UTC_TIMESTAMP())");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(11,11,'NESTED',200,1),(12,12,'SELECTION',203,1),(13,13,'FOREIGN',205,1)");
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,202,'initial_stock',2,'posted','LOCAL')");
  await q("INSERT INTO inbound_records(tenant_id,product_id,quantity,amount,status) VALUES(2,202,2,20,'pending_arrival')");
  const event={operation:'cancel',cause:'supplier_out_of_stock',note:'Waiting for alternative handling',sources:[{order_item_id:12,order_id:12,quantity:1}]};
  await q("INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(2,203,1,'procurement_demand_cancellation',?)",[JSON.stringify(event)]);
  const full=await loadOrderProcurementCoverage(q,'',{tenantId:2,fresh:true});
  assert.equal(full.get(11).items[0].product_id,202);assert.equal(full.get(11).items[0].quantity,6);
  assert.equal(full.get(11).shortage_quantity,2);assert.equal(full.get(11).incoming_quantity,2);
  assert.equal(full.get(12).shortage_quantity,1);assert.equal(full.get(12).cancelled_purchase_quantity,1);assert.equal(full.get(12).actionable_shortage_quantity,0);
  const compact=await loadOrderProcurementCoverage(q,'',{tenantId:2,fresh:true,queuesOnly:true});
  assert.deepEqual(compact.queue_ids.pending_purchase,[11],'handled cancellation is excluded before queue compaction');
  assert.equal(full.has(13),false);
  const small=await loadOrderProcurementCoverage(q,'',{tenantId:2,productId:202,fresh:true});
  assert.equal(small.get(11).shortage_quantity,full.get(11).shortage_quantity,'leaf scoped read includes every ancestor root');
  const service=createInventoryWorkflowService({query:q});
  const products=await service.workspaceProducts({},2),ids=products.map(p=>p.product_id);
  assert.ok(ids.includes(203),'stock selection with real obligations must be shown');
  assert.ok(ids.includes(202));assert.ok(!ids.includes(200)&&!ids.includes(201),'virtual parents never create another purchase');
  assert.ok(!ids.includes(204)&&!ids.includes(205),'unused drafts and foreign stock stay excluded');
  const states=await service.workspaceStates(ids,2,{fresh:true});
  const page=inventoryWorkspacePage(products.map(p=>({...p,workflow:states.find(s=>s.product_id===p.product_id)})),{task:'required'});
  assert.deepEqual(page.rows.map(p=>p.product_id).sort(),[202]);
  const leaf=states.find(s=>s.product_id===202),cancelled=states.find(s=>s.product_id===203);
  assert.equal(leaf.supply_plan.required_fbs,full.get(11).shortage_quantity);
  assert.equal(cancelled.supply_plan.cancelled_fbs,1);assert.equal(cancelled.supply_plan.required_purchase,0);
  const detailService=createInventoryWorkflowService({query:q,forecast:async()=>({skus:[]}),ledger:async params=>params.view==='fbp'
   ? {fbp_inventory:{rows:[],incomplete:false},applications:[],transfers:[]}
   : {physical_estimate:0,open_order_demand:1,current_shortage:1,current_incoming:0,incoming_quantity:0,fbp_reserved:0,flow_summary:{safety:0},orders:full.get(12).items.map(i=>({...i,needs_fulfillment:true}))}});
  const detail=await detailService.read(203,2,{fresh:true});
  assert.equal(detail.supply_plan.cancelled_fbs,1,'detail and list apply the same cancellation decisions');
  assert.equal(detail.supply_plan.required_purchase,0);
  // A registered purchase covers current obligations without erasing the cancellation audit.
  await q("INSERT INTO inbound_records(tenant_id,product_id,quantity,amount,status) VALUES(2,202,2,20,'pending_arrival')");
  const covered=await loadOrderProcurementCoverage(q,'',{tenantId:2,productId:202,fresh:true});
  assert.equal(covered.get(11).shortage_quantity,0);assert.equal(covered.get(11).incoming_quantity,4);
 }finally{await closeMysqlPool();await f.cleanup();}
});
