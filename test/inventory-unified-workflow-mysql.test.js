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
 const {waitForInventoryDemandJobs}=await import('../src/services/inventory-demand-snapshot.js');
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
  const queue=await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1',demandType:'local_safety'},2);assert.equal(queue.rows.length,1);assert.equal(queue.rows[0].primary_suggested_purchase_qty,0);assert.equal(queue.rows[0].suggestion_reasons[0].submitted_quantity,3,'covered manual request stays traceable without repurchasing');
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
 await t.test('fresh status read after a physical count returns the new stock and removes the old negative demand',async()=>{
  await q("INSERT INTO products(id,tenant_id,name) VALUES(205,2,'Count refresh stock')");
  await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(205,2,205,20,'20501',1)");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(2050,20,'COUNT-REFRESH','awaiting_packaging',UTC_TIMESTAMP())");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(2050,2050,'20501',205,1)");
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,205,'manual_outbound',-1,'posted','LOCAL')");
  invalidateOrderProcurementCoverage();
  const before=(await service.batch([205],2,{fresh:true}))[0];assert.equal(before.physical_recorded,-1);assert.equal(before.supply_plan.required_fbs,1);
  const ledger=await legacy.procurementLedgerMysql({product_id:205},2);
  await legacy.applyProcurementLedgerMysql({product_id:205,action_type:'stocktake',revision:ledger.revision,counted_quantity:5,reason_code:'other',reason_note:'盘点确认5件，验证外侧刷新',request_key:randomUUID()},2,2);
  const after=(await service.batch([205],2,{fresh:true}))[0];assert.equal(after.physical_recorded,5);assert.equal(after.free,4);assert.equal(after.supply_plan.required_fbs,0);
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
 await t.test('verified FBP stock shortage can request procurement before a replenishment application; transit coverage prevents duplicate requests',async()=>{
  await q("INSERT INTO products(id,tenant_id,name,production_lead_days,warehouse_logistics_days) VALUES(9202,2,'FBP safety fixture',7,2)");
  await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(9202,2,9202,20,'9920201',1)");
  await q("INSERT INTO ozon_stock_snapshots(shop_id,product_id,ozon_sku,stock_type,warehouse_id,present,available,reserved) VALUES(20,9202,'9920201','fbp_real','1',0,0,0)");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(92020,20,'FBP-SAFETY','delivered',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY))");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(92020,92020,'9920201',9202,14)");
  await q("INSERT INTO ozon_orders_raw(store_id,posting_number,query_stock_location,raw_json) VALUES(20,'FBP-SAFETY','FBP',JSON_OBJECT('delivery_method',JSON_OBJECT('name','FBP')))");
  const ownership=await q("SELECT o.id,o.shop_id,o.posting_number,r.store_id,r.posting_number raw_post,r.query_stock_location FROM orders o LEFT JOIN ozon_orders_raw r ON r.store_id=o.shop_id AND r.posting_number=o.posting_number WHERE o.id=92020");
  assert.equal(ownership[0].query_stock_location,'FBP',JSON.stringify(ownership));
  const direct=await (await import('../src/services/inventory-flow.js')).createInventoryFlowService({query:q}).detail(9202,2);
  assert.ok(direct.skus[0]?.fbp_target>0,JSON.stringify(direct));
  const draftCount=Number((await q('SELECT COUNT(*) n FROM fbp_replenishment_orders'))[0].n);
  const warning=(await service.batch([9202],2,{fresh:true}))[0];assert.equal(warning.fbp.known,true);assert.ok(warning.fbp.shortage>0);assert.ok(warning.purchase_quantity>0);
  const posted=await service.submit({...body('fbp_forecast'),product_id:9202},session);assert.equal(posted.ok,true);
  assert.equal(Number((await q('SELECT COUNT(*) n FROM fbp_replenishment_orders'))[0].n),draftCount);
  const advisoryRequests=await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1',demandType:'fbp_forecast'},2);assert.ok(advisoryRequests.rows.some(r=>Number(r.product_id)===9202));

  assert.equal(Number((await q("SELECT COUNT(*) n FROM inventory_movements WHERE product_id=9202"))[0].n),0);
  await q("INSERT INTO fbp_replenishment_orders(id,order_no,shop_id,order_date,status,created_by) VALUES(9210,'SAME-SKU-PENDING',20,CURRENT_DATE,'pending_review',1)");
  await q("INSERT INTO fbp_replenishment_order_items(id,order_id,shop_id,product_id,mapping_id,ozon_sku,requested_qty) VALUES(9210,9210,20,9202,9202,'9920201',8)");
  const pending=(await service.batch([9202],2,{fresh:true}))[0];assert.equal(pending.requested,8);assert.equal(pending.purchase_quantity,warning.purchase_quantity,'same-SKU application does not double the forecast');
  const {createFbpSupplyFeedback}=await import('../src/services/fbp-supply-feedback.js');
  const {shanghaiDateKey}=await import('../src/shanghai-time.js');const date=shanghaiDateKey();
  await q('UPDATE fbp_replenishment_orders SET order_date=? WHERE id=9210',[date]);
  await q("INSERT INTO fbp_replenishment_orders(id,order_no,shop_id,order_date,status,created_by) VALUES(9211,'UNSELECTED-DRAFT',20,?,'draft',3)",[date]);
  await q("INSERT INTO fbp_replenishment_order_items(order_id,shop_id,product_id,ozon_sku,requested_qty) VALUES(9211,20,200,'UNSELECTED',99)");
  const operator={personId:3,tenant:{id:2,slug:'a',role:'admin'}},hook=createFbpSupplyFeedback(operator),confirmation={key:randomUUID(),hash:'stable-confirmation-hash'};
  const input={rows:[{shop_id:20,product_id:9202,mapping_id:9202,ozon_sku:'9920201',requested_qty:Number(direct.skus[0].fbp_target)-8}],note:'确认剩余预测'};
  const opts={workflow:true,submit:true,forecastConfirmation:confirmation,afterSubmit:connection=>hook.afterSubmit(connection,input.rows)};
  const parallel=await Promise.all([legacy.createFbpReplenishmentOrdersMysql(input,3,2,opts),legacy.createFbpReplenishmentOrdersMysql(input,3,2,opts)]),confirmed=parallel[0],newId=confirmed.rows[0].id;assert.equal(parallel[1].rows[0].id,newId);assert.equal(parallel.filter(r=>r.duplicate).length,1);assert.notEqual(newId,9210);assert.notEqual(newId,9211);
  assert.equal((await q('SELECT status FROM fbp_replenishment_orders WHERE id=9211'))[0].status,'draft');assert.equal(Number((await q('SELECT requested_qty FROM fbp_replenishment_order_items WHERE order_id=9210'))[0].requested_qty),8);
  const converted=(await service.batch([9202],2,{fresh:true}))[0];assert.equal(converted.supply_plan.optional_fbp,0);assert.ok(converted.supply_plan.required_fbp>0);assert.equal(converted.purchase_quantity,warning.purchase_quantity,'confirmed forecast replaces prediction without adding purchase twice');
  assert.equal((await q('SELECT status FROM procurement_requests WHERE id=?',[posted.id]))[0].status,'cancelled');
  const retry=await legacy.createFbpReplenishmentOrdersMysql(input,3,2,opts);assert.equal(retry.duplicate,true);assert.equal(retry.rows[0].id,newId);
  await assert.rejects(legacy.createFbpReplenishmentOrdersMysql(input,3,2,{...opts,forecastConfirmation:{...confirmation,hash:'changed'}}),{statusCode:409});
  const {createOperationsRoutes}=await import('../src/server/routes/operations.js');
  const routes=createOperationsRoutes({services:{procurementLedger:legacy.inventoryLedgerMysql,createFbpReplenishmentOrders:legacy.createFbpReplenishmentOrdersMysql},readJson:async req=>req.body});
  const payload={product_id:9202,submit:true,forecast_confirmation:true,request_key:randomUUID(),rows:[{shop_id:20,ozon_sku:'9920201',quantity:2}]};
  await assert.rejects(routes['POST /api/inventory-workflow/fbp']({_session:operator,body:{...payload,submit:'true'}}),{statusCode:400});
  const viaApi=await routes['POST /api/inventory-workflow/fbp']({_session:operator,body:payload}),apiRetry=await routes['POST /api/inventory-workflow/fbp']({_session:operator,body:payload});assert.equal(apiRetry.duplicate,true);assert.equal(apiRetry.rows[0].id,viaApi.rows[0].id);
  await q("UPDATE fbp_replenishment_orders SET status='cancelled' WHERE id=9211");
  await q("UPDATE fbp_replenishment_orders SET status='draft' WHERE id=9210");
  await q("INSERT INTO fbp_transfer_records(product_id,mapping_id,shop_id,ozon_sku,quantity,listed_quantity,status,source_type,source_ref) VALUES(9202,9202,20,'9920201',1000,0,'sent','manual','SAFETY-INBOUND')");
  await assert.rejects(service.submit({...body('fbp_forecast'),product_id:9202},session),/在途/);
  await assert.rejects(service.submit({...body('fbp_stock'),product_id:300},session));
 });
 await t.test('notification persistence failure rolls back the request',async()=>{
  const before=Number((await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n);
  const broken=createInventoryWorkflowService({...opts,transaction:run=>withMysqlTransaction(c=>run({query:c.query.bind(c),execute:(sql,args)=>sql.includes('INSERT INTO system_notifications')?Promise.reject(new Error('notice failure')):c.execute(sql,args)}))});
  await assert.rejects(broken.submit(body(),session),/notice failure/);assert.equal(Number((await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n),before);
 });
 await t.test('workspace includes never-stocked physical products but excludes foreign and virtual duplicate parents',async()=>{
  await q("INSERT INTO products(id,tenant_id,name,active) VALUES(9302,2,'Never stocked physical',1),(9303,2,'Virtual parent',1)");
  await q("INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,9303,9302,2)");
  const products=await service.workspaceProducts({},2);
  assert.ok(products.some(p=>Number(p.product_id)===9302));assert.ok(!products.some(p=>[9303,300].includes(Number(p.product_id))));
  assert.deepEqual(await service.workspaceProducts({query:'B private'},2),[]);
  await q("UPDATE products SET inventory_number='9-302' WHERE id=9302");
  assert.deepEqual((await service.workspaceProducts({query:'9-302',searchMode:'inventory_id'},2)).map(p=>Number(p.product_id)),[9302]);
  assert.ok((await service.workspaceProducts({query:'BUNDLE-202',searchMode:'sku'},2)).some(p=>Number(p.product_id)===200),'SKU search expands a virtual bundle to physical inventory');
  assert.deepEqual(await service.workspaceProducts({query:'30001',searchMode:'sku'},2),[]);
  const batches=await service.workspaceBatches([200,300],2);assert.ok(batches.every(b=>Number(b.product_id)===200));
 });
 await t.test('SKU supply feedback resolves physical components and recipe overrides without virtual or foreign purchases',async()=>{
  const {fbpSupplyProductIds}=await import('../src/services/fbp-supply-products.js');
  await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(9303,2,9303,20,'VIRTUAL-SKU',1)");
  assert.deepEqual(await fbpSupplyProductIds(q,[{shop_id:20,ozon_sku:'VIRTUAL-SKU'}],2),[9302]);
  await q("INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active) VALUES(9303,20,'VIRTUAL-SKU',1)");
  await q("INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES(9303,200,2)");
  assert.deepEqual(await fbpSupplyProductIds(q,[{shop_id:20,ozon_sku:'VIRTUAL-SKU'}],2),[200]);
  await q("INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES(9303,300,1)");
  await assert.rejects(fbpSupplyProductIds(q,[{shop_id:20,ozon_sku:'VIRTUAL-SKU'}],2),{statusCode:403});
  await q('DELETE FROM sku_inventory_recipe_items WHERE recipe_id=9303 AND product_id=300');
 });
 await t.test('FBP submission notification failure rolls back the canonical request instead of leaving an unnoticed formal demand',async()=>{
  const before=await q('SELECT id,status,submitted_at,note FROM fbp_replenishment_orders ORDER BY id');
  const items=await q('SELECT id,requested_qty,approved_qty,note FROM fbp_replenishment_order_items ORDER BY id');
  await assert.rejects(legacy.createFbpReplenishmentOrdersMysql({rows:[{shop_id:20,ozon_sku:'20001',product_id:200,mapping_id:200,requested_qty:31}]},7,2,{workflow:true,submit:true,afterSubmit:async()=>{throw Error('FBP notification failure');}}),/FBP notification failure/);
  assert.deepEqual(await q('SELECT id,status,submitted_at,note FROM fbp_replenishment_orders ORDER BY id'),before);
  assert.deepEqual(await q('SELECT id,requested_qty,approved_qty,note FROM fbp_replenishment_order_items ORDER BY id'),items);
 });
 await t.test('existing FBP status submission shares transactional gap feedback and repeated pending status does not notify again',async()=>{
  const {createFbpSupplyFeedback}=await import('../src/services/fbp-supply-feedback.js');
  const draft=await legacy.createFbpReplenishmentOrdersMysql({rows:[{shop_id:20,ozon_sku:'9920201',product_id:9202,mapping_id:9202,requested_qty:15}]},7,2,{workflow:true});
  const id=draft.rows[0].id;
  await assert.rejects(legacy.updateFbpReplenishmentOrderStatusMysql({id,status:'pending_review'},7,2,{afterSubmit:async()=>{throw Error('status notice failure');}}),/status notice failure/);
  assert.equal((await q('SELECT status FROM fbp_replenishment_orders WHERE id=?',[id]))[0].status,'draft');
  const hook=createFbpSupplyFeedback({personId:7,tenant:{id:2,slug:'a'}});
  const before=Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n);
  await legacy.updateFbpReplenishmentOrderStatusMysql({id,status:'pending_review'},7,2,{afterSubmit:hook.afterSubmit});
  assert.ok(hook.committed().notified>=3);
  assert.equal(Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n),before);
  let repeated=0;await legacy.updateFbpReplenishmentOrderStatusMysql({id,status:'pending_review'},7,2,{afterSubmit:async()=>{repeated++;}});assert.equal(repeated,0);
 });
 await t.test('workspace route has A/B isolation, includes never-stocked requirements and keeps nonfinancial sources',async()=>{
  const {createOperationsRoutes}=await import('../src/server/routes/operations.js');
  const routes=createOperationsRoutes({services:{procurementLedger:legacy.inventoryLedgerMysql,batchUpdateInboundRecords:legacy.batchUpdateInboundRecordsMysql,previewInboundReceiptImpact:legacy.previewInboundReceiptImpactMysql,stockAlerts:()=>{throw Error('must not use stocked-only alert base');}},readJson:async req=>req.body});
  const read=routes['GET /api/inventory-workflow/alerts'];
  let a=await read({_session:{personId:2,tenant:{id:2,slug:'a'}}},new URL('http://localhost/api/inventory-workflow/alerts?view=workspace&task=all&pageSize=100'));
  assert.equal(a.snapshot.status,'warming');assert.equal(a.total,null);assert.equal(a.meta.required,null);
  await waitForInventoryDemandJobs();a=await read({_session:{personId:2,tenant:{id:2,slug:'a'}}},new URL('http://localhost/api/inventory-workflow/alerts?view=workspace&task=all&pageSize=100'));
  const compact=await read({_session:{personId:2,tenant:{id:2,slug:'a'}}},new URL('http://localhost/api/inventory-workflow/alerts?view=workspace&task=all&pageSize=100&compact=1'));
  assert.equal(compact.total,a.total);assert.deepEqual(compact.rows.map(r=>r.product_id),a.rows.map(r=>r.product_id));
  for(let i=0;i<compact.rows.length;i++){assert.deepEqual(compact.rows[i].workflow.supply_plan,a.rows[i].workflow.supply_plan);assert.deepEqual(compact.rows[i].pending_batches,a.rows[i].pending_batches);assert.deepEqual(compact.rows[i].workflow.requests,[]);assert.deepEqual(compact.rows[i].feedbacks,[]);}

  assert.ok(a.rows.some(r=>Number(r.product_id)===9302));assert.ok(a.rows.every(r=>Number(r.product_id)!==300));
  assert.ok(a.rows.every(r=>r.amount===undefined&&r.cost===undefined));
  let b=await read({_session:{personId:4,tenant:{id:3,slug:'b'}}},new URL('http://localhost/api/inventory-workflow/alerts?view=workspace&task=all&pageSize=100'));
  await waitForInventoryDemandJobs();b=await read({_session:{personId:4,tenant:{id:3,slug:'b'}}},new URL('http://localhost/api/inventory-workflow/alerts?view=workspace&task=all&pageSize=100'));
  assert.deepEqual(b.rows.map(r=>Number(r.product_id)),[300]);assert.ok(!JSON.stringify(b).includes('A proposer'));
  await q('UPDATE tenant_members SET active=0 WHERE tenant_id=3 AND person_id=4');
  await assert.rejects(read({_session:{personId:4,tenant:{id:3,slug:'b'}}},new URL('http://localhost/api/inventory-workflow/alerts?view=workspace')),{statusCode:403});
  await q('UPDATE tenant_members SET active=1 WHERE tenant_id=3 AND person_id=4');
 });
 await t.test('inventory feedback is scoped, retry-safe, nonfinancial and atomic with an enclosing FBP submission',async()=>{
  const {createInventorySupplyFeedback}=await import('../src/services/inventory-supply-feedback.js');
  const buyer={personId:2,tenant:{id:2,slug:'a',role:'member'}},events=[];
  const feedback=createInventorySupplyFeedback({broadcast:(...args)=>events.push(args),readState:async()=>({incoming:4,supply_plan:{known:true,required_fbs:2,required_fbp:3,required_purchase:5,optional_purchase:1}})});
  const input={product_id:200,request_key:randomUUID(),note:'核实仓库缺少5件，请联动处理'};
  const movements=Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n),requests=Number((await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n);
  const result=await feedback(input,buyer);assert.equal(result.notified,3);assert.equal((await feedback(input,buyer)).duplicate,true);
  const notices=await q("SELECT tenant_id,recipient_person_id,content FROM system_notifications WHERE entity_type='inventory' AND entity_id='200' AND dedupe_key LIKE ?",['%'+input.request_key+'%']);
  assert.equal(notices.length,3);assert.ok(notices.every(n=>Number(n.tenant_id)===2&&[2,3,7].includes(Number(n.recipient_person_id))));
  await assert.rejects(feedback({...input,note:'changed'},buyer),{statusCode:409});
  await assert.rejects(feedback({...input,request_key:randomUUID(),product_id:300},buyer),{statusCode:404});
  await assert.rejects(feedback({...input,request_key:randomUUID(),product_id:9303},buyer),{statusCode:409});
  await assert.rejects(feedback({...input,request_key:randomUUID()},session),{statusCode:403});
  assert.equal(Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n),movements);
  assert.equal(Number((await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n),requests,'feedback updates the shared queue; it is not a duplicate purchase quantity');
  const before=Number((await q("SELECT COUNT(*) n FROM system_notifications WHERE entity_type='inventory'"))[0].n);
  await assert.rejects(withMysqlTransaction(async c=>{await feedback({...input,request_key:randomUUID()},buyer,{connection:c});throw Error('outer FBP failure');}),/outer FBP failure/);
  assert.equal(Number((await q("SELECT COUNT(*) n FROM system_notifications WHERE entity_type='inventory'"))[0].n),before);
  await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
  await assert.rejects(feedback({...input,request_key:randomUUID()},buyer),{statusCode:403});
  await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
 });
 await t.test('workspace shares coverage without changing quantities and invalidates after stock writes',async()=>{
  const ids=(await q('SELECT id FROM products WHERE tenant_id=2')).map(r=>Number(r.id));let scans=0;
  const {mysqlQuery}=await import('../src/mysql-pool.js');
  const tracked=async(sql,args)=>{if(sql.includes('SELECT o.id AS order_id'))scans++;return mysqlQuery(sql,args);};
  const fast=createInventoryWorkflowService({...opts,query:tracked});
  const expected=await service.batch(ids,2,{fresh:true,cache:false});
  const actual=await fast.workspaceStates(ids,2);const quantities=rows=>rows.map(({calculated_at,...row})=>row);assert.deepEqual(quantities(actual),quantities(expected));assert.equal(scans,1);
  await fast.workspaceStates(ids,2);assert.equal(scans,1);
  invalidateOrderProcurementCoverage();await fast.workspaceStates(ids,2);assert.equal(scans,2);
 });
 await t.test('bulk FBP mapping and warehouse totals match canonical per-product detail',async()=>{
  const {loadProductFbpStocks,loadProductsFbpStockDetails}=await import('../src/services/fbp-inventory-display.js');
  const {resolveInventoryTenantScope}=await import('../src/services/inventory-tenant-scope.js');
  const scope=await resolveInventoryTenantScope(2,q),ids=(await q('SELECT id FROM products WHERE tenant_id=2')).map(r=>Number(r.id));
  const bulk=await loadProductsFbpStockDetails(q,ids,scope);
  const normalize=v=>({...v,rows:v.rows.map(({inventory_product_id,...r})=>r).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
  for(const id of ids)assert.deepEqual(normalize(bulk.get(id)),normalize(await loadProductFbpStocks(q,id,scope)),`inventory ${id}`);
 });
 await t.test('681-product queue with 5000 orders reads history once and reuses the whole snapshot',async()=>{
  const {mysqlQuery}=await import('../src/mysql-pool.js');
  const insert=async(table,columns,rows)=>{for(let i=0;i<rows.length;i+=500){const part=rows.slice(i,i+500);await q(`INSERT INTO ${table}(${columns}) VALUES ${part.map(r=>'('+r.map(()=>'?').join(',')+')').join(',')}`,part.flat());}};
  const ids=Array.from({length:681},(_,i)=>20000+i);
  await insert('products','id,tenant_id,name',ids.map(id=>[id,2,'load stock '+id]));
  await insert('sku_mappings','id,tenant_id,product_id,shop_id,ozon_sku,active',ids.map(id=>[id,2,id,20,'LOAD-'+id,1]));
  await insert('inventory_movements','tenant_id,product_id,source_type,quantity_delta,status,stock_location',ids.map(id=>[2,id,'initial_stock',20,'posted','LOCAL']));
  const orders=Array.from({length:5000},(_,i)=>[20000+i,20,'LOAD-ORDER-'+i,i%3?'awaiting_packaging':'delivered','2026-10-20 00:00:00']);
  await insert('orders','id,shop_id,posting_number,status,ordered_at',orders);
  await insert('order_items','id,order_id,ozon_sku,sku_mapping_id,quantity',orders.map((r,i)=>[r[0],r[0],'LOAD-'+ids[i%ids.length],ids[i%ids.length],i%3+1]));
  let scans=0,queries=0;const query=async(sql,args)=>{queries++;if(sql.includes('SELECT o.id AS order_id'))scans++;return mysqlQuery(sql,args);};
  const fast=createInventoryWorkflowService({...opts,query});const start=performance.now();const rows=await fast.workspaceStates(ids,2);const elapsed=Math.round(performance.now()-start),before=queries;
  assert.equal(rows.length,681);assert.equal(scans,1);assert.equal(await fast.workspaceStates(ids,2),rows);assert.equal(queries,before);
  const expected=await service.batch(ids.slice(0,10),2,{fresh:true,cache:false});const quantities=values=>values.map(({calculated_at,...row})=>row);
  assert.deepEqual(quantities(rows.slice(0,10)),quantities(expected));
  t.diagnostic(`isolated 681 products / 5000 orders: cold ${elapsed}ms, ${before} queries, cached 0 queries`);
 });
 await t.test('demand snapshot persists numeric results across service restart and does not persist personnel details',async()=>{
  const first=await service.workspaceSnapshot(2,{fresh:true});assert.ok(first.snapshot.refreshing);await waitForInventoryDemandJobs();
  const [stored]=await q('SELECT payload_json FROM inventory_demand_snapshots WHERE tenant_id=?',[2]);
  assert.ok(stored);assert.ok(!stored.payload_json.includes('A proposer'));assert.ok(!stored.payload_json.includes('applicant_name'));
  const restarted=createInventoryWorkflowService(opts),state=await restarted.workspaceSnapshot(2);
  assert.equal(state.snapshot.available,true);assert.equal(state.snapshot.status,'updating');
  const ids=state.rows.slice(0,3).map(r=>Number(r.product_id)),expected=await service.batch(ids,2,{fresh:true,cache:false});
  for(const original of expected){const current=state.rows.find(r=>r.product_id===original.product_id);for(const key of ['physical','free','purchase_quantity','supply_plan'])assert.deepEqual(current[key],original[key]);}
  await waitForInventoryDemandJobs();
 });
 await t.test('cached workspace stays readable across repeated invalidations without waiting for history',async()=>{
  const {createOperationsRoutes}=await import('../src/server/routes/operations.js');
  const routes=createOperationsRoutes({services:{procurementLedger:legacy.inventoryLedgerMysql,batchUpdateInboundRecords:legacy.batchUpdateInboundRecordsMysql,previewInboundReceiptImpact:legacy.previewInboundReceiptImpactMysql},readJson:async()=>({})}),read=routes['GET /api/inventory-workflow/alerts'];
  const req={_session:{personId:2,tenant:{id:2,slug:'a'}}},url=new URL('http://localhost/api/inventory-workflow/alerts?view=workspace&task=required&pageSize=20');
  await waitForInventoryDemandJobs();await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=1');
  const start=performance.now();let response;
  for(let i=0;i<5;i++){invalidateOrderProcurementCoverage();response=await read(req,url);assert.equal(response.snapshot.available,true);assert.ok(response.rows.length);assert.ok(!JSON.stringify(response).includes('A proposer'));}
  t.diagnostic(`five snapshot API reads under invalidation: ${Math.round(performance.now()-start)}ms; ${response.rows.length} visible rows`);
  await waitForInventoryDemandJobs();await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=1');
 });
 await t.test('dedicated snapshot migration defaults to read-only and creates only the cache table idempotently',async()=>{
  await waitForInventoryDemandJobs();const {initializeInventoryDemandSnapshot}=await import('../scripts/init-inventory-demand-snapshot.mjs');
  const before=Number((await q('SELECT COUNT(*) n FROM orders'))[0].n);
  await q('DROP TABLE inventory_demand_snapshots');
  assert.deepEqual(await initializeInventoryDemandSnapshot(f.connection),{create_required:true,applied:false});
  const applied=await initializeInventoryDemandSnapshot(f.connection,{apply:true});assert.equal(applied.applied,true);assert.equal(applied.tenant_primary_key_verified,true);
  await q("INSERT INTO inventory_demand_snapshots(tenant_id,version,payload_json,calculated_at) VALUES(2,'test','{}',UTC_TIMESTAMP())");
  assert.equal((await initializeInventoryDemandSnapshot(f.connection,{apply:true})).applied,false);
  assert.equal((await q('SELECT version FROM inventory_demand_snapshots WHERE tenant_id=2'))[0].version,'test');
  assert.equal(Number((await q('SELECT COUNT(*) n FROM orders'))[0].n),before);
 });
 }finally{await waitForInventoryDemandJobs();await closeMysqlPool();await f.cleanup();}
});
