import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
test('batch price exceptions retain reasons, roll back failures and retry without duplicate purchases',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent local MySQL',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('batch_price_reason');f.useEnvironment();const q=f.query;
 const legacy=await import('../src/services/mysql-cutover.js');const {closeMysqlPool}=await import('../src/mysql-pool.js');
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'A buyer','procurement'),(2,'B buyer','procurement')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('procurement'),1),(3,2,'member',JSON_ARRAY('procurement'),1)");
  await legacy.prepareInventoryFlowMysql();
  await q('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  await q("INSERT INTO products(id,tenant_id,name) VALUES(200,2,'Unchanged price'),(201,2,'Raised price'),(300,3,'B private')");
  await legacy.recordProcurementPurchaseMysql({items:[{product_id:200,quantity:10,amount:100},{product_id:201,quantity:10,amount:100}]},1,2);
  const count=async table=>Number((await q(`SELECT COUNT(*) n FROM ${table} WHERE tenant_id=2`))[0].n);
  const tables=['purchase_orders','purchase_order_items','procurement_requests','inbound_records','purchase_cost_versions','inventory_flow_events'];
  const before=await Promise.all(tables.map(count));
  const body={workspace_batch:true,request_key:randomUUID(),person_id:1,source_type:'1688',items:[{product_id:200,quantity:2,actual_quantity:2,amount:20,shipping_amount:0},{product_id:201,quantity:2,actual_quantity:2,amount:40,shipping_amount:0,anomaly_reason:''}]};
  await t.test('missing or whitespace cause rejects the whole batch and identifies the raised product',async()=>{
   for(const reason of ['', '  ']){
    await assert.rejects(legacy.recordProcurementPurchaseMysql({...body,items:[body.items[0],{...body.items[1],anomaly_reason:reason}]},1,2),e=>{
     assert.equal(e.statusCode,409);assert.equal(e.validation.product_id,201);assert.equal(e.validation.actual_unit_cost,20);assert.equal(e.validation.reference_unit_cost,10);return true;
    });
    assert.deepEqual(await Promise.all(tables.map(count)),before,'no partial purchase, request, arrival or cost version survives rollback');
   }
  });
  const reason='其他原因：小批次包含定制工艺';let saved;
  await t.test('same submission can be corrected after rollback; cost history records cause, confirmer and time',async()=>{
   body.items[1].anomaly_reason=reason;saved=await legacy.recordProcurementPurchaseMysql(body,1,2);
   assert.equal(saved.ok,true);
   const cost=(await q("SELECT anomaly_reason,review_status,reviewed_by_person_id,reviewed_at,quantity,amount FROM purchase_cost_versions WHERE product_id=201 ORDER BY version_no DESC LIMIT 1"))[0];
   assert.equal(cost.anomaly_reason,reason);assert.equal(cost.review_status,'reviewed');assert.equal(Number(cost.reviewed_by_person_id),1);assert.ok(cost.reviewed_at);assert.equal(Number(cost.quantity),2);assert.equal(Number(cost.amount),40);
   const pending=await q("SELECT quantity,status FROM inbound_records WHERE purchase_order_id=?",[saved.purchase_order_id]);assert.equal(pending.length,2);assert.ok(pending.every(r=>r.status==='pending_arrival'));
   assert.equal(Number((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n),0,'recording purchase never receives stock');
  });
  await t.test('legacy request confirmation passes each product reason independently; a second missing reason identifies that row',async()=>{
   const requests=await legacy.createProcurementRequestMysql({items:[{product_id:200,quantity:1,amount:40},{product_id:201,quantity:1,amount:40}]},1,2);
   const oldBody={request_ids:requests.ids,items:[{product_id:200,actual_quantity:1,amount:40,anomaly_reason:'供应商涨价'},{product_id:201,actual_quantity:1,amount:40,anomaly_reason:''}]};
   await assert.rejects(legacy.confirmProcurementRequestsPurchasedMysql(oldBody,1,2),e=>{assert.equal(e.validation.product_id,201);return true;});
   oldBody.items[1].anomaly_reason='其他原因：更换工艺';
   const oldSaved=await legacy.confirmProcurementRequestsPurchasedMysql(oldBody,1,2);assert.equal(oldSaved.ok,true);
   const costs=await q('SELECT product_id,anomaly_reason FROM purchase_cost_versions WHERE purchase_order_id=? ORDER BY product_id',[oldSaved.purchase_order_id]);
   assert.equal(costs[0].anomaly_reason,'供应商涨价');assert.equal(costs[1].anomaly_reason,'其他原因：更换工艺');
  });
  await t.test('lost-response retry is idempotent and cannot rewrite an already committed explanation',async()=>{
   const counts=await Promise.all(tables.map(count));const repeat=await legacy.recordProcurementPurchaseMysql(body,1,2);assert.equal(repeat.duplicate,true);assert.deepEqual(await Promise.all(tables.map(count)),counts);
   await assert.rejects(legacy.recordProcurementPurchaseMysql({...body,items:[body.items[0],{...body.items[1],anomaly_reason:'供应商涨价'}]},1,2),{statusCode:409});
   assert.deepEqual(await Promise.all(tables.map(count)),counts);
   await assert.rejects(legacy.recordProcurementPurchaseMysql({...body,request_key:randomUUID(),items:[{product_id:300,quantity:1,amount:10}]},1,2));
  });
 }finally{await closeMysqlPool();await f.cleanup();}
});
