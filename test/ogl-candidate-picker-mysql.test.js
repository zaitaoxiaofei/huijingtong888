import assert from 'node:assert/strict';import test from 'node:test';import mysql from 'mysql2/promise';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';import {createOglDispatchService} from '../src/services/ogl-dispatch.js';
test('OGL picker filters before pagination, exposes exclusion reasons and enriches only visible authorized orders',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:120000},async t=>{
 const fixture=await createTenantMysqlFixture('ogl_picker'),q=fixture.query,pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:fixture.database,connectionLimit:4,timezone:'Z'});
 const transaction=async fn=>{const c=await pool.getConnection();try{await c.beginTransaction();const r=await fn(c);await c.commit();return r;}catch(e){await c.rollback();throw e;}finally{c.release();}};
 const session={personId:2,tenant:{id:2,slug:'picker-2'}},enriched=[];let revoke=false;
 const service=createOglDispatchService({transaction,now:()=>new Date('2026-10-31T02:00:00Z'),api:{request:()=>assert.fail('Picker must not call Ozon')},loadOrderRows:async(ids,tenant)=>{enriched.push({ids,tenant});if(revoke)await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2');return ids.map(id=>({id,skus:'SKU-'+id,sku_quantities:'SKU-'+id+':1',sku_names:'SKU-'+id+':测试商品',revenue:12,raw_json:{customer:'must-not-return'}}));}});
 try{
  for(const n of [2,3]){await q('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)',[n,'picker-'+n,'Picker '+n]);await q("INSERT INTO people(id,name,role) VALUES(?,?,'packing')",[n,'Picker '+n]);await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'admin',JSON_ARRAY('packing'))",[n,n]);await q("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(?,?,?,'fixture','fixture')",[n*10,n,'Picker shop '+n]);}
  for(let id=1;id<=40;id++){
   const status=id>35?'delivering':'awaiting_deliver';await q('INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,20,?,?,?)',[id,'PICKER-'+id,status,'2026-10-29 02:00:00']);
   await q('INSERT INTO order_label_prints(order_id,printed_at) VALUES(?,?)',[id,id<=6?'2026-10-30 00:00:00':'2026-10-30 06:00:00']);
   const raw={status,delivery_method:{name:id>6&&id<=35?'CEL Extra Small':'OGL Extra Small'}};
   await q('INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES(20,?,?,?)',['PICKER-'+id,status,JSON.stringify(id===4?{raw}:raw)]);
  }
  await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(900,30,'FOREIGN','awaiting_deliver','2026-10-29 02:00:00')");await q("INSERT INTO order_label_prints(order_id,printed_at) VALUES(900,'2026-10-30 00:00:00')");
  const query={printed_from:'2026-10-30',printed_to:'2026-10-30',page_size:20};
  await t.test('the six eligible orders are on the first page even when thirty-four newer printed rows are ineligible',async()=>{
   const r=await service.candidates(session,query);assert.equal(r.total,6);assert.deepEqual(r.summary,{matched:40,eligible:6,rejected:34});assert.deepEqual(r.rows.map(row=>row.id),[6,5,4,3,2,1]);assert.ok(r.rows.every(row=>row.can_select&&row.order_details_loaded&&row.skus&&!row.raw_json));
   assert.deepEqual(enriched.at(-1),{ids:[6,5,4,3,2,1],tenant:2});assert.equal(r.rejection_summary.find(row=>row.code==='NON_OGL').count,29);assert.equal(r.rejection_summary.find(row=>row.code==='NOT_WAITING').count,5);
  });
  await t.test('all and rejected views keep visible nonselectable rows and correct per-view totals',async()=>{
   const all=await service.candidates(session,{...query,eligibility:'all'});assert.equal(all.total,40);assert.equal(all.rows.length,20);assert.ok(all.rows.every(row=>row.blocked&&row.reason));
   const blocked=await service.candidates(session,{...query,eligibility:'rejected',page:2});assert.equal(blocked.total,34);assert.equal(blocked.rows.length,14);assert.ok(blocked.rows.every(row=>!row.can_select&&row.reason));
   assert.equal((await service.candidates(session,{...query,page:2})).rows.length,0);assert.ok(!enriched.some(call=>call.ids.includes(900)));await assert.rejects(service.candidates(session,{...query,shop_id:30}),/不属于/);
  });
  await t.test('foreign status changes during enrichment discard the response rather than leaking a stale result',async()=>{revoke=true;await assert.rejects(service.candidates(session,query),{statusCode:403});await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2');revoke=false;});
 }finally{await pool.end();await fixture.cleanup();}
});
