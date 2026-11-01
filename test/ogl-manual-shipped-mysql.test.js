import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {createOglDispatchService} from '../src/services/ogl-dispatch.js';
import {withOglDispatch,oglDispatchedStatusSql} from '../src/services/ogl-dispatch-state.js';

test('order-page manual dispatch is atomic, idempotent, scoped and never claims official membership', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL'},async()=>{
 const f=await createTenantMysqlFixture('ogl_manual'),q=f.query;
 const pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:f.database,timezone:'Z'});
 const transaction=async fn=>{const c=await pool.getConnection();try{await c.beginTransaction();const r=await fn(c);await c.commit();return r;}catch(e){await c.rollback();throw e;}finally{c.release();}};
 const session={personId:2,tenant:{id:2,slug:'manual-2'}};let remoteStatus='closed';
 const api={async request(shop,path){assert.equal(shop.id,20);if(path==='/v1/carriage/get')return {status:remoteStatus,carriage_id:901};if(path==='/v2/posting/fbs/act/get-postings')return {result:[]};assert.fail(path);}};
 const svc=createOglDispatchService({transaction,api});
 try{
  for(const n of [2,3]){
   await q('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)',[n,'manual-'+n,'Manual '+n]);
   await q("INSERT INTO people(id,name,role) VALUES(?,?,'packing')",[n,'Packer '+n]);
   await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'admin',JSON_ARRAY('packing'))",[n,n]);
   await q("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(?,?,?,'fixture','fixture')",[n*10,n,'Shop '+n]);
  }
  for(const [id,shop] of [[1,20],[2,20],[3,30],[4,20]]){
   await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,'awaiting_deliver','2026-11-01 01:00:00')",[id,shop,'MANUAL-'+id]);
   await q('INSERT INTO order_label_prints(order_id) VALUES(?)',[id]);
   await q("INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES(?,?,'awaiting_deliver',?)",[shop,'MANUAL-'+id,JSON.stringify({status:'awaiting_deliver',delivery_method:{name:'OGL Extra Small'}})]);
  }
  await q("INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,status,official_status,official_carriage_id,created_by) VALUES(1,2,'MANUAL-BATCH','manual-batch',20,1,'closed','observed','901',2)");
  const body={batch_id:1,action:'manual-ship-orders',order_ids:[1,2],client_request_id:'manual-request',confirm_dispatched:true};
  await assert.rejects(svc.action(session,{...body,confirm_dispatched:false}),/确认/);
  await assert.rejects(svc.action(session,{...body,order_ids:[1,3]}),/不能绑定/);
  assert.equal((await q('SELECT * FROM ogl_dispatch_members')).length,0);
  remoteStatus='cancelled';await assert.rejects(svc.action(session,body),/取消/);remoteStatus='closed';
  const result=await svc.action(session,body);
  assert.equal(result.members.length,2);
  assert.ok(result.members.every(row=>row.dispatched_at&&row.dispatched_by===2&&row.official_member===0&&row.dispatch_source==='manual'));
  const count=(await q('SELECT * FROM ogl_dispatch_events')).length;
  await svc.action(session,body);assert.equal((await q('SELECT * FROM ogl_dispatch_events')).length,count);
  await assert.rejects(svc.action(session,{...body,order_ids:[4]}),/同一操作标识/);
  assert.equal((await q(`SELECT id FROM orders o WHERE ${oglDispatchedStatusSql('o')}`)).length,2);
  const row=result.members[0],display=withOglDispatch({id:row.order_id,status:'awaiting_deliver',logistics_carrier:'ogl'},row);
  assert.equal(display.display_status,'ogl_dispatched');assert.equal(display.ogl_dispatch.manually_marked,true);
  assert.equal(display.ogl_dispatch.association_type,'system');
  assert.equal((await q('SELECT status FROM orders WHERE id=1'))[0].status,'awaiting_deliver');
 }finally{await pool.end();await f.cleanup();}
});
