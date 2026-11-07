import assert from 'node:assert/strict';
import test from 'node:test';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {createOrderFixtureSchema,loadTenantOrderService} from './helpers/tenant-order-service.js';

test('marked pending orders stay exclusively waiting; clearing the type releases them and preserves real dispatch and tenant scope',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL'},async()=>{
 const fixture=await createTenantMysqlFixture('order_mark_hold');
 try{
  await createOrderFixtureSchema(fixture.connection);const {service,query}=loadTenantOrderService(fixture.connection);
  await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
  await query("INSERT INTO shops(id,tenant_id,name) VALUES(20,2,'A'),(30,3,'B')");
  await query("INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,official_carriage_id,official_status,created_by) VALUES(1,2,'A','request-a',20,1,'901','observed',1)");
  for(const [id,status,marked,physical,shop] of [[1,'awaiting_packaging',true,false,20],[2,'awaiting_deliver',true,false,20],[3,'awaiting_deliver',true,true,20],[4,'delivering',true,false,20],[5,'cancelled',true,false,20],[6,'awaiting_deliver',false,false,20],[7,'awaiting_packaging',true,false,30]]){
   await query('INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,?,?)',[id,shop,'MARK-'+id,status,'2026-11-01 00:00:00']);
   if(marked)await query("INSERT INTO order_marks(order_id,mark_type,note) VALUES(?,'follow','保留备注')",[id]);
   if([2,3,6].includes(id)){
    await query("INSERT INTO order_label_prints(order_id,printed_at) VALUES(?,'2026-11-01 01:00:00')",[id]);
    await query('INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,official_member,dispatched_at) VALUES(2,1,?,?,20,?,1,?)',[id,id,'MARK-'+id,physical?'2026-11-01 02:00:00':null]);
   }
  }
  const list=(status,tenant='2')=>service.ordersPagedMysql({status,includeRows:'0',includeLogisticsOptions:'0'},tenant);
  let result=await list('awaiting_deliver');assert.equal(result.total,4);assert.equal(result.counts.awaiting_deliver,4);assert.equal(result.counts.awaiting_packaging,0);assert.equal(result.counts.ogl_bound,1);assert.equal(result.counts.ogl_dispatched,1);assert.equal(result.counts.delivering,1);assert.equal(result.counts.cancelled,1);
  assert.equal((await list('awaiting_deliver','3')).total,1,'Foreign marked order stays in its own enterprise');
  await service.updateOrderMarkMysql(2,{mark_type:'',note:'保留备注'},null,'2');
  result=await list('ogl_bound');assert.equal(result.total,2);assert.equal(result.counts.awaiting_deliver,4);
  assert.equal((await query('SELECT note FROM order_marks WHERE order_id=2'))[0].note,'保留备注','A note alone must not keep the order held after no mark');
  await service.updateOrderMarkMysql(1,{mark_type:'',note:''},null,'2');
  result=await list('awaiting_packaging');assert.equal(result.total,1);assert.equal(result.counts.awaiting_deliver,3);
  await assert.rejects(service.updateOrderMarkMysql(7,{mark_type:'',note:''},null,'2'),{statusCode:404});
 }finally{await fixture.cleanup();}
});
