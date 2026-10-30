import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {readFile} from 'node:fs/promises';

test('procurement detail, manual safety, three-source requests and arrival tracking are scoped and accurate',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('demand_detail');f.useEnvironment();const q=f.query;
 const legacy=await import('../src/services/mysql-cutover.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const {createProcurementDemandDetails}=await import('../src/services/procurement-demand-details.js');
 const {createProcurementArrivals}=await import('../src/services/procurement-arrivals.js');
 const {createProcurementDemandRequest}=await import('../src/services/procurement-demand-request.js');
 const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
 const details=createProcurementDemandDetails(),arrivals=createProcurementArrivals(),request=createProcurementDemandRequest({broadcast:()=>{}});
 const buyer={personId:2,tenant:{id:2,slug:'a',role:'member'}},warehouse={personId:1,tenant:{id:2,slug:'a',role:'member'}},foreign={personId:4,tenant:{id:3,slug:'b',role:'member'}};
 try{
 await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
 await q("INSERT INTO people(id,name,role) VALUES(1,'A warehouse','packing'),(2,'A buyer','procurement'),(3,'A operator','operations'),(4,'B buyer','procurement')");
 await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('packing'),1),(2,2,'member',JSON_ARRAY('procurement'),1),(2,3,'member',JSON_ARRAY('operations'),1),(3,4,'member',JSON_ARRAY('procurement'),1)");
 await legacy.prepareInventoryFlowMysql();
 await q('CREATE TABLE inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
 await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
 await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A shop','active'),(30,3,'B shop','active')");
 await q("INSERT INTO products(id,tenant_id,name,production_lead_days,warehouse_logistics_days,owner_person_id,product_type,selection_status) VALUES(200,2,'A stock',7,2,2,'main','draft'),(202,2,'Arrival stock',7,2,2,'main','draft'),(203,2,'Editable inventory',7,2,2,'main','draft'),(300,3,'B private',7,2,4,'main','listed')");
 await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(200,2,200,20,'SKU200',1),(300,3,300,30,'SKU300',1)");
 await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,200,'initial_stock',4,'posted','LOCAL'),(3,300,'initial_stock',999,'posted','LOCAL')");
 await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at,delivered_at) VALUES(2000,20,'A-OPEN','awaiting_packaging',UTC_TIMESTAMP(),NULL),(2001,20,'A-OLD','delivered',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY))");
 await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity,ozon_name,ozon_image_url) VALUES(2000,2000,'SKU200',200,10,'A ordered product','https://example.com/a.jpg'),(2001,2001,'SKU200',200,7,'A ordered product','https://example.com/a.jpg')");
 await q("INSERT INTO order_marks(order_id,mark_type,note) VALUES(2000,'quality_check','A manual note')");
 await q("INSERT INTO ozon_orders_raw(store_id,posting_number,raw_json,query_stock_location) VALUES(20,'A-OPEN',?, 'LOCAL')",[JSON.stringify({delivery_method:{name:'CEL Extra Small Economy'}})]);
 await q("INSERT INTO fbp_replenishment_orders(id,shop_id,order_no,status,created_by,submitted_at) VALUES(200,20,'FBP-A','pending_review',3,UTC_TIMESTAMP())");
 await q("INSERT INTO fbp_replenishment_order_items(order_id,shop_id,product_id,mapping_id,ozon_sku,requested_qty,requested_by) VALUES(200,20,200,200,'SKU200',5,3)");
 await t.test('demand drawer exposes actual orders, channel, notes and submitted SKU applicants without cross-tenant data',async()=>{
  const d=await details.details(200,buyer);assert.equal(d.orders.length,1);assert.equal(d.orders[0].posting_number,'A-OPEN');assert.equal(d.orders[0].shop_name,'A shop');assert.equal(d.orders[0].manual_note,'A manual note');assert.match(d.orders[0].logistics,/CEL/);assert.equal(d.orders[0].ozon_image_url,'https://example.com/a.jpg');
  assert.equal(d.safety.consumed_7d,7);assert.equal(d.safety.recommended_safety_qty,9);assert.equal(d.state.supply_plan.required_fbs,6);assert.equal(d.state.supply_plan.required_fbp,5);assert.equal(d.applications[0].applicant_name,'A operator');assert.equal(d.applications[0].shop_name,'A shop');
  await assert.rejects(details.details(300,buyer),{statusCode:404});await assert.rejects(details.details(200,foreign),{statusCode:404});
 });
 await t.test('manual safety preserves rules, rejects stale revisions, changes shared planning and can restore automatic recommendation',async()=>{
  const d=await details.details(200,buyer);await details.safety({product_id:200,quantity:5,note:'销量下降',revision:d.safety.revision},buyer);
  const current=await details.details(200,buyer);assert.equal(current.safety.safety_qty,5);assert.equal(current.safety.recommended_safety_qty,9);assert.equal(current.state.safety,5);assert.equal(current.state.supply_plan.required_fbs,6);assert.equal(current.state.supply_plan.required_fbp,5);
  await assert.rejects(details.safety({product_id:200,quantity:6,note:'stale',revision:0},buyer),{statusCode:409});
  await details.safety({product_id:200,quantity:null,note:'',revision:current.safety.revision},buyer);assert.equal((await details.details(200,buyer)).state.safety,9);
  await assert.rejects(details.safety({product_id:300,quantity:1,note:'foreign',revision:0},buyer),{statusCode:404});
 });
 let requestBody;
 await t.test('creating a typed demand writes three real requests once without increasing inventory or duplicating demand quantities',async()=>{
  requestBody={product_id:200,demand_types:['real_order','local_safety','fbp_stock'],cause:'physical_mismatch',note:'盘点仅4件，请按缺口采购',request_key:randomUUID()};
  const count=Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n),result=await request(requestBody,warehouse);
  assert.equal(result.requests.length,3);assert.deepEqual(Object.fromEntries(result.requests.map(r=>[r.type,r.quantity])),{fbp_stock:5,local_safety:9,real_order:6});
  assert.equal((await request(requestBody,warehouse)).duplicate,true);assert.equal(Number((await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n),3);assert.equal(Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n),count);
  await assert.rejects(request({...requestBody,note:'changed'},warehouse),{statusCode:409});
  const repeat=await request({...requestBody,request_key:randomUUID()},warehouse);assert.ok(repeat.requests.every(r=>r.created_quantity===0));assert.equal(Number((await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n),3,'separate reports do not duplicate outstanding requests');
  const state=(await details.details(200,buyer)).state;assert.equal(state.supply_plan.required_fbs,6);assert.equal(state.supply_plan.required_fbp,5);
 });
 await t.test('additional demand only requests the uncovered increment beyond existing open requests',async()=>{
  await q('UPDATE order_items SET quantity=12 WHERE id=2000');
  const r=await request({...requestBody,demand_types:['real_order'],request_key:randomUUID()},warehouse);assert.equal(r.requests[0].quantity,8);assert.equal(r.requests[0].created_quantity,2);assert.equal(r.requests[0].linked_quantity,6);
  const rows=await q("SELECT SUM(quantity) qty FROM procurement_requests WHERE product_id=200 AND request_reason_code='flow_real_order' AND status='submitted'");assert.equal(Number(rows[0].qty),8);
 });
 await t.test('existing purchase supply covers new FBS needs; covered requests cannot be created again',async()=>{
  await legacy.recordProcurementPurchaseMysql({items:[{product_id:200,quantity:10,amount:100}]},2,2);
  assert.equal((await details.details(200,buyer)).state.supply_plan.required_fbs,0);
  const before=Number((await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n);
  await assert.rejects(request({...requestBody,request_key:randomUUID(),demand_types:['fbp_stock','real_order']},warehouse),{statusCode:409});
  assert.equal(Number((await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n),before,'all typed requests roll back together');
  assert.equal((await request(requestBody,warehouse)).duplicate,true,'retry remains idempotent after supply changes');
 });
 await t.test('buyer arrival closes tracking without stock or cost movements; warehouse partial receipt keeps the remainder open',async()=>{
  await legacy.recordProcurementPurchaseMysql({items:[{product_id:202,quantity:10,amount:100}]},2,2);
  const open=await arrivals.list({product_id:202,status:'open'},buyer);assert.equal(open.rows.length,1);const row=open.rows[0];
  const before=Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n);
  await assert.rejects(arrivals.confirm({id:row.id,note:'到货',request_key:randomUUID(),expected_updated_at:row.updated_at},warehouse),{statusCode:403});
  await assert.rejects(arrivals.confirm({id:row.id,note:'到货',request_key:randomUUID(),expected_updated_at:row.updated_at},foreign),{statusCode:404});
  const payload={id:row.id,note:'仓库已签收',request_key:randomUUID(),expected_updated_at:row.updated_at};await arrivals.confirm(payload,buyer);assert.equal((await arrivals.confirm(payload,buyer)).duplicate,true);
  assert.equal(Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n),before);assert.equal((await arrivals.list({product_id:202,status:'open'},buyer)).total,0);assert.equal((await arrivals.list({product_id:202,status:'arrived'},buyer)).total,1);
  const workflow=createInventoryWorkflowService({ledger:legacy.inventoryLedgerMysql,receiveRecords:legacy.batchUpdateInboundRecordsMysql,previewReceipts:legacy.previewInboundReceiptImpactMysql});
  await workflow.receive({product_id:202,request_key:randomUUID(),records:[{id:row.id,quantity:4,expected_quantity:10,reason:'其余尚未验收'}]},warehouse);
  const remaining=await arrivals.list({product_id:202,status:'open'},buyer);assert.equal(remaining.rows.length,1);assert.equal(Number(remaining.rows[0].quantity),6);assert.equal((await arrivals.list({product_id:202,status:'received'},buyer)).rows[0].quantity,4);
 });
 await t.test('multiple purchases stay separate and stale arrival confirmations cannot close changed batches',async()=>{
  await legacy.recordProcurementPurchaseMysql({items:[{product_id:202,quantity:3,amount:30}]},2,2);
  const open=await arrivals.list({product_id:202,status:'open'},buyer);assert.equal(open.total,2);assert.equal(open.rows.reduce((s,r)=>s+Number(r.quantity),0),9);
  const row=open.rows[0];await assert.rejects(arrivals.confirm({id:row.id,note:'stale',request_key:randomUUID(),expected_updated_at:'2000-01-01T00:00:00Z'},buyer),{statusCode:409});
  await legacy.recordProcurementPurchaseMysql({items:[{product_id:300,quantity:2,amount:20}]},4,3);
  assert.ok((await arrivals.list({status:'all'},buyer)).rows.every(r=>Number(r.product_id)!==300));assert.ok((await arrivals.list({status:'all'},foreign)).rows.every(r=>Number(r.product_id)===300));
 });
 await t.test('arrival queues summarize real batches and logistics edits preserve quantity, stock and tenant boundaries',async()=>{
  const listed=await arrivals.list({product_id:202,status:'open'},buyer);assert.equal(listed.summary.open,2);assert.equal(listed.summary.arrived,0);
  const row=listed.rows[0],before=Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n);
  const body={operation:'logistics',id:row.id,courier_company:'测试快递',tracking_number:'TEST-123',expected_updated_at:row.updated_at,expected_courier_company:row.courier_company||'',expected_tracking_number:row.tracking_number||''};
  await assert.rejects(arrivals.confirm(body,warehouse),{statusCode:403});await assert.rejects(arrivals.confirm(body,foreign),{statusCode:404});await arrivals.confirm(body,buyer);assert.equal((await arrivals.confirm(body,buyer)).duplicate,true);
  const changed=(await arrivals.list({product_id:202,status:'open'},buyer)).rows.find(r=>r.id===row.id);assert.equal(changed.tracking_number,'TEST-123');assert.equal(Number(changed.quantity),Number(row.quantity));assert.equal(Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n),before);
  await assert.rejects(arrivals.confirm({...body,tracking_number:'STALE'},buyer),{statusCode:409});
  const summary=await arrivals.list({product_id:202,status:'open',summary_only:'1'},buyer);assert.equal(summary.rows.length,0);assert.equal(summary.summary.open,2);
 });
 await t.test('batch purchase creates multiple real inbound rows atomically, reuses existing demands and is retry-safe',async()=>{
  const payload={workspace_batch:true,request_key:randomUUID(),person_id:2,source_type:'1688',note:'批量采购测试',items:[{product_id:200,quantity:20,actual_quantity:20,amount:200,shipping_amount:0,purchase_mode:'shortage_purchase'},{product_id:203,quantity:3,actual_quantity:3,amount:30,shipping_amount:0,purchase_mode:'shortage_purchase'}]};
  const before=Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n),result=await legacy.recordProcurementPurchaseMysql(payload,2,2);
  assert.ok(result.purchase_order_id);const inbound=await q('SELECT product_id,quantity,status FROM inbound_records WHERE purchase_order_id=?',[result.purchase_order_id]);assert.equal(inbound.length,2);assert.equal(inbound.reduce((n,r)=>n+Number(r.quantity),0),23);assert.ok(inbound.every(r=>r.status==='pending_arrival'));assert.equal(Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n),before);
  const retry=await legacy.recordProcurementPurchaseMysql(payload,2,2);assert.equal(retry.duplicate,true);assert.equal(retry.purchase_order_id,result.purchase_order_id);assert.equal(Number((await q('SELECT COUNT(*) n FROM inbound_records WHERE purchase_order_id=?',[result.purchase_order_id]))[0].n),2);
  await assert.rejects(legacy.recordProcurementPurchaseMysql({...payload,note:'changed'},2,2),{statusCode:409});await assert.rejects(legacy.recordProcurementPurchaseMysql({...payload,request_key:randomUUID()},1,2),{statusCode:403});
  const requests=await q("SELECT id,status,quantity FROM procurement_requests WHERE product_id=200 AND status IN('submitted','pending','suggested')");assert.ok(requests.reduce((n,r)=>n+Number(r.quantity),0)<=2,'existing22 demand units are consumed by actual20 purchase instead of another20 request');
  const count=Number((await q('SELECT COUNT(*) n FROM purchase_orders'))[0].n);await assert.rejects(legacy.recordProcurementPurchaseMysql({...payload,request_key:randomUUID(),items:[payload.items[0],{...payload.items[1],product_id:300}]},2,2));assert.equal(Number((await q('SELECT COUNT(*) n FROM purchase_orders'))[0].n),count);
  const concurrent={...payload,request_key:randomUUID(),items:[payload.items[1]]};const both=await Promise.all([legacy.recordProcurementPurchaseMysql(concurrent,2,2),legacy.recordProcurementPurchaseMysql(concurrent,2,2)]);assert.equal(both[0].purchase_order_id,both[1].purchase_order_id);assert.equal(both.filter(r=>r.duplicate).length,1);
 });
 await t.test('ordinary inventory edits retain selection state; protected selection transitions still fail',async()=>{
  const body={name:'Edited inventory',owner_person_id:2,purchase_cost:0,domestic_shipping:0,handling_fee:0,purchase_quantity:1,package_weight_g:30,length_cm:30,width_cm:20,height_cm:10,stock_unit:'个',exchange_rate:11.3};
  await legacy.updateProductMysql(203,body,2);
  const row=(await q('SELECT name,selection_status,product_type FROM products WHERE id=203'))[0];assert.equal(row.name,'Edited inventory');assert.equal(row.selection_status,'draft');assert.equal(row.product_type,'main');
  await assert.rejects(legacy.updateProductMysql(203,{...body,selection_status:'listed'},2),{statusCode:403});
  const editor=await readFile(new URL('../frontend/admin/components/inventory/ProductCreateEditDialog.vue',import.meta.url),'utf8');assert.match(editor,/if\(isEditMode.value&&!props.inventoryRequest\)\{delete payload.selection_status;delete payload.product_type;\}/);
 });
 await t.test('completed purchases and parent-SKU FBP history remain visible without becoming local locks',async()=>{
  const d=await details.details(202,buyer);assert.ok(d.purchase_history.total>=2);assert.ok(d.purchase_history.rows.some(r=>Number(r.received_quantity)===4));
  const packed=await details.details(202,warehouse);assert.ok(packed.purchase_history.rows.every(r=>r.amount===undefined&&r.unit_cost===undefined));
  await q("INSERT INTO products(id,tenant_id,name,product_type,selection_status) VALUES(220,2,'Bundle','main','listed')");
  await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,220,200,2)');
  await q("INSERT INTO fbp_replenishment_orders(id,shop_id,order_no,status,created_by,submitted_at) VALUES(220,20,'FBP-HISTORY','completed',3,UTC_TIMESTAMP()),(221,20,'FBP-LOCK','approved',3,UTC_TIMESTAMP())");
  await q("INSERT INTO fbp_replenishment_order_items(order_id,shop_id,product_id,ozon_sku,requested_qty,approved_qty,requested_by) VALUES(220,20,220,'BUNDLE',11,11,3),(221,20,220,'BUNDLE',3,3,3)");
  const current=await details.details(200,buyer);assert.equal(Number(current.applications.find(a=>a.order_no==='FBP-HISTORY').requested_quantity),22);assert.equal(current.state.locked,6,'only approved unshipped units lock local stock');
  const {loadFbpReservations}=await import('../src/services/fbp-warehouse.js');assert.equal(Number((await loadFbpReservations(q,[200],{id:2,isDefault:false}))[0].quantity),6);
  await q("INSERT INTO fbp_replenishment_orders(id,shop_id,order_no,status,created_by) VALUES(222,20,'FBP-CHANGED-HISTORY','completed',3),(223,20,'FBP-CHANGED-ACTIVE','approved',3)");
  await q("INSERT INTO fbp_replenishment_order_items(order_id,shop_id,product_id,mapping_id,ozon_sku,requested_qty,approved_qty) VALUES(222,20,220,200,'BUNDLE-OLD',7,7),(223,20,220,200,'BUNDLE-OLD',4,4)");
  const changed=await details.details(200,buyer),historical=changed.applications.find(a=>a.order_no==='FBP-CHANGED-HISTORY');
  assert.equal(historical.binding_status,'changed_or_missing');assert.equal(Number(historical.requested_quantity),14);assert.equal(Number(historical.sku_requested_quantity),7);
  assert.ok(!changed.applications.some(a=>a.order_no==='FBP-CHANGED-ACTIVE'));assert.equal(changed.state.locked,6,'stale active binding never reserves extra stock');
  await assert.rejects(details.details(200,foreign),{statusCode:404});
  const before=current.state.order_demand;const revision=current.safety.revision;
  await details.safety({product_id:200,quantity:null,note:'周期校准',revision,production_days:3,local_shipping_days:1,expected_product_updated_at:current.product.updated_at},buyer);
  const after=await details.details(200,buyer);assert.equal(after.safety.production_days,3);assert.equal(after.safety.local_shipping_days,1);assert.equal(after.safety.local_days,7);assert.equal(after.state.order_demand,before);
  const product=(await q('SELECT production_lead_days,warehouse_logistics_days FROM products WHERE id=200'))[0];assert.equal(product.production_lead_days,3);assert.equal(product.warehouse_logistics_days,1);
  await legacy.updateProductMysql(200,{name:'A stock',owner_person_id:2,production_lead_days:5,warehouse_logistics_days:2},2);
  const edited=await details.details(200,buyer);assert.equal(edited.safety.production_days,5);assert.equal(edited.safety.local_shipping_days,2);assert.equal(edited.safety.safety_override,null);assert.equal(edited.safety.updated_by_name,'','product editor does not attribute a cycle change to the previous override author');
  await assert.rejects(details.safety({product_id:200,quantity:null,note:'过期',revision:edited.safety.revision,production_days:7,local_shipping_days:1,expected_product_updated_at:'2000-01-01T00:00:00Z'},buyer),{statusCode:409});
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(2010,20,'FBP-SCHEMA-ONLY','awaiting_packaging',UTC_TIMESTAMP())");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(2010,2010,'SKU200',200,99)");
  await q("INSERT INTO ozon_orders_raw(store_id,posting_number,raw_json,query_stock_location) VALUES(20,'FBP-SCHEMA-ONLY',?, 'LOCAL')",[JSON.stringify({fulfillment_schema:'FBP'})]);
  const ledger=await legacy.procurementLedgerMysql({product_id:200,include_fbp:false},2);
  assert.equal(ledger.fulfillment_summary.fbp.order_count,1);assert.equal(ledger.fulfillment_summary.fbp.quantity,99);assert.equal(ledger.open_order_demand,before);assert.ok(ledger.orders.every(o=>o.stock_location!=='FBP'));

 });
 await t.test('revoked members cannot inspect, override, create demands or confirm arrival',async()=>{
  await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
  await assert.rejects(details.details(200,buyer),{statusCode:403});await assert.rejects(arrivals.list({},buyer),{statusCode:403});await assert.rejects(details.safety({product_id:200,quantity:1,note:'revoked',revision:2},buyer),{statusCode:403});
 });
 }finally{await closeMysqlPool();await f.cleanup();}
});
