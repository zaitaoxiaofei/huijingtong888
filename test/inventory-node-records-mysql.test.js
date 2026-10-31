import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('node records, approval purchase, receipt markers and order notes preserve tenant and stock boundaries',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET,timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('node_records');f.useEnvironment();const q=f.query;
 const api=await import('../src/services/mysql-cutover.js');
 const {createInventoryNodeRecords}=await import('../src/services/inventory-node-records.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const service=createInventoryNodeRecords({ledger:api.inventoryLedgerMysql,confirmTransfer:api.confirmFbpTransferReceivedMysql});
 const session=(personId,role='procurement')=>({personId,roles:[role],tenant:{id:2,slug:'a',role:'member'}});
 const buyer=session(2),warehouse=session(3,'packing'),operator=session(4,'operations');
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(2,'Buyer','procurement'),(3,'Warehouse','packing'),(4,'Operator','operations'),(5,'Foreign','procurement'),(6,'Tech only','technical')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,2,'member',JSON_ARRAY('procurement')),(2,3,'member',JSON_ARRAY('packing')),(2,4,'member',JSON_ARRAY('operations')),(3,5,'member',JSON_ARRAY('procurement')),(2,6,'member',JSON_ARRAY('technical'))");
  await api.prepareInventoryFlowMysql();
  await api.procurementRequestsMysql({paged:'1',grouped:'1',compact:'1'},2);
  await q('CREATE TABLE inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A shop','active'),(30,3,'B shop','active')");
  await q("INSERT INTO products(id,tenant_id,name) VALUES(200,2,'A stock'),(300,3,'B stock')");
  await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(200,2,200,20,'20001',1),(300,3,300,30,'30001',1)");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(2000,20,'A-order','awaiting_packaging',UTC_TIMESTAMP()),(3000,30,'B-order','awaiting_packaging',UTC_TIMESTAMP())");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,ozon_name,ozon_image_url,quantity) VALUES(2000,2000,'20001',200,'A order product','https://example.invalid/a.jpg',1),(3000,3000,'30001',300,'B order product',NULL,1)");
  await q("INSERT INTO procurement_requests(id,tenant_id,product_id,created_by_person_id,quantity,status) VALUES(1,2,200,4,5,'submitted'),(2,2,200,4,7,'submitted'),(3,3,300,5,99,'submitted')");
  let inboundId;
  await t.test('approval uses canonical real purchase registration and links only selected request',async()=>{
   await api.confirmProcurementRequestsPurchasedMysql({request_ids:[1],person_id:2,items:[{product_id:200,quantity:5,actual_quantity:5,amount:50}]},2,2,null,{session:buyer});
   const [request]=await q('SELECT status,purchase_order_id FROM procurement_requests WHERE id=1');assert.equal(request.status,'purchased');assert.ok(request.purchase_order_id);
   assert.equal((await q('SELECT status FROM procurement_requests WHERE id=2'))[0].status,'submitted');
   const rows=await service.records({node:'purchase-confirm',product_id:200},buyer);assert.equal(rows.rows.length,1);assert.equal(Number(rows.rows[0].amount),50);assert.equal(rows.rows[0].requests[0].applicant_name,'Operator');
   inboundId=Number(rows.rows[0].id);
  });
  await t.test('warehouse cannot read money, but sees batch metadata',async()=>{
   const r=await service.records({node:'incoming',product_id:200},warehouse);assert.equal(r.rows.length,1);assert.equal(r.financial,false);assert.equal(r.rows[0].amount,undefined);assert.equal(r.rows[0].shipping_amount,undefined);
   await assert.rejects(service.records({node:'incoming',product_id:300},buyer),{statusCode:404});
  });
  await t.test('48h warns; 72h enters inspection queue without changing status or physical ledger',async()=>{
   await q('UPDATE purchase_orders SET purchased_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 73 HOUR) WHERE id=(SELECT purchase_order_id FROM inbound_records WHERE id=?)',[inboundId]);
   const summary=await api.inventoryLedgerMysql({product_id:200,include_flow:'local'},2);assert.equal(Number(summary.flow_summary.purchases[0].unarrived_quantity),5);
   const r=await service.records({node:'receiving',product_id:200},warehouse);assert.equal(r.rows.length,1);assert.equal(r.rows[0].overdue,true);assert.equal(r.rows[0].status,'pending_arrival');
   assert.equal((await q("SELECT COUNT(*) n FROM inventory_movements WHERE product_id=200"))[0].n,0);
   await q("UPDATE procurement_requests SET created_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 25 HOUR) WHERE id IN (2,3)");
   const {generateOperationalNotifications}=await import('../src/services/system-notifications.js');
   await generateOperationalNotifications(2);await generateOperationalNotifications(2);
   const notes=await q("SELECT recipient_person_id,content FROM system_notifications WHERE notification_type='procurement_timeout' AND tenant_id=2");
   assert.equal(notes.length,1,'daily timeout reminders deduplicate');assert.equal(Number(notes[0].recipient_person_id),2);assert.match(notes[0].content,/1条申请.*1批采购/);

  });
  await t.test('daily checks and arrival are audited without creating stock; duplicate arrival is idempotent',async()=>{
   await service.mutate({action:'transit-check',product_id:200,id:inboundId},buyer);
   assert.ok((await service.records({node:'incoming',product_id:200},buyer)).rows[0].checked_at);
   await service.mutate({action:'arrived',product_id:200,id:inboundId},buyer);
   assert.equal((await service.mutate({action:'arrived',product_id:200,id:inboundId},buyer)).duplicate,true);
   const [r]=await q('SELECT status,quantity,received_at FROM inbound_records WHERE id=?',[inboundId]);assert.equal(r.status,'pending_arrival');assert.equal(Number(r.quantity),5);assert.ok(r.received_at);
   assert.equal((await q('SELECT COUNT(*) n FROM inventory_movements WHERE product_id=200'))[0].n,0);
   await assert.rejects(service.mutate({action:'arrived',product_id:200,id:inboundId},operator),{statusCode:403});
  });
  await t.test('rejection requires reason, excludes already purchased, preserves applicant and audit',async()=>{
   await assert.rejects(service.mutate({action:'reject',product_id:200,id:2},buyer),/拒绝原因/);
   await service.mutate({action:'reject',product_id:200,id:2,note:'重复采购'},buyer);
   const r=(await service.records({node:'requests',product_id:200},buyer)).rows.find(r=>Number(r.id)===2);assert.equal(r.approval_status,'rejected');assert.match(r.note,/重复采购/);assert.equal(r.applicant_name,'Operator');
   await assert.rejects(service.mutate({action:'reject',product_id:200,id:1,note:'改变需求'},buyer),{statusCode:409});
   await assert.rejects(service.mutate({action:'reject',product_id:200,id:3,note:'越权'},buyer),{statusCode:404});
  });
  await t.test('FBS detail returns image, shop and persisted marks; concurrent edits conflict',async()=>{
   let r=await service.records({node:'orders',product_id:200},warehouse);assert.equal(r.rows.length,1);assert.equal(r.rows[0].shop_name,'A shop');assert.equal(r.rows[0].image_url,'https://example.invalid/a.jpg');
   await service.mutate({action:'order-note',product_id:200,id:2000,note:'暂缓发货，待运营确认',expected_note:''},operator);
   await assert.rejects(service.mutate({action:'order-note',product_id:200,id:2000,note:'旧备注覆盖',expected_note:''},buyer),{statusCode:409});
   r=await service.records({node:'orders',product_id:200},warehouse);assert.equal(r.rows[0].mark_type,'follow');assert.match(r.rows[0].mark_note,/暂缓发货/);assert.equal(r.rows[0].sale_price,undefined);
   await assert.rejects(service.mutate({action:'order-note',product_id:200,id:3000,note:'越权',expected_note:''},operator),{statusCode:404});
  });
  await t.test('one-day cycles use product settings, reject stale revision and retain enterprise defaults',async()=>{
   const {inventoryFlow}=await import('../src/services/inventory-flow.js');
   const initial=await service.records({node:'safety',product_id:200},operator);assert.equal(initial.revision,0);
   await inventoryFlow.saveSettings({product_id:200,revision:0,settings:{production_days:1,local_days:2,fbp_days:7}},2,4);
   const saved=await service.records({node:'safety',product_id:200},operator);assert.equal((await api.inventoryLedgerMysql({product_id:200,include_flow:'local'},2)).flow_summary.production_days,1);assert.equal(saved.settings.production_days,1);assert.equal(saved.revision,1);
   await assert.rejects(inventoryFlow.saveSettings({product_id:200,revision:0,settings:{production_days:3}},2,4),{statusCode:409});
   assert.equal((await inventoryFlow.settings(3)).production_days,null);
  });
  await t.test('history filter happens before paging and cancelled batches are not called received',async()=>{
   await q("INSERT INTO procurement_requests(tenant_id,product_id,created_by_person_id,quantity,status,created_at) VALUES(2,200,4,1,'cancelled',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 4 MONTH))");
   const recent=await service.records({node:'requests',product_id:200},buyer),all=await service.records({node:'requests',product_id:200,all:'1'},buyer);
   assert.equal(all.total,recent.total+1);
   await assert.rejects(service.records({node:'requests',product_id:200,page:'Infinity'},buyer),/页码/);
   const [po]=await q('SELECT purchase_order_id FROM inbound_records WHERE id=?',[inboundId]);
   await q("INSERT INTO inbound_records(tenant_id,product_id,purchase_order_id,quantity,status) VALUES(2,200,?,10,'cancelled')",[po.purchase_order_id]);
   assert.equal((await service.records({node:'purchase-confirm',product_id:200},buyer)).rows.length,1);
  });
  await t.test('FBP receipt review is read-only, stock-change evidence needs manual per-SKU confirmation and cannot cross enterprises',async()=>{
   await q("INSERT INTO ozon_stock_snapshots(shop_id,product_id,ozon_sku,warehouse_id,warehouse_name,stock_type,present,available,reserved,synced_at) VALUES(20,200,'20001','FBP','FBP','fbp_real',32,32,0,'2026-10-01 00:00:00')");
   const sent=await api.createFbpTransferRecordMysql({product_id:200,mapping_id:200,shop_id:20,ozon_sku:'20001',quantity:30,status:'sent',shipped_at:'2026-10-01 01:00:00',expected_arrival_at:'2026-10-06 01:00:00'},2,2);
   const id=Number(sent.id);
   assert.ok(id);
   const before=await q('SELECT COUNT(*) AS n FROM inventory_movements');
   await q("UPDATE ozon_stock_snapshots SET present=62,available=62,synced_at='2026-10-06 00:00:00' WHERE shop_id=20 AND ozon_sku='20001'");
   let result=await service.records({node:'fbp-receipts',product_id:200},warehouse);
   const statements=[];const summaryService=createInventoryNodeRecords({query:(sql,args)=>{statements.push(sql);return q(sql,args);}});
   const counts=await summaryService.records({node:'fbp-receipts',product_id:200,summary_only:'1'},warehouse);
   assert.equal(counts.total,result.total);assert.ok(counts.pending_quantity>=30);
   assert.equal(statements.some(sql=>sql.includes('FROM inventory_flow_events')),false);
   await assert.rejects(summaryService.records({node:'fbp-receipts',product_id:300,summary_only:'1'},warehouse),{statusCode:404});
   let row=result.rows.find(r=>Number(r.id)===id);assert.equal(row.suspected,true);assert.equal(row.remaining,30);assert.equal(row.baseline_present,32);assert.equal(row.inferred_arrival,30);
   assert.deepEqual(await q('SELECT COUNT(*) AS n FROM inventory_movements'),before);
   await assert.rejects(service.records({node:'fbp-receipts',product_id:300},warehouse),{statusCode:404});
   await assert.rejects(service.mutate({action:'fbp-receive',product_id:200,id,received_quantity:10,expected_listed_quantity:0},session(6,'technical')),{statusCode:403});
   await service.mutate({action:'fbp-receive',product_id:200,id,received_quantity:10,expected_listed_quantity:0,confirm_all:true,note:'物流凭证已核实'},warehouse);
   await assert.rejects(service.mutate({action:'fbp-receive',product_id:200,id,received_quantity:10,expected_listed_quantity:0},warehouse),/入仓数量已更新/);
   row=(await service.records({node:'fbp-receipts',product_id:200},warehouse)).rows.find(r=>Number(r.id)===id);assert.equal(row.remaining,20);assert.equal(Number(row.listed_quantity),10);
   const events=await q("SELECT person_id FROM inventory_flow_events WHERE action='fbp_receipt_confirm'");assert.equal(Number(events.at(-1).person_id),3);
   await service.mutate({action:'fbp-arrival-time',product_id:200,id,at:'2026-10-06T12:00:00+08:00',expected_updated_at:row.updated_at,expected_arrival_at:row.arrival_at,note:'核对签收'},warehouse);
   row=(await service.records({node:'fbp-receipts',product_id:200},warehouse)).rows.find(r=>Number(r.id)===id);assert.equal(row.arrival_at,'2026-10-06T04:00:00.000Z');
   assert.equal((await q("SELECT present FROM ozon_stock_snapshots WHERE shop_id=20 AND ozon_sku='20001'"))[0].present,62,'manual confirmation never rewrites official stock');
  });
  await t.test('composition preview returns owned child identity and quantity only, and flags missing children',async()=>{
   await q("INSERT INTO products(id,tenant_id,name,inventory_number,is_accessory) VALUES(201,2,'A accessory','99-1',1)");
   await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,200,201,2),(2,200,300,1)');
   const result=await service.records({node:'composition',product_id:200},warehouse);
   assert.equal(result.product.component_count,2);assert.equal(result.rows.length,1);assert.equal(result.rows[0].name,'A accessory');assert.equal(result.rows[0].inventory_number,'99-1');assert.equal(Number(result.rows[0].quantity),2);assert.equal(result.incomplete,true);assert.equal(result.rows[0].purchase_cost,undefined);
   assert.match(result.rows[0].image_url,/products\/201\/image/);
   await assert.rejects(service.records({node:'composition',product_id:300},warehouse),{statusCode:404});
  });
  await t.test('physical component detail can review a related kit SKU transfer once',async()=>{
   await q("INSERT INTO products(id,tenant_id,name) VALUES(202,2,'A kit')");
   await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,202,201,2)');
   await q("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,active) VALUES(202,2,20,202,'KIT-SKU',1)");
   await q("INSERT INTO fbp_transfer_records(id,product_id,shop_id,ozon_sku,quantity,listed_quantity,status,shipped_at) VALUES(202,202,20,'KIT-SKU',5,0,'sent',UTC_TIMESTAMP())");
   const result=await service.records({node:'fbp-receipts',product_id:201},warehouse);
   assert.equal(result.rows.filter(r=>Number(r.id)===202).length,1);assert.equal(result.rows.find(r=>Number(r.id)===202).remaining,5);
  });
  await t.test('revoked membership is rejected even with an old privileged session',async()=>{
   await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=4');
   await assert.rejects(service.records({node:'orders',product_id:200},operator),{statusCode:403});
   await assert.rejects(service.mutate({action:'order-note',product_id:200,id:2000,note:'revoked',expected_note:''},operator),{statusCode:403});
  });
 }finally{await closeMysqlPool();await f.cleanup();}
});
