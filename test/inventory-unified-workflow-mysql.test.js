import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('unified workflow preserves scoped inventory, typed requests, idempotency and notification atomicity',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('unified_flow');f.useEnvironment();const q=f.query;
 const legacy=await import('../src/services/mysql-cutover.js');
 const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
 const {closeMysqlPool,withMysqlTransaction}=await import('../src/mysql-pool.js');
 const {invalidateOrderProcurementCoverage}=await import('../src/services/mysql-order-procurement-coverage.js');
 const events=[];
 const opts={ledger:legacy.inventoryLedgerMysql,receiveRecords:legacy.batchUpdateInboundRecordsMysql,previewReceipts:legacy.previewInboundReceiptImpactMysql,broadcast:(...e)=>events.push(e),forecast:async()=>({skus:[]})};
 const service=createInventoryWorkflowService(opts);
 const session={personId:1,roles:['analytics'],tenant:{id:2,slug:'a',role:'member'}};
 const body=(type='local_safety')=>({product_id:200,demand_type:type,quantity:3,note:'备货核对',request_key:randomUUID()});
 try{
 await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
 await q("INSERT INTO people(id,name,role) VALUES(1,'A proposer','analytics'),(2,'A buyer','procurement'),(3,'A admin','operations'),(4,'B buyer','procurement'),(5,'Platform only','admin')");
 await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('analytics'),1),(2,2,'member',JSON_ARRAY('procurement'),1),(2,3,'admin',JSON_ARRAY('operations'),1),(3,4,'admin',JSON_ARRAY('procurement'),1)");
 await legacy.prepareInventoryFlowMysql();
 await q('CREATE TABLE inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
 await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
 await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A shop','active'),(30,3,'B private','active')");
 await q("INSERT INTO products(id,tenant_id,name,production_lead_days,warehouse_logistics_days) VALUES(200,2,'A stock',7,2),(300,3,'B private',7,2)");
 await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(200,2,200,20,'20001',1),(300,3,300,30,'30001',1)");
 await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,200,'purchase_inbound',200,'posted','LOCAL'),(3,300,'purchase_inbound',999,'posted','LOCAL')");
 await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(2000,20,'A-ORDER','awaiting_packaging',UTC_TIMESTAMP()),(3000,30,'B-PRIVATE','awaiting_packaging',UTC_TIMESTAMP())");
 await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(2000,2000,'20001',200,10),(3000,3000,'30001',300,999)");
 await t.test('batch and detail use the same physical allocation, refusing another enterprise',async()=>{
  const full=await service.read(200,2,{fresh:true}),light=(await service.batch([200],2,{fresh:true}))[0];
  for(const key of ['physical','order_demand','safety','locked','free','purchase_quantity'])assert.equal(light[key],full[key],key);
  assert.equal(full.physical,200);assert.equal(full.order_demand,10);assert.equal(full.free,190);
  await assert.rejects(service.batch([300],2),{statusCode:404});await assert.rejects(service.read(300,2),{statusCode:404});
 });
 await t.test('lightweight metadata never reads ledgers or forecasts, and local quantities match full detail without allocation queries',async()=>{
  const metadata=await createInventoryWorkflowService({...opts,ledger:()=>{throw Error('Unexpected ledger');},forecast:()=>{throw Error('Unexpected forecast');}}).requests(200,2);
  assert.equal(metadata.product_id,200);assert.ok(Array.isArray(metadata.requests));assert.equal(metadata.amount,undefined);
  const sql=[];const query=async(statement,args=[])=>{sql.push(statement);return q(statement,args);};
  const local=(await createInventoryWorkflowService({...opts,query}).batch([200],2,{fresh:true,localOnly:true}))[0];
  const full=await service.read(200,2,{fresh:true});for(const key of ['physical','order_demand','safety','locked','free'])assert.equal(local[key],full[key],key);
  assert.ok(!sql.some(statement=>statement.includes('FROM procurement_order_allocations')));
  assert.ok(!sql.some(statement=>statement.includes('FROM procurement_history_sources')));
  await assert.rejects(service.requests(300,2),{statusCode:404});
 });
 await t.test('any active member may propose, retry creates one request and scoped notifications, no physical change',async()=>{
  const input=body();const results=await Promise.all([service.submit(input,session),service.submit(input,session)]);
  assert.equal(results[0].id,results[1].id);assert.equal(results.filter(r=>r.duplicate).length,1);
  const notices=await q('SELECT recipient_person_id,tenant_id FROM system_notifications');assert.deepEqual(notices.map(r=>Number(r.recipient_person_id)).sort(),[2,3]);assert.ok(notices.every(r=>Number(r.tenant_id)===2));
  const rows=await q('SELECT request_reason_code,source_order_item_id FROM procurement_requests');assert.equal(rows.length,1);assert.equal(rows[0].request_reason_code,'flow_local_safety');assert.equal(rows[0].source_order_item_id,null);
  assert.equal(Number((await q('SELECT SUM(quantity_delta) n FROM inventory_movements WHERE tenant_id=2'))[0].n),200);
  await assert.rejects(service.submit({...input,quantity:4},session),{statusCode:409});
  const queue=await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1',demandType:'local_safety'},2);assert.equal(queue.rows.length,1);assert.equal(queue.rows[0].primary_suggested_purchase_qty,3);
 });
 await t.test('FBP opportunity requires a submitted application, never a draft',async()=>{
  await assert.rejects(service.submit(body('fbp_stock'),session),/先提交FBP/);
  await q("INSERT INTO fbp_replenishment_orders(id,order_no,shop_id,order_date,status,created_by) VALUES(20,'A-FBP',20,'2026-10-29','draft',1)");
  await q("INSERT INTO fbp_replenishment_order_items(id,order_id,shop_id,product_id,mapping_id,ozon_sku,requested_qty) VALUES(20,20,20,200,200,'20001',200)");
  await assert.rejects(service.submit(body('fbp_stock'),session),/先提交FBP/);
  await q("UPDATE fbp_replenishment_orders SET status='pending_review' WHERE id=20");invalidateOrderProcurementCoverage();
  const state=(await service.batch([200],2,{fresh:true}))[0];assert.equal(state.requested,200);assert.equal(state.demands[2].purchase_quantity,10);
  assert.equal((await service.submit(body('fbp_stock'),session)).ok,true);
 });
 await t.test('foreign references and stale membership cannot submit or expose receipts',async()=>{
  await assert.rejects(service.submit({...body(),product_id:300},session));
  await assert.rejects(service.submit({...body('real_order'),order_id:3000},session));
  await assert.rejects(service.submit(body(),{...session,personId:5}),{statusCode:403});
  await assert.rejects(service.receipts(200,session),{statusCode:403});
  await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=1');await assert.rejects(service.submit(body(),session),{statusCode:403});await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=1');
 });
 await t.test('warehouse receives only passed actual pieces; remainder stays pending and stale retries cannot double count',async()=>{
  await q("INSERT INTO people(id,name,role) VALUES(6,'A warehouse','packing')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,6,'member',JSON_ARRAY('packing'),1)");
  await q("INSERT INTO products(id,tenant_id,name) VALUES(201,2,'Arrival stock')");
  await legacy.recordProcurementPurchaseMysql({items:[{product_id:201,quantity:10,amount:100}]},2,2);
  const warehouse={personId:6,roles:['packing'],tenant:{id:2,slug:'a',role:'member'}};
  const pending=await service.receipts(201,warehouse);assert.equal(pending.length,1);assert.equal(pending[0].amount,undefined);
  const payload={product_id:201,request_key:randomUUID(),records:[{id:pending[0].id,quantity:6,expected_quantity:10,reason:'验货不合格'}]};
  await service.receive(payload,warehouse);
  const stock=()=>q("SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_movements WHERE tenant_id=2 AND product_id=201 AND status='posted'");
  assert.equal(Number((await stock())[0].n),6);
  const remaining=await service.receipts(201,warehouse);assert.equal(remaining.length,1);assert.equal(Number(remaining[0].quantity),4);
  await assert.rejects(service.receive(payload,warehouse));assert.equal(Number((await stock())[0].n),6);
  await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('analytics') WHERE tenant_id=2 AND person_id=6");
  await assert.rejects(service.receive({...payload,records:[{id:remaining[0].id,quantity:4,expected_quantity:4}]},warehouse),{statusCode:403});
  assert.equal(Number((await stock())[0].n),6);
  await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=6");
  const before=await legacy.procurementLedgerMysql({product_id:201},2);
  await legacy.applyProcurementLedgerMysql({action_type:'stocktake',product_id:201,counted_quantity:8,reason_code:'other',reason_note:'Local receipt test count',revision:before.revision,request_key:randomUUID()},2,2);
  const finalPayload={product_id:201,request_key:randomUUID(),records:[{id:remaining[0].id,quantity:4,expected_quantity:4}]};
  await assert.rejects(service.receive(finalPayload,warehouse),/当前实际在仓总数/);
  await service.receive({...finalPayload,counted_quantity:12},warehouse);
  assert.equal((await legacy.inventoryLedgerMysql({product_id:201},2)).physical_estimate,12,'Actual counted total wins without double adding historical receipts');
 });
 await t.test('operations can save and submit canonical FBP drafts without acquiring procurement or reserving physical stock',async()=>{
  await q("INSERT INTO people(id,name,role) VALUES(7,'A operations','operations')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,7,'member',JSON_ARRAY('operations'),1)");
  const rows=[{shop_id:20,product_id:200,mapping_id:200,ozon_sku:'20001',requested_qty:25}];
  await assert.rejects(legacy.createFbpReplenishmentOrdersMysql({rows},7,2),{statusCode:403});
  const draft=await legacy.createFbpReplenishmentOrdersMysql({rows},7,2,{workflow:true});
  assert.equal((await q('SELECT status FROM fbp_replenishment_orders WHERE id=?',[draft.rows[0].id]))[0].status,'draft');
  const sent=await legacy.createFbpReplenishmentOrdersMysql({rows},7,2,{workflow:true,submit:true});
  assert.equal((await q('SELECT status FROM fbp_replenishment_orders WHERE id=?',[sent.rows[0].id]))[0].status,'pending_review');
  const state=(await service.batch([200],2,{fresh:true}))[0];assert.equal(state.locked,0);assert.equal(state.physical,200);
 });
 await t.test('bundle SKU detail explains child inventory and lean list availability uses the same physical-unit policy',async()=>{
  await q("INSERT INTO products(id,tenant_id,name,inventory_number) VALUES(202,2,'Bundle of two stocks','2-202')");
  await q("INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,202,200,2)");
  await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(202,2,202,20,'BUNDLE-202',1)");
  invalidateOrderProcurementCoverage();
  const detail=await service.skuDetails(200,20,'BUNDLE-202',2);assert.equal(detail.source,'bundle');assert.equal(detail.root.id,202);assert.equal(detail.components[0].product_id,200);assert.equal(detail.components[0].quantity,2);assert.equal(detail.components[0].current,true);
  const direct=await service.skuDetails(200,20,'20001',2);assert.equal(direct.source,'direct');
  await assert.rejects(service.skuDetails(200,30,'30001',2),{statusCode:404});
  const view=await legacy.productsMysql({view:'inventory',paged:'1',pageSize:20},2);
  const state=await service.read(200,2,{fresh:true});assert.equal(view.rows.find(row=>Number(row.id)===200).workflow_free,state.free);
  assert.equal(view.rows.find(row=>Number(row.id)===202).workflow_free,Math.floor(state.free/2));
 });
 await t.test('lean local safety keeps frozen historic components and the seven complete Beijing days',async()=>{
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at,delivered_at) VALUES(2040,20,'HIST-RECENT','delivered',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 DAY),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 DAY)),(2041,20,'HIST-OLD','delivered',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 25 DAY),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 24 DAY))");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(2040,2040,'BUNDLE-202',202,7),(2041,2041,'20001',200,50)");
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location,related_order_item_id) VALUES(2,200,'order_outbound',-14,'posted','LOCAL',2040),(2,200,'order_outbound',-50,'posted','LOCAL',2041)");
  await q('UPDATE product_components SET quantity=3 WHERE product_id=202 AND component_product_id=200');invalidateOrderProcurementCoverage();
  const full=await service.read(200,2,{fresh:true}),local=(await service.batch([200],2,{fresh:true,localOnly:true}))[0];
  for(const key of ['physical','order_demand','safety','locked','free'])assert.equal(local[key],full[key],key);
  assert.equal(full.safety,18,'14 actually shipped physical units /7 *9 days, older history excluded');
  assert.equal(local.purchase_quantity,undefined,'quantity-only reading cannot be used as a purchase decision');
 });
 await t.test('notification persistence failure rolls back the request',async()=>{
  const before=Number((await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n);
  const broken=createInventoryWorkflowService({...opts,transaction:run=>withMysqlTransaction(c=>run({query:c.query.bind(c),execute:(sql,args)=>sql.includes('INSERT INTO system_notifications')?Promise.reject(new Error('notice failure')):c.execute(sql,args)}))});
  await assert.rejects(broken.submit(body(),session),/notice failure/);assert.equal(Number((await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n),before);
 });
 }finally{await closeMysqlPool();await f.cleanup();}
});
