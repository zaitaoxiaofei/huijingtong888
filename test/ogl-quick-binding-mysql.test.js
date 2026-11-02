import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {createOglDispatchService} from '../src/services/ogl-dispatch.js';

test('quick today binding selects every clear owned printed OGL order and revalidates atomically without shipping',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL'},async()=>{
 const f=await createTenantMysqlFixture('ogl_quick'),q=f.query,pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:f.database,timezone:'Z'});
 const transaction=async fn=>{const c=await pool.getConnection();try{await c.beginTransaction();const r=await fn(c);await c.commit();return r;}catch(e){await c.rollback();throw e;}finally{c.release();}};
 let date=new Date('2026-11-02T03:00:00Z'),remoteStatus='formed';const enriched=[],apiCalls=[];
 const svc=createOglDispatchService({transaction,now:()=>date,loadOrderRows:async ids=>{enriched.push(ids);return ids.map(id=>({id,sku_names:'SKU:Test'}));},api:{async request(shop,path){apiCalls.push(path);assert.equal(shop.id,20);if(path==='/v1/carriage/get')return{status:remoteStatus,carriage_id:901};if(path==='/v2/posting/fbs/act/get-postings')return{result:[]};assert.fail('Quick binding must never mutate Ozon: '+path);}}});
 const session={personId:2,tenant:{id:2,slug:'quick-2'}};
 try{
  for(const n of [2,3]){await q('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)',[n,'quick-'+n,'Quick '+n]);await q("INSERT INTO people(id,name,role) VALUES(?,?,'packing')",[n,'Packer '+n]);await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'admin',JSON_ARRAY('packing'))",[n,n]);}
  for(const [id,tenant] of [[20,2],[21,2],[30,3]])await q("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(?,?,?,'fixture','fixture')",[id,tenant,'Shop '+id]);
  for(let id=1;id<=36;id++){
   const shop=id===12?30:id===36?21:20,status=id===8?'cancelled':'awaiting_deliver';
   await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,?,'2026-11-01 01:00:00')",[id,shop,'QUICK-'+id,status]);
   if(id!==5)await q('INSERT INTO order_label_prints(order_id,printed_at) VALUES(?,?)',[id,id===1?'2026-11-01 15:59:59':id===3?'2026-11-02 15:59:59':id===4?'2026-11-02 16:00:00':'2026-11-01 16:00:00']);
   await q('INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES(?,?,?,?)',[shop,'QUICK-'+id,status,JSON.stringify({status,delivery_method:{name:id===9?'CEL Extra Small':id===10?'FBP':'OGL Extra Small'},...(id===10?{fulfillment_schema:'fbp'}:{})})]);
  }
  await q("INSERT INTO order_marks(order_id,mark_type,note) VALUES(6,'follow',''),(7,'','客户备注')");
  for(const [id,carriage] of [[1,'901'],[2,'902']])await q("INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,status,official_status,official_carriage_id,created_by) VALUES(?,2,?,?,20,1,'preparing','observed',?,2)",[id,'QUICK-BATCH-'+id,'quick-batch-'+id,carriage]);
  await q("INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number) VALUES(2,2,11,11,20,'QUICK-11')");
  const result=await svc.candidates(session,{selection:'today-clear',printed_from:'2020-01-01',printed_to:'2030-01-01',binding:'all',review:'all',batch_id:2,page_size:100});
  assert.equal(result.selection_date,'2026-11-02');assert.equal(result.selection_rows.length,26);assert.equal(result.rows.length,20);assert.equal(enriched.length,0,'Quick selection must not calculate profits or inventory for its lightweight order list');
  assert.deepEqual(result.selection_rows.map(r=>r.id).sort((a,b)=>a-b),[2,3,...Array.from({length:24},(_,i)=>i+13)]);
  assert.ok(result.selection_rows.every(row=>!row.raw_json&&!row.active_batch_id&&!row.needs_review));
  assert.equal((await q('SELECT * FROM ogl_dispatch_members')).length,1,'Selection must not create membership');
  const body={action:'quick-bind-orders',batch_id:1,order_ids:[2,13,36],client_request_id:'quick-request-1',printed_date:result.selection_date};
  await q("INSERT INTO order_marks(order_id,mark_type,note) VALUES(13,'urgent','')");
  await assert.rejects(svc.action(session,body),/增加标记/);assert.equal((await q('SELECT * FROM ogl_dispatch_members WHERE batch_id=1')).length,0);
  await q('DELETE FROM order_marks WHERE order_id=13');
  await assert.rejects(svc.action(session,{...body,order_ids:[2,12]}),/不能绑定/);
  await assert.rejects(svc.action(session,{...body,order_ids:[2,11]}),/不能绑定/);
  await assert.rejects(svc.action(session,{...body,printed_date:'2026-11-01'}),/日期/);
  remoteStatus='cancelled';await assert.rejects(svc.action(session,body),/取消/);remoteStatus='received';await assert.rejects(svc.action(session,body),/历史/);remoteStatus='formed';
  const bound=await svc.action(session,body);assert.equal(bound.members.length,3);assert.ok(bound.members.every(r=>!r.dispatched_at&&r.official_member===0));
  const events=(await q('SELECT * FROM ogl_dispatch_events')).length;await svc.action(session,body);assert.equal((await q('SELECT * FROM ogl_dispatch_events')).length,events);
  await assert.rejects(svc.action(session,{...body,action:'bind-orders'}),/同一操作标识/);
  date=new Date('2026-11-02T16:00:01Z');await assert.rejects(svc.action(session,{...body,order_ids:[3],client_request_id:'quick-next-day'}),/日期/);
  assert.ok(apiCalls.every(path=>['/v1/carriage/get','/v2/posting/fbs/act/get-postings'].includes(path)));
 }finally{await pool.end();await f.cleanup();}
});
