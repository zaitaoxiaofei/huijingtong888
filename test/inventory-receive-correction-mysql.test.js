import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('pending purchase correction and direct receipt preserve money, stock and enterprise boundaries',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('receive_correction');f.useEnvironment();const q=f.query;
 const legacy=await import('../src/services/mysql-cutover.js');
 const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
 const {createProcurementArrivals}=await import('../src/services/procurement-arrivals.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'Buyer','procurement'),(2,'Warehouse','packing'),(3,'A owner','operations'),(4,'B buyer','procurement')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('procurement'),1),(2,2,'member',JSON_ARRAY('packing'),1),(2,3,'admin',JSON_ARRAY('operations'),1),(3,4,'member',JSON_ARRAY('procurement'),1)");
  await legacy.prepareInventoryFlowMysql();
  await q('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  await q("INSERT INTO products(id,tenant_id,name) VALUES(200,2,'Split stock'),(201,2,'Other line'),(202,2,'Legacy stock'),(203,2,'Receipt stock'),(300,3,'B private')");
  const session=(personId=1,tenant=2)=>({personId,roles:[personId===2?'packing':'procurement'],tenant:{id:tenant,slug:tenant===2?'a':'b',role:'member'}});
  const ledger=id=>legacy.procurementLedgerMysql({product_id:id,include_fbp:false},2);
  const body=(state,id,quantity,amount)=>({product_id:200,inbound_id:id,action_type:'revise_pending_batch',revision:state.revision,quantity,amount,shipping_amount:0,courier_company:'测试快递',tracking_number:'LOCAL-TEST',reason:'核实重复录入，修正采购凭证',request_key:randomUUID()});
  const readBatch=async id=>(await q('SELECT * FROM inbound_records WHERE id=?',[id]))[0];
  const stock=async id=>Number((await q("SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_movements WHERE product_id=? AND status='posted'",[id]))[0].n);
  let split,other,purchaseId;
  await t.test('editing one split batch preserves its sibling, other purchase lines and physical stock',async()=>{
   await legacy.recordProcurementPurchaseMysql({items:[{product_id:200,quantity:10,amount:100},{product_id:201,quantity:5,amount:60}]},1,2);
   const first=(await q('SELECT * FROM inbound_records WHERE product_id=200'))[0];split=Number(first.id);purchaseId=first.purchase_order_id;
   await q('UPDATE inbound_records SET quantity=4,amount=40 WHERE id=?',[split]);
   const inserted=await q("INSERT INTO inbound_records(tenant_id,product_id,person_id,quantity,amount,shipping_amount,unit_cost,status,purchase_order_id,purchase_order_item_id) VALUES(2,200,1,6,60,0,10,'pending_arrival',?,?)",[first.purchase_order_id,first.purchase_order_item_id]);other=Number(inserted.insertId);
   const oldSibling=await readBatch(other),state=await ledger(200),input=body(state,split,3,36);
   const preview=await legacy.previewProcurementLedgerMysql(input,2);assert.equal(preview.local_delta,0);assert.equal(preview.quantity,9);
   await legacy.applyProcurementLedgerMysql(input,1,2);await legacy.applyProcurementLedgerMysql(input,1,2);
   assert.equal(Number((await readBatch(split)).quantity),3);assert.equal(Number((await readBatch(split)).amount),36);
   assert.deepEqual(await readBatch(other),oldSibling);assert.equal(await stock(200),0);
   const item=(await q('SELECT * FROM purchase_order_items WHERE id=?',[first.purchase_order_item_id]))[0];assert.equal(Number(item.actual_quantity),9);assert.equal(Number(item.amount),96);
   const po=(await q('SELECT * FROM purchase_orders WHERE id=?',[purchaseId]))[0];assert.equal(Number(po.total_quantity),14);assert.equal(Number(po.total_amount),156);
   await assert.rejects(legacy.applyProcurementLedgerMysql({...input,request_key:randomUUID()},1,2),/已变化/);
  });
  await t.test('delete cancels only the selected pending batch and keeps an audit trail and the remaining purchase',async()=>{
   const state=await ledger(200);await legacy.applyProcurementLedgerMysql(body(state,split,0,0),1,2);
   assert.equal((await readBatch(split)).status,'cancelled');assert.equal(Number((await readBatch(other)).quantity),6);
   const po=(await q('SELECT total_quantity,total_amount FROM purchase_orders WHERE id=?',[purchaseId]))[0];assert.equal(Number(po.total_quantity),11);assert.equal(Number(po.total_amount),120);
   assert.equal(Number((await q("SELECT COUNT(*) n FROM procurement_ledger_actions WHERE product_id=200 AND action_type='revise_purchase'"))[0].n),2);
   assert.equal(await stock(200),0);
  });
  await t.test('arrival or revoked authority prevents editing; foreign enterprise cannot read or preview',async()=>{
   const state=await ledger(200);await q('UPDATE inbound_records SET received_at=UTC_TIMESTAMP() WHERE id=?',[other]);
   await assert.rejects(legacy.previewProcurementLedgerMysql(body(await ledger(200),other,2,20),2),/已到货/);
   await q('UPDATE inbound_records SET received_at=NULL WHERE id=?',[other]);
   await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=1');await assert.rejects(legacy.applyProcurementLedgerMysql(body(await ledger(200),other,2,20),1,2));await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=1');
   await assert.rejects(legacy.previewProcurementLedgerMysql({...body(state,other,2,20),product_id:300},2));
  });
  await t.test('legacy purchased request and batch correct together without creating a formal purchase or local movement',async()=>{
   const request=await q("INSERT INTO procurement_requests(tenant_id,product_id,person_id,quantity,amount,shipping_amount,status,approval_status) VALUES(2,202,1,5,50,0,'purchased','approved')");
   const inserted=await q("INSERT INTO inbound_records(tenant_id,product_id,person_id,quantity,amount,shipping_amount,status,procurement_request_id) VALUES(2,202,1,5,50,0,'pending_arrival',?)",[request.insertId]);
   const input={...body(await ledger(202),Number(inserted.insertId),3,36),product_id:202};await legacy.applyProcurementLedgerMysql(input,1,2);
   const revised=(await q('SELECT quantity,amount FROM procurement_requests WHERE id=?',[request.insertId]))[0];assert.equal(Number(revised.quantity),3);assert.equal(Number(revised.amount),36);assert.equal(await stock(202),0);
   await legacy.applyProcurementLedgerMysql({...body(await ledger(202),Number(inserted.insertId),0,0),product_id:202},1,2);
   assert.equal((await readBatch(inserted.insertId)).status,'cancelled');assert.equal((await q('SELECT status FROM procurement_requests WHERE id=?',[request.insertId]))[0].status,'cancelled');
  });
  const service=createInventoryWorkflowService({ledger:legacy.inventoryLedgerMysql,receiveRecords:legacy.batchUpdateInboundRecordsMysql,previewReceipts:legacy.previewInboundReceiptImpactMysql});
  let receipt;
  await t.test('receipt entry and preview show physical/available before and after without money or writes',async()=>{
   await legacy.recordProcurementPurchaseMysql({items:[{product_id:203,quantity:10,amount:100}]},1,2);
   const context=await service.receiptContext(203,session(2));assert.equal(context.rows.length,1);assert.equal(context.physical,0);assert.equal(context.available,0);assert.equal(context.rows[0].amount,undefined);
   receipt={product_id:203,request_key:randomUUID(),records:[{id:context.rows[0].id,quantity:6,expected_quantity:10,reason:'部分到货'}]};
   const result=await service.previewReceive(receipt,session(2));assert.equal(result.physical_before,0);assert.equal(result.physical_after,6);assert.equal(result.available_after,6);assert.equal(result.requires_count,false);assert.equal(result.amount,undefined);assert.equal(await stock(203),0);
   receipt.expected_revision=result.revision;
   await assert.rejects(service.previewReceive({...receipt,product_id:300},session(2)),{statusCode:404});
   await assert.rejects(service.previewReceive({...receipt,records:[{...receipt.records[0],reason:''}]},session(2)),/部分入库/);
  });
  await t.test('stale receipt confirmation rejects; fresh partial receipt posts only accepted pieces once',async()=>{
   await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,203,'purchase_inbound',1,'posted','LOCAL')");
   await assert.rejects(service.receive(receipt,session(2)),{statusCode:409});assert.equal(await stock(203),1);
   const preview=await service.previewReceive(receipt,session(2));await service.receive({...receipt,expected_revision:preview.revision},session(2));assert.equal(await stock(203),7);
   await assert.rejects(service.receive(receipt,session(2)));assert.equal(await stock(203),7);
   const left=await service.receipts(203,session(2));assert.equal(left.length,1);assert.equal(Number(left[0].quantity),4);
  });
  await t.test('historical stocktake count remains explicit; preview never guesses an after total',async()=>{
   const before=await ledger(203);await legacy.applyProcurementLedgerMysql({action_type:'stocktake',product_id:203,revision:before.revision,request_key:randomUUID(),counted_quantity:7,reason_code:'other',reason_note:'实盘核实'},3,2);
   const rows=await service.receipts(203,session(2)),input={product_id:203,request_key:randomUUID(),records:[{id:rows[0].id,quantity:4,expected_quantity:4}]};
   const unknown=await service.previewReceive(input,session(2));assert.equal(unknown.requires_count,true);assert.equal(unknown.physical_after,null);assert.equal(unknown.available_after,null);
   const known=await service.previewReceive({...input,counted_quantity:11},session(2));assert.equal(known.physical_after,11);assert.equal(known.available_after,11);
   await service.receive({...input,counted_quantity:11,expected_revision:known.revision},session(2));assert.equal(await stock(203),11);
  });
  await t.test('arrival cards count pending quantities across batches, respecting search and tenant',async()=>{
   const result=await createProcurementArrivals().list({status:'open',summary_only:'1',product_id:200},session());assert.equal(result.summary.open,1);assert.equal(result.summary.open_quantity,6);assert.equal(result.summary.arrived_quantity,0);
   await assert.rejects(createProcurementArrivals().list({status:'open',product_id:300},session()),{statusCode:404});
  });
 }finally{await closeMysqlPool();await f.cleanup();}
});
