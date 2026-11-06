import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';

test('lineage labels distinguish independent purchases and exclude foreign audit pointers without altering records',{
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated socket-only MySQL',timeout:180000
},async()=>{
 const f=await createTenantMysqlFixture('arrival_lineage');f.useEnvironment();const q=f.query;
 const api=await import('../src/services/mysql-cutover.js');
 const {createProcurementArrivals}=await import('../src/services/procurement-arrivals.js');
 const {closeMysqlPool}=await import('../src/mysql-pool.js');
 const service=createProcurementArrivals(),buyer={personId:7,tenant:{id:2,slug:'a'}},defaultBuyer={personId:1,tenant:{id:1,slug:'default'}};
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'Default buyer','procurement'),(7,'A buyer','procurement'),(9,'B buyer','procurement')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(1,1,'member',JSON_ARRAY('procurement'),1),(2,7,'member',JSON_ARRAY('procurement'),1),(3,9,'member',JSON_ARRAY('procurement'),1)");
  await api.prepareInventoryFlowMysql();
  await q('CREATE TABLE IF NOT EXISTS inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB');
  await api.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  await q("INSERT INTO products(id,tenant_id,name,code) VALUES(101,2,'Synthetic child','CHILD'),(331,2,'Synthetic parent','PARENT'),(300,3,'Foreign parent','FOREIGN'),(401,NULL,'Legacy default child','DEFAULT-CHILD'),(431,NULL,'Legacy default parent','DEFAULT-PARENT')");
  await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,331,101,2),(NULL,431,401,2)');
  const rows=[
   [1675,2,331,466,'PO-20261031-005',20,180,'pending_arrival','2026-10-31 07:49:24'],
   [1685,2,331,467,'PO-20261031-006',0,0,'cancelled','2026-10-31 07:57:41'],
   [1915,2,101,575,'HISTORY-315',40,360,'pending_arrival','2026-10-31 07:57:41'],
   [2000,3,300,600,'FOREIGN-PRIVATE-PO',20,999,'cancelled','2026-10-31 07:57:41'],
   [2001,null,431,601,'DEFAULT-ORIGINAL',0,0,'cancelled','2026-10-31 07:57:41'],
   [2002,null,401,602,'HISTORY-DEFAULT',40,100,'pending_arrival','2026-10-31 07:57:41']
  ];
  for(const[id,tenant,product,po,orderNo,quantity,amount,status,at]of rows){
   await q('INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at,total_quantity,total_amount) VALUES(?,?,?,?,?,?,?)',[po,tenant,orderNo,status==='cancelled'?'cancelled':'purchased',at,quantity,amount]);
   await q('INSERT INTO purchase_order_items(id,tenant_id,purchase_order_id,product_id,requested_quantity,actual_quantity,amount,status) VALUES(?,?,?,?,?,?,?,?)',[id,tenant,po,product,quantity,quantity,amount,status==='cancelled'?'cancelled':'purchased']);
   await q('INSERT INTO inbound_records(id,tenant_id,product_id,quantity,amount,status,purchase_order_id,purchase_order_item_id) VALUES(?,?,?,?,?,?,?,?)',[id,tenant,product,quantity,amount,status,po,id]);
  }
  const review=(id,sourceProduct,po,childId,childProduct,childPo)=>({source:{id,product_id:sourceProduct,purchase_order_id:po},result:{mode:'whole',inbound_id:id,created:[{inbound_id:childId,product_id:childProduct,purchase_order_id:childPo}]}});
  const before=await service.list({day_mode:'pending',product_id:101,status:'open',pageSize:1,page:1},buyer);
  const saved=await q('SELECT id,tenant_id,product_id,quantity,amount,status,purchase_order_id,purchase_order_item_id FROM inbound_records ORDER BY id');
  await q("INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(2,331,7,'purchase_bundle_review',?)",[JSON.stringify(review(1685,331,467,1915,101,575))]);
  const first=await service.list({day_mode:'pending',product_id:101,status:'open',pageSize:1,page:1},buyer),second=await service.list({day_mode:'pending',product_id:101,status:'open',pageSize:1,page:2},buyer);
  assert.equal(first.total,2);assert.equal(second.total,2);assert.deepEqual(first.days,before.days);assert.equal(first.selected_day,'2026-10-31');
  const records=[...first.rows,...second.rows],child=records.find(row=>row.id===1915),independent=records.find(row=>row.id===1675);
  assert.deepEqual(child.source_bundle_batch,{id:1685,product_id:331,purchase_order_id:467,order_no:'PO-20261031-006'});
  assert.equal(child.order_no,'HISTORY-315');assert.equal(child.purchase_order_id,575);assert.equal(independent.order_no,'PO-20261031-005');assert.equal(independent.source_bundle_batch,null);
  assert.equal(independent.review_required,true);assert.equal(first.summary.open_quantity,40);assert.equal(first.summary.open_unknown_batches,1);
  await q("INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(1,431,1,'purchase_bundle_review',?)",[JSON.stringify(review(2001,431,601,2002,401,602))]);
  const legacy=await service.list({day_mode:'pending',status:'open'},defaultBuyer);assert.deepEqual(legacy.rows[0].source_bundle_batch,{id:2001,product_id:431,purchase_order_id:601,order_no:'DEFAULT-ORIGINAL'});
  await q("INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(2,331,7,'purchase_bundle_review',?)",[JSON.stringify(review(2000,300,600,1915,101,575))]);
  const corrupt=await service.list({day_mode:'pending',status:'open',product_id:101},buyer);
  assert.equal(corrupt.rows.find(row=>row.id===1915).source_bundle_batch,null);assert.ok(!JSON.stringify(corrupt).includes('FOREIGN-PRIVATE-PO'));
  assert.deepEqual(await q('SELECT id,tenant_id,product_id,quantity,amount,status,purchase_order_id,purchase_order_item_id FROM inbound_records ORDER BY id'),saved);
  assert.equal((await q('SELECT COUNT(*) n FROM inventory_movements'))[0].n,0);
 }finally{await closeMysqlPool();await f.cleanup();}
});
