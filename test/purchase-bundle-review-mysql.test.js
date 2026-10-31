import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('legacy kit purchases are corrected atomically to owned physical batches without receiving stock',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('bundle_review');f.useEnvironment();const q=f.query;
 const legacy=await import('../src/services/mysql-cutover.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const {createProcurementArrivals}=await import('../src/services/procurement-arrivals.js');
 const {createInventoryWorkflowService}=await import('../src/services/inventory-workflow.js');
 const workflow=createInventoryWorkflowService({ledger:legacy.inventoryLedgerMysql,receiveRecords:legacy.batchUpdateInboundRecordsMysql,previewReceipts:legacy.previewInboundReceiptImpactMysql});
 const buyer={personId:1,tenant:{id:2,slug:'a',role:'member'}},warehouse={personId:2,tenant:{id:2,slug:'a',role:'member'}},foreign={personId:3,tenant:{id:3,slug:'b',role:'member'}};
 const arrivals=createProcurementArrivals();
 const stock=async()=>Number((await q("SELECT COALESCE(SUM(quantity_delta),0) n FROM inventory_movements WHERE tenant_id=2 AND status='posted'"))[0].n);
 const batch=async id=>(await q('SELECT * FROM inbound_records WHERE id=?',[id]))[0];
 const make=async(arrived=false)=>{
  await legacy.recordProcurementPurchaseMysql({items:[{product_id:200,quantity:10,amount:100,shipping_amount:10}]},1,2);
  const row=(await q('SELECT * FROM inbound_records WHERE product_id=200 ORDER BY id DESC LIMIT 1'))[0];
  await q("UPDATE inbound_records SET tracking_number='TRACK-TEST',courier_company='TEST',received_at=? WHERE id=?",[arrived?'2026-10-30 08:00:00':null,row.id]);
  return legacy.purchaseBundleContextMysql({id:row.id},buyer);
 };
 const input=(ctx,mode='whole')=>({id:ctx.batch.id,revision:ctx.revision,request_key:randomUUID(),mode,note:'已逐笔核对采购凭证',allocation_confirmed:true,arrived:!!ctx.batch.received_at,items:ctx.components.map((c,i)=>({product_id:c.product_id,quantity:c.quantity,amount:i?40:60,shipping_amount:i?4:6}))});
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'Buyer','procurement'),(2,'Warehouse','packing'),(3,'Foreign','procurement')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('procurement'),1),(2,2,'member',JSON_ARRAY('packing'),1),(3,3,'member',JSON_ARRAY('procurement'),1)");
  await legacy.prepareInventoryFlowMysql();await q('CREATE TABLE inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  await q("INSERT INTO products(id,tenant_id,name,inventory_number,purchase_cost) VALUES(200,2,'Kit','2-200',10),(201,2,'Part A','2-201',2),(202,2,'Part B','2-202',3),(300,3,'Foreign','3-300',9)");
  await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,200,201,2),(2,200,202,1)');
  await t.test('unreviewed kit shows unknown total, actual parts and affected kit; arrival cannot silently assume complete kits',async()=>{
   const ctx=await make(),listed=await arrivals.list({status:'open',product_id:201},buyer);assert.equal(listed.total,1);assert.equal(listed.rows[0].review_required,true);assert.equal(listed.rows[0].physical_quantity,null);assert.equal(listed.summary.open_quantity,0);assert.equal(listed.summary.open_unknown_batches,1);assert.equal(listed.rows[0].amount,undefined);assert.deepEqual(listed.rows[0].components.map(p=>p.quantity),[20,10]);
   await assert.rejects(arrivals.confirm({id:ctx.batch.id,note:'到货',expected_updated_at:listed.rows[0].updated_at,request_key:randomUUID()},buyer),/核对实际采购内容/);
   await assert.rejects(legacy.batchUpdateInboundRecordsMysql({records:[{id:ctx.batch.id,status:'approved',receive_quantity:10,purchase_quantity:10}]},2,2),/核对实际采购内容/);
   await assert.rejects(legacy.purchaseBundleContextMysql({id:ctx.batch.id},warehouse),{statusCode:403});await assert.rejects(legacy.purchaseBundleContextMysql({id:ctx.batch.id},foreign),{statusCode:404});
  });
  await t.test('whole kit creates complete physical child batches and conserves total money, date, buyer and tracking',async()=>{
   const ctx=await make(true),body=input(ctx),before=await stock();const saved=await legacy.reviewPurchaseBundleMysql(body,buyer);assert.equal(saved.created.length,2);assert.equal(saved.physical_changed,false);assert.equal((await batch(ctx.batch.id)).status,'cancelled');
   const children=await Promise.all(saved.created.map(c=>batch(c.inbound_id)));assert.deepEqual(children.map(c=>Number(c.quantity)),[20,10]);assert.equal(children.reduce((n,c)=>n+Number(c.amount)+Number(c.shipping_amount),0),110);assert.ok(children.every(c=>c.status==='pending_arrival'&&c.received_at&&c.tracking_number==='TRACK-TEST'&&Number(c.person_id)===1));assert.equal(await stock(),before);
   const repeated=await legacy.reviewPurchaseBundleMysql(body,buyer);assert.equal(repeated.duplicate,true);assert.deepEqual(repeated.created,saved.created);await assert.rejects(legacy.reviewPurchaseBundleMysql({...body,note:'changed'},buyer),{statusCode:409});
   const listing=await arrivals.list({status:'arrived',product_id:201},warehouse);assert.ok(listing.rows.some(r=>r.source_bundle_batch?.id===Number(ctx.batch.id)&&!r.is_bundle));
   const a=children[0];await workflow.receive({product_id:201,request_key:randomUUID(),records:[{id:a.id,quantity:20,expected_quantity:20}]},warehouse);assert.equal(await stock(),before+20);assert.equal((await batch(children[1].id)).status,'pending_arrival');
  });
  await t.test('part-only historical correction buys just the actual part, requires explicit amount correction and is idempotent',async()=>{
   const ctx=await make(),body={...input(ctx,'parts'),items:[{product_id:201,quantity:7,amount:35,shipping_amount:0}]},before=await stock();await assert.rejects(legacy.reviewPurchaseBundleMysql(body,buyer),/明确确认金额更正/);
   body.confirm_amount_change=true;const result=await legacy.reviewPurchaseBundleMysql(body,buyer);assert.equal(result.created.length,1);const child=await batch(result.created[0].inbound_id);assert.equal(Number(child.product_id),201);assert.equal(Number(child.quantity),7);assert.equal(Number(child.amount),35);assert.equal(child.received_at,null);assert.equal(await stock(),before);assert.equal((await legacy.reviewPurchaseBundleMysql(body,buyer)).duplicate,true);
  });
  await t.test('stale composition and revoked procurement rights cannot rewrite a batch',async()=>{
   const ctx=await make(),body=input(ctx);await q('UPDATE product_components SET quantity=3 WHERE product_id=200 AND component_product_id=201');await assert.rejects(legacy.reviewPurchaseBundleMysql(body,buyer),/组成已变化/);assert.equal((await batch(ctx.batch.id)).status,'pending_arrival');await q('UPDATE product_components SET quantity=2 WHERE product_id=200 AND component_product_id=201');
   await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=1');await assert.rejects(legacy.reviewPurchaseBundleMysql(body,buyer),{statusCode:403});await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=1');
   await assert.rejects(legacy.reviewPurchaseBundleMysql({...body,items:[{product_id:300,quantity:1,amount:110}]},buyer));
  });
  await t.test('failure on a later child rolls back source cancellation, first child and audit together',async()=>{
   const ctx=await make(),before=await q('SELECT id,status,quantity,amount FROM inbound_records ORDER BY id'),body=input(ctx);
   await f.connection.query("CREATE TRIGGER reject_part_b BEFORE INSERT ON purchase_order_items FOR EACH ROW BEGIN IF NEW.product_id=202 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected child failure'; END IF; END");
   try{await assert.rejects(legacy.reviewPurchaseBundleMysql(body,buyer),/injected child failure/);}finally{await f.connection.query('DROP TRIGGER reject_part_b');}
   assert.deepEqual(await q('SELECT id,status,quantity,amount FROM inbound_records ORDER BY id'),before);assert.equal(Number((await q("SELECT COUNT(*) n FROM inventory_flow_events WHERE action='purchase_bundle_review' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=?",[body.request_key]))[0].n),0);
  });
  await t.test('new workspace purchase refuses a kit and accepts the actual physical part',async()=>{
   const body={workspace_batch:true,request_key:randomUUID(),items:[{product_id:200,quantity:1,amount:10}]};await assert.rejects(legacy.recordProcurementPurchaseMysql(body,1,2),/最小实物库存/);const saved=await legacy.recordProcurementPurchaseMysql({...body,request_key:randomUUID(),items:[{product_id:201,quantity:3,amount:6}]},1,2);assert.equal(saved.ok,true);
  });
 }finally{await closeMysqlPool();await f.cleanup();}
});
