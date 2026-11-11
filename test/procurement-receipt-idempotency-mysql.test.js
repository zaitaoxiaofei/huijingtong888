import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('keyed new-arrival receipts recover lost responses without reposting stock and preserve authorization',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('receipt_retry');f.useEnvironment();const q=f.query;
 const api=await import('../src/services/mysql-cutover.js');
 const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const warehouse={personId:3,tenant:{id:2,slug:'a'}},other={personId:4,tenant:{id:2,slug:'a'}},foreign={personId:2,tenant:{id:3,slug:'b'}};
 const create=receiveRecords=>createInventoryWorkflowService({ledger:api.procurementLedgerMysql,receiveRecords:receiveRecords||api.batchUpdateInboundRecordsMysql,previewReceipts:api.previewInboundReceiptImpactMysql});
 const service=create();
 const stock=async id=>Number((await q("SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_movements WHERE product_id=? AND status='posted'",[id]))[0].n);
 const events=async key=>q("SELECT * FROM inventory_flow_events WHERE action='purchase_receipt' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=?",[key]);
 const body=async(id,quantity,expected,key=randomUUID())=>{
  const input={product_id:id,receipt_mode:'new_arrival',request_key:key,records:[{id,quantity,expected_quantity:expected,...(quantity<expected?{reason:'剩余尚未到货'}:{})}]};
  return{...input,expected_revision:(await service.previewReceive(input,warehouse)).revision};
 };
 const barrierWriter=()=>{let arrived=0,release;const barrier=new Promise(resolve=>release=resolve);return async(...args)=>{if(++arrived===2)release();await barrier;return api.batchUpdateInboundRecordsMysql(...args);};};
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'A buyer','procurement'),(2,'B buyer','procurement'),(3,'A warehouse','packing'),(4,'A other warehouse','packing')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('procurement'),1),(3,2,'member',JSON_ARRAY('procurement','packing'),1),(2,3,'member',JSON_ARRAY('packing'),1),(2,4,'member',JSON_ARRAY('packing'),1)");
  await api.prepareInventoryFlowMysql();
  await q('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await api.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  for(const [id,quantity] of [[200,600],[201,4],[202,3],[203,3],[204,10],[205,10],[206,2],[207,3],[208,4],[300,2]]){
   const tenant=id===300?3:2,person=tenant===3?2:1;
   await q('INSERT INTO products(id,tenant_id,name,code) VALUES(?,?,?,?)',[id,tenant,`Receipt ${id}`,`R-${id}`]);
   await q("INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at,created_by_person_id,total_quantity,total_amount) VALUES(?,?,?,'purchased',UTC_TIMESTAMP(),?,?,?)",[id,tenant,`RECEIPT-${id}`,person,quantity,quantity]);
   await q("INSERT INTO purchase_order_items(id,tenant_id,purchase_order_id,product_id,actual_quantity,requested_quantity,amount,status) VALUES(?,?,?,?,?,?,?,'purchased')",[id,tenant,id,id,quantity,quantity,quantity]);
   await q("INSERT INTO inbound_records(id,tenant_id,product_id,person_id,quantity,amount,unit_cost,purchase_order_id,purchase_order_item_id,status,received_at) VALUES(?,?,?,?,?,?,1,?,?,'pending_arrival',UTC_TIMESTAMP())",[id,tenant,id,person,quantity,quantity,id,id]);
  }
  await q('UPDATE inbound_records SET received_at=NULL WHERE id=200');
  await q("INSERT INTO tenant_private_files(tenant_id,storage_name,original_name,purpose,content_type,byte_size,uploaded_by) VALUES(2,'receipt-a.jpg','A','team','image/jpeg',1,1),(3,'receipt-b.jpg','B','team','image/jpeg',1,2)");
  let partial;
  await t.test('partial success with a discarded response replays the same receipt, photos and remaining 520 exactly once',async()=>{
   partial=await body(200,80,600);partial.records[0].receipt_images_json=['/uploads/team-attachments/receipt-a.jpg'];
   await service.receive(partial,warehouse); // Simulate a committed response lost by the client.
   const repeated=await service.receive(structuredClone(partial),warehouse);
   assert.equal(repeated.duplicate,true);assert.deepEqual(repeated.ids,[200]);assert.equal(await stock(200),80);
   const batches=await q('SELECT quantity,status,received_at,receipt_images_json FROM inbound_records WHERE product_id=200 ORDER BY id');
   assert.equal(batches.length,2);assert.equal(Number(batches[0].quantity),80);assert.equal(batches[0].status,'approved');assert.match(JSON.stringify(batches[0].receipt_images_json),/receipt-a/);
   assert.equal(Number(batches[1].quantity),520);assert.equal(batches[1].received_at,null);
   assert.equal((await events(partial.request_key)).length,1);assert.equal(Number((await q('SELECT actual_quantity FROM purchase_order_items WHERE id=200'))[0].actual_quantity),600);
  });
  await t.test('a reused key cannot change content or product and cannot replay after authority is revoked',async()=>{
   for(const changed of [{...partial,expected_revision:'changed'},{...partial,records:[{...partial.records[0],quantity:81}]},{...partial,records:[{...partial.records[0],reason:'changed'}]},{...partial,records:[{...partial.records[0],receipt_images_json:[]}]}])await assert.rejects(service.receive(changed,warehouse),{statusCode:409});
   const different=await body(201,4,4,partial.request_key);await assert.rejects(service.receive(different,warehouse),{statusCode:409});assert.equal(await stock(201),0);
   await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('selection') WHERE tenant_id=2 AND person_id=3");
   await assert.rejects(service.receive(partial,warehouse),{statusCode:403});
   await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=3");
   await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=3');await assert.rejects(service.receive(partial,warehouse),{statusCode:403});await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=3');
   await assert.rejects(service.receive(partial,foreign),{statusCode:404});await assert.rejects(service.receive(partial,other),{statusCode:409});
   assert.equal(await stock(200),80);assert.equal((await events(partial.request_key)).length,1);
  });
  await t.test('another enterprise using the same key cannot receive the first enterprise result',async()=>{
   const input={product_id:300,receipt_mode:'new_arrival',request_key:partial.request_key,records:[{id:300,quantity:2,expected_quantity:2}]};
   const preview=await service.previewReceive(input,foreign),saved=await service.receive({...input,expected_revision:preview.revision},foreign);
   assert.deepEqual(saved.ids,[300]);assert.equal(await stock(300),2);assert.equal((await events(partial.request_key)).length,2);
  });
  await t.test('concurrent identical receipts for one product serialize and record one stock movement and receipt',async()=>{
   const input=await body(202,3,3),parallel=create(barrierWriter());
   const results=await Promise.all([parallel.receive(structuredClone(input),warehouse),parallel.receive(structuredClone(input),warehouse)]);
   assert.equal(results.filter(result=>result.duplicate).length,1);assert.equal(await stock(202),3);assert.equal((await events(input.request_key)).length,1);
  });
  await t.test('concurrent reuse of one actor key for two products commits only one request',async()=>{
   const key=randomUUID(),a=await body(204,10,10,key),b=await body(205,10,10,key),parallel=create(barrierWriter());
   const results=await Promise.allSettled([parallel.receive(a,warehouse),parallel.receive(b,warehouse)]);
   assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
   assert.equal(results.find(result=>result.status==='rejected').reason.statusCode,409);
   assert.equal(await stock(204)+await stock(205),10);assert.equal((await events(key)).length,1);
  });
  await t.test('stale input or foreign photos never commits a keyed receipt',async()=>{
   const input=await body(203,3,3);await assert.rejects(service.receive({...input,expected_revision:'old'},warehouse),{statusCode:409});
   await assert.rejects(service.receive({...input,records:[{...input.records[0],receipt_images_json:['/uploads/team-attachments/receipt-b.jpg']}]},warehouse),{statusCode:403});
   assert.equal(await stock(203),0);assert.equal((await events(input.request_key)).length,0);
  });
  await t.test('receipt audit failure rolls back the stock, batch and result together and the same key can retry',async()=>{
   const input=await body(206,2,2);
   await f.connection.query("CREATE TRIGGER fail_receipt_audit BEFORE INSERT ON inventory_flow_events FOR EACH ROW BEGIN IF NEW.action='purchase_receipt' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated audit failure'; END IF; END");
   try{await assert.rejects(service.receive(input,warehouse),/isolated audit failure/);}finally{await f.connection.query('DROP TRIGGER fail_receipt_audit');}
   assert.equal(await stock(206),0);assert.equal((await events(input.request_key)).length,0);assert.equal((await q('SELECT status FROM inbound_records WHERE id=206'))[0].status,'pending_arrival');
   await service.receive(input,warehouse);assert.equal(await stock(206),2);assert.equal((await events(input.request_key)).length,1);
  });
  await t.test('a concurrent ledger stocktake and a new receipt keep the canonical stock delta',async()=>{
   const input=await body(208,4,4),state=await api.procurementLedgerMysql({product_id:208,include_fbp:false},2);
   const results=await Promise.allSettled([
    api.applyProcurementLedgerMysql({action_type:'stocktake',product_id:208,counted_quantity:0,reason_code:'other',reason_note:'isolated concurrency verification',revision:state.revision,request_key:randomUUID()},1,2),
    service.receive(input,warehouse)
   ]);
   const received=results[1].status==='fulfilled';
   if(results[0].status==='rejected')assert.match(results[0].reason.message,/已变化/);
   if(!received)assert.match(results[1].reason.message,/已变化/);
   assert.equal(await stock(208),received?4:0);
   assert.equal((await events(input.request_key)).length,received?1:0);
  });
 }finally{await closeMysqlPool();await f.cleanup();}
});
