import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOglDispatchService } from '../src/services/ogl-dispatch.js';
import { unchangedOglObservation } from '../src/services/ogl-refresh-events.js';

test('only identical observations collapse; physical and financial/business actions are always separate',()=>{
  assert.equal(unchangedOglObservation('refresh',{results:[{ok:true,order_id:1}]},{results:[{order_id:1,ok:true}]}),true);
  assert.equal(unchangedOglObservation('refresh','invalid',{results:[]}),false);
  assert.equal(unchangedOglObservation('official-sync',null,{}),false);
  assert.equal(unchangedOglObservation('official-sync',{status:'approved'},{status:'mismatch'}),false);
  for(const action of ['create','dispatch','withdraw','assign','official-confirm-start','official-create-start','close']) {
    assert.equal(unchangedOglObservation(action,{},{}),false,action);
  }
});

test('real SQL observation retries/restarts/concurrency keep freshness and changed evidence without unlimited event copies',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:120000
},async t=>{
  const f=await createTenantMysqlFixture('ogl_observations');
  const pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:f.database,connectionLimit:4,timezone:'Z'});
  const transaction=async work=>{const c=await pool.getConnection();try{await c.beginTransaction();const result=await work(c);await c.commit();return result;}catch(e){await c.rollback();throw e;}finally{c.release();}};
  const q=f.query,session={personId:2,tenant:{id:2,slug:'observe-a'}},foreign={personId:3,tenant:{id:3,slug:'observe-b'}};
  let clock=new Date('2026-10-22T01:00:00Z'),count=1,state='formed',fail=false;
  const calls=[];
  const api={request:async(_shop,path)=>{
    calls.push(path);assert.ok(['/v1/carriage/get','/v2/posting/fbs/act/get-postings'].includes(path));
    if(path.endsWith('/get'))return{carriage_id:901,status:state,containers_count:count,delivery_method_id:77,available_actions:['get_label_containers']};
    return{result:[{posting_number:'POST-A'}]};
  }};
  const make=()=>createOglDispatchService({transaction,api,now:()=>clock,syncPostings:async(_s,shopId,numbers)=>{
    if(fail)throw new Error('Simulated own-shop timeout');
    return{rows:numbers.map(posting_number=>({posting_number,shop_id:shopId}))};
  }});
  const n=async action=>Number((await q('SELECT COUNT(*) n FROM ogl_dispatch_events WHERE tenant_id=2 AND batch_id=1 AND action=?',[action]))[0].n);
  try{
    await q("INSERT INTO tenants(id,slug,name) VALUES(2,'observe-a','A'),(3,'observe-b','B')");
    await q("INSERT INTO people(id,name,role) VALUES(2,'A','operator'),(3,'B','operator')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,2,'member',JSON_ARRAY('operations')),(3,3,'member',JSON_ARRAY('operations'))");
    await q("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(20,2,'A','fixture-client','fixture-key'),(30,3,'B','fixture-client','fixture-key')");
    await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(1,20,'POST-A','awaiting_deliver','2026-10-21')");
    await q("INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES(20,'POST-A','awaiting_deliver',?)",[JSON.stringify({posting_number:'POST-A',status:'awaiting_deliver',delivery_method:{id:77,name:'OGL pickup'}})]);
    await q(`INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,status,
      delivery_method_id,departure_date,official_carriage_id,official_status,created_by)
      VALUES(1,2,'fixture','fixture',20,1,'ready','77','2026-10-22','901','approved',2)`);
    await q("INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,official_member) VALUES(2,1,1,1,20,'POST-A',1)");
    let service=make();
    await service.action(session,{batch_id:1,action:'official-sync'});
    assert.equal(await n('official-sync'),1);
    clock=new Date('2026-10-22T02:00:00Z');
    await Promise.all(Array.from({length:5},()=>service.action(session,{batch_id:1,action:'official-sync'})));
    service=make();await service.action(session,{batch_id:1,action:'official-sync'});
    assert.equal(await n('official-sync'),1,'concurrent callers and a new service instance do not add unchanged events');
    const raw=(await q('SELECT official_result_json FROM ogl_dispatch_batches WHERE id=1'))[0].official_result_json;
    const saved=typeof raw==='string'?JSON.parse(raw):raw;
    assert.equal(saved.last_observed_at,clock.toISOString(),'latest official check is still saved');
    count=2;await service.action(session,{batch_id:1,action:'official-sync'});
    assert.equal(await n('official-sync'),2,'changed container evidence is recorded even if it changes only mismatch details');
    await service.action(session,{batch_id:1,action:'official-sync'});assert.equal(await n('official-sync'),2);
    count=1;await service.action(session,{batch_id:1,action:'official-sync'});assert.equal(await n('official-sync'),3,'A to B to A is a genuine change');
    await service.action(session,{batch_id:1,action:'refresh'});assert.equal(await n('refresh'),1);
    clock=new Date('2026-10-22T03:00:00Z');
    await Promise.all(Array.from({length:4},()=>service.action(session,{batch_id:1,action:'refresh'})));
    assert.equal(await n('refresh'),1);
    assert.equal((await q("SELECT DATE_FORMAT(last_refreshed_at,'%Y-%m-%dT%H:%i:%s.000Z') AS checked_at FROM ogl_dispatch_batches WHERE id=1"))[0].checked_at,clock.toISOString());
    fail=true;await service.action(session,{batch_id:1,action:'refresh'});assert.equal(await n('refresh'),2);
    await service.action(session,{batch_id:1,action:'refresh'});assert.equal(await n('refresh'),2,'same failure does not grow an unbounded log');
    fail=false;await service.action(session,{batch_id:1,action:'refresh'});assert.equal(await n('refresh'),3,'recovery remains an event');
    const before=calls.length;await assert.rejects(service.action(foreign,{batch_id:1,action:'official-sync'}),{statusCode:404});assert.equal(calls.length,before);
    await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
    await assert.rejects(service.action(session,{batch_id:1,action:'refresh'}),{statusCode:403});
    assert.equal(await n('refresh'),3);
    t.diagnostic('Repeated official checks: 8 requests -> 1 unchanged event; repeated logistics checks: 5 requests -> 1 unchanged event. No official create/approve/dispatch calls.');
  }finally{await pool.end();await f.cleanup();}
});
