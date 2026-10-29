import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('warehouse reminder atomically creates actionable topup plus scoped admin/buyer notifications; retries and revocation are safe', {
 skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires isolated MySQL socket',timeout:180000
},async t=>{
 const f=await createTenantMysqlFixture('stock_topup');f.useEnvironment();const q=f.query;
 const { createWarehouseStockTopupService }=await import('../src/services/warehouse-stock-topup.js');
 const legacy=await import('../src/services/mysql-cutover.js');
 const { closeMysqlPool,withMysqlTransaction }=await import('../src/mysql-pool.js');
 const events=[];const create=createWarehouseStockTopupService({broadcast:(...event)=>events.push(event)});
 const session={personId:1,roles:['packing'],tenant:{id:2,slug:'a',role:'member'}};
 const body=()=>({order_id:2000,product_id:200,quantity:2,note:'实物不足，需要补足',request_key:randomUUID()});
 const counts=async()=>[(await q('SELECT COUNT(*) n FROM procurement_requests'))[0].n,(await q('SELECT COUNT(*) n FROM system_notifications'))[0].n];
 try{
  await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await q("INSERT INTO people(id,name,role) VALUES(1,'A warehouse','packing'),(2,'A buyer','procurement'),(3,'A admin','operations'),(4,'B buyer','procurement'),(5,'A analyst','analytics'),(6,'Disabled buyer','procurement'),(7,'Platform only','admin')");
  await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('packing'),1),(2,2,'member',JSON_ARRAY('procurement'),1),(2,3,'admin',JSON_ARRAY('procurement'),1),(3,4,'admin',JSON_ARRAY('procurement'),1),(2,5,'member',JSON_ARRAY('analytics'),1),(2,6,'member',JSON_ARRAY('procurement'),0)");
  await legacy.prepareInventoryFlowMysql();
  await q("CREATE TABLE inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB");
  await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1'},2);
  await q("INSERT INTO shops(id,tenant_id,name,status) VALUES(20,2,'A','active'),(30,3,'B','active')");
  await q("INSERT INTO products(id,tenant_id,name,code) VALUES(200,2,'A part','A-200'),(300,3,'B private','B-300')");
  await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(200,2,200,20,'20001',1),(300,3,300,30,'30001',1)");
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(2000,20,'A-ORDER','awaiting_packaging',UTC_TIMESTAMP()),(3000,30,'B-ORDER','awaiting_packaging',UTC_TIMESTAMP())");
  await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(2000,2000,'20001',200,1),(3000,3000,'30001',300,1)");
  await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,quantity_delta,status,stock_location) VALUES(2,200,'purchase_inbound',10,'posted','LOCAL')");
  await t.test('concurrent retries create one request, notify each eligible recipient once, and preserve real inventory',async()=>{
   const input=body();const result=await Promise.all([create(input,session),create(input,session)]);
   assert.equal(result[0].id,result[1].id);assert.equal(result.filter(r=>r.duplicate).length,1);
   const rows=await q('SELECT * FROM procurement_requests');assert.equal(rows.length,1);
   assert.equal(rows[0].demand_type,'warehouse_request');assert.equal(rows[0].request_reason_code,'inventory_stock_topup');assert.equal(Number(rows[0].source_order_id),2000);
   const notices=await q('SELECT tenant_id,recipient_person_id,notification_type,route,status FROM system_notifications ORDER BY recipient_person_id');
   assert.deepEqual(notices.map(n=>Number(n.recipient_person_id)),[2,3]);assert.ok(notices.every(n=>Number(n.tenant_id)===2&&n.notification_type==='stock_topup'&&n.status==='unread'));
   assert.equal(events.length,2);assert.equal(Number((await q('SELECT SUM(quantity_delta) qty FROM inventory_movements'))[0].qty),10);
   await assert.rejects(create({...input,quantity:3},session),{statusCode:409});
   const workspace=await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1',demandType:'warehouse_request'},2);
   assert.equal(workspace.rows.length,1);assert.equal(workspace.rows[0].order_request_count,0);assert.equal(workspace.rows[0].primary_suggested_purchase_qty,2);
  });
  await t.test('foreign references, platform-only identity and revoked business duties cannot create requests or notify',async()=>{
   const before=await counts();
   await assert.rejects(create({...body(),product_id:300},session));
   await assert.rejects(create({...body(),order_id:3000},session));
   await assert.rejects(create(body(),{...session,personId:7}),{statusCode:403});
   await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('analytics') WHERE tenant_id=2 AND person_id=1");
   await assert.rejects(create(body(),session),{statusCode:403});
   await q("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2 AND person_id=1");
   assert.deepEqual(await counts(),before);
  });
  await t.test('real order shortage stays ahead of newer warehouse requests across server-side pages',async()=>{
   await q("INSERT INTO products(id,tenant_id,name,code) VALUES(201,2,'Order shortage','A-201')");
   await q("INSERT INTO sku_mappings(id,tenant_id,product_id,shop_id,ozon_sku,active) VALUES(201,2,201,20,'20101',1)");
   await q("INSERT INTO order_items(id,order_id,ozon_sku,sku_mapping_id,quantity) VALUES(2001,2000,'20101',201,1)");
   await q("UPDATE procurement_requests SET created_at='2030-01-01' WHERE product_id=200");
   const {invalidateOrderProcurementCoverage}=await import('../src/services/mysql-order-procurement-coverage.js');invalidateOrderProcurementCoverage();
   const page=await legacy.procurementRequestsMysql({grouped:'1',paged:'1',compact:'1',pageSize:'1',demandType:'all'},2);
   assert.equal(page.total,2);assert.equal(page.rows.length,1);assert.equal(Number(page.rows[0].product_id),201);
  });
  await t.test('notification failure rolls back the application, so retry cannot leave an invisible orphan',async()=>{
   const before=await counts();const eventCount=events.length;
   const broken=createWarehouseStockTopupService({broadcast:(...e)=>events.push(e),transaction:run=>withMysqlTransaction(c=>run({query:c.query.bind(c),execute:(sql,args)=>sql.includes('INSERT INTO system_notifications')?Promise.reject(new Error('notification persistence failure')):c.execute(sql,args)}))});
   await assert.rejects(broken(body(),session),/notification persistence failure/);
   assert.deepEqual(await counts(),before);assert.equal(events.length,eventCount);
  });
 }finally{await closeMysqlPool();await f.cleanup();}
});
