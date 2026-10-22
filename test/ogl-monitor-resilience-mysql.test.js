import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {createOglDispatchService} from '../src/services/ogl-dispatch.js';

test('OGL monitor rotates past failed records while fresh authority failures stop only their enterprise',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:120000
},async t=>{
  const fixture=await createTenantMysqlFixture('ogl_resilience'),query=fixture.query;
  const pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:fixture.database,connectionLimit:5,timezone:'Z'});
  const calls=[],syncCalls=[];
  const state={listed:[],bad:new Map(),hook:null,afterBatchList:null,syncFailure:null};
  const session={personId:2,tenant:{id:2,slug:'resilience-a'},roles:['operations']};
  const transaction=async work=>{
    const connection=await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result=await work({query:(...args)=>connection.query(...args),execute:async(sql,params=[])=>{
        const result=await connection.execute(sql,params);
        if(state.afterBatchList&&sql.startsWith('SELECT id,default_shop_id FROM ogl_dispatch_batches')) {
          const hook=state.afterBatchList;state.afterBatchList=null;await hook(result[0]);
        }
        return result;
      }});
      await connection.commit();return result;
    } catch(error){await connection.rollback();throw error;}finally{connection.release();}
  };
  const api={
    async deliveryMethods(shop,filter){
      calls.push({shop:Number(shop.id),path:'delivery',day:filter.departure_date});
      return shop.id===20&&filter.departure_date==='2026-10-22'&&state.listed.length?[{
        delivery_method_id:77,departure_date:'2026-10-21T16:00:00Z',carriages:state.listed.map(id=>({id,status:'received',containers_count:1,available_actions:[]}))
      }]:[];
    },
    async request(shop,path,body){
      const carriage=Number(body.carriage_id||body.id),call={shop:Number(shop.id),path,carriage};calls.push(call);
      assert.ok(['/v1/carriage/get','/v2/posting/fbs/act/get-postings','/v2/posting/fbs/act/get-container-labels'].includes(path),'Monitor never creates, approves, edits or dispatches an official application');
      if(state.hook)await state.hook(call);
      if(state.bad.has(carriage))throw Object.assign(new Error('private upstream payload must not reach result'),{statusCode:state.bad.get(carriage),code:'UPSTREAM_ITEM_ERROR'});
      if(path==='/v1/carriage/get')return{carriage_id:carriage,delivery_method_id:77,status:'received',containers_count:1,created_at:'2026-10-22T01:00:00Z',available_actions:[]};
      if(path.endsWith('get-postings'))return{result:[{posting_number:`P-${carriage}`}]};
      return{buffer:Buffer.from('%PDF-mock'),contentType:'application/pdf'};
    }
  };
  const make=()=>createOglDispatchService({transaction,api,now:()=>new Date('2026-10-22T08:00:00Z'),
    extractLabelTracking:async()=>({source:'official_container_label',status:'not_found',tracking_numbers:[]}),
    syncPostings:async(current,shopId,numbers)=>{
      syncCalls.push({tenant:current.tenant.id,shopId,numbers});
      if(state.syncFailure)throw Object.assign(new Error('Authorization revoked'),{statusCode:state.syncFailure});
      return{rows:numbers.map(posting_number=>({posting_number,shop_id:shopId}))};
    }});
  const reset=async()=>{
    for(const table of ['ogl_dispatch_events','ogl_dispatch_members','ogl_dispatch_batches','ogl_dispatch_settings'])await query(`DELETE FROM ${table}`);
    await query("UPDATE tenants SET status='active',subscription_status='active',subscription_expires_at=NULL");
    await query("UPDATE people SET active=1");
    await query("UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY('operations')");
    await query("UPDATE shops SET status='active',ozon_client_id='fixture-client',api_key_hint='fixture-key'");
    await query('INSERT INTO ogl_dispatch_settings(tenant_id,default_shop_id,updated_by) VALUES(2,20,2)');
    state.listed=[];state.bad.clear();state.hook=null;state.afterBatchList=null;state.syncFailure=null;calls.length=0;syncCalls.length=0;
  };
  const seedBatch=async(index,{shop=20,status='approved',metadata=null}={})=>{
    const carriage=1000+index;
    await query(`INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,
      delivery_method_id,departure_date,official_carriage_id,official_status,official_result_json,created_by)
      VALUES(?,2,?,?,?,1,'77','2026-10-22',?,?,?,2)`,[index,`batch-${index}`,`request-${index}`,shop,String(carriage),status,metadata&&JSON.stringify(metadata)]);
    await query(`INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,official_member)
      VALUES(2,?,?,?,?,?,1)`,[index,index,index,shop,`P-${carriage}`]);
  };
  const getCalls=()=>calls.filter(row=>row.path==='/v1/carriage/get');
  const resultA=result=>result.results.find(row=>row.tenant_id===2);
  try {
    for(const tenantId of [2,3]) {
      await query('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)',[tenantId,tenantId===2?'resilience-a':'resilience-b',`Fixture ${tenantId}`]);
      await query("INSERT INTO people(id,name,role) VALUES(?,?,'operator')",[tenantId,`Fixture ${tenantId}`]);
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'member',JSON_ARRAY('operations'))",[tenantId,tenantId]);
    }
    for(const [shopId,tenantId]of [[20,2],[21,2],[30,3]])await query("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(?,?,?,'fixture-client','fixture-key')",[shopId,tenantId,`Fixture shop ${shopId}`]);
    for(let index=1;index<=25;index++) {
      await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,20,?,'awaiting_deliver','2026-10-22 00:00:00')",[index,`P-${1000+index}`]);
      await query("INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES(20,?,'awaiting_deliver',?)",[`P-${1000+index}`,JSON.stringify({delivery_method:{id:77,name:'OGL pickup'}})]);
    }
    for(const status of [404,409,502])await t.test(`a first-batch ${status} leaves a healthy next batch running in two consecutive rounds`,async()=>{
      await reset();await seedBatch(1);await seedBatch(2);state.bad.set(1001,status);const service=make();
      for(let round=0;round<2;round++) {
        calls.length=0;const result=resultA(await service.monitorRecent());
        assert.equal(result.status,'partial');assert.equal(result.failed,1);assert.equal(result.processed,1);
        assert.deepEqual(getCalls().map(row=>row.carriage),[1001,1002]);
        assert.ok(syncCalls.some(row=>row.numbers.includes('P-1002')));
        assert.equal((await service.bootstrap(session)).monitoring.status,'partial');
        assert.match((await service.bootstrap(session)).monitoring.notice,/轮转重试/);
        assert.doesNotMatch(JSON.stringify(result),/private upstream/);
      }
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM ogl_dispatch_members WHERE dispatched_at IS NOT NULL'))[0].n),0);
    });
    await t.test('twenty failed or skipped batches advance the bounded cursor to healthy later batches',async()=>{
      for(const skip of [false,true]) {
        await reset();for(let i=1;i<=21;i++){await seedBatch(i,{status:skip&&i<=20?'creating':'approved'});if(!skip&&i<=20)state.bad.set(1000+i,409);}
        const service=make();const first=resultA(await service.monitorRecent());
        assert.equal(first.processed,0);assert.equal(skip?first.skipped:first.failed,20);
        calls.length=0;const second=resultA(await service.monitorRecent());
        assert.equal(second.processed,1);assert.deepEqual(getCalls().map(row=>row.carriage),[1021]);
      }
    });
    await t.test('a batch removed after candidate selection is an item 404, not an enterprise pause',async()=>{
      await reset();await seedBatch(1);await seedBatch(2);
      state.afterBatchList=async()=>query('DELETE FROM ogl_dispatch_batches WHERE id=1 AND tenant_id=2');
      const result=resultA(await make().monitorRecent());
      assert.equal(result.status,'partial');assert.equal(result.failures[0].status,404);
      assert.deepEqual(getCalls().map(row=>row.carriage),[1002]);
    });
    await t.test('an invalid old batch shop identifier cannot starve a later valid batch or make an external request',async()=>{
      await reset();await seedBatch(1,{shop:0});await seedBatch(2);
      const result=resultA(await make().monitorRecent());
      assert.equal(result.status,'partial');assert.equal(result.processed,1);
      assert.deepEqual(getCalls().map(row=>row.carriage),[1002]);
    });
    await t.test('discovery isolates a first application conflict, retains good imports and reports partial retry in two rounds',async()=>{
      await reset();state.listed=[901,902];state.bad.set(901,409);const service=make();
      for(let round=0;round<2;round++) {
        const result=await service.discover(session,{date:'2026-10-22'});
        assert.equal(result.partial,true);assert.equal(result.failed,1);assert.equal(result.discovered,1);
        assert.equal(result.rows[0].carriage_id,'902');assert.equal(result.failures[0].carriage_id,'901');
        assert.match(result.notice,/成功记录已保留/);assert.doesNotMatch(JSON.stringify(result.failures),/private upstream/);
      }
      const batches=await query('SELECT tenant_id,official_carriage_id,official_status FROM ogl_dispatch_batches');
      assert.equal(batches.length,1);assert.equal(batches[0].tenant_id,2);assert.equal(batches[0].official_status,'observed');
    });
    await t.test('twenty failed discoveries advance the application cursor without a metadata pre-pass',async()=>{
      await reset();state.listed=Array.from({length:23},(_,i)=>901+i);for(let i=901;i<=920;i++)state.bad.set(i,409);
      const service=make();assert.equal(resultA(await service.monitorRecent()).failed,20);
      assert.equal(getCalls().length,20);calls.length=0;
      const result=resultA(await service.monitorRecent());
      assert.equal(getCalls()[0].carriage,921);assert.equal(result.status,'partial');assert.equal(result.processed,3);
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM ogl_dispatch_batches'))[0].n),3);
    });
    for(const [label,sql]of [
      ['role',"UPDATE tenant_members SET business_roles_json=JSON_ARRAY('technical') WHERE tenant_id=2"],
      ['membership','UPDATE tenant_members SET active=0 WHERE tenant_id=2'],
      ['identity','UPDATE people SET active=0 WHERE id=2'],
      ['subscription',"UPDATE tenants SET subscription_status='expired' WHERE id=2"],
      ['expiry',"UPDATE tenants SET subscription_expires_at='2000-01-01' WHERE id=2"],
      ['shop',"UPDATE shops SET status='inactive' WHERE id=20"],
      ['credentials',"UPDATE shops SET ozon_client_id='' WHERE id=20"],
      ['settings','UPDATE ogl_dispatch_settings SET default_shop_id=21 WHERE tenant_id=2'],
      ['saved actor','UPDATE ogl_dispatch_settings SET updated_by=3 WHERE tenant_id=2']
    ])await t.test(`${label} revocation during an otherwise failed first read stops further tenant calls`,async()=>{
      await reset();state.listed=[901,902];state.bad.set(901,404);
      state.hook=async call=>{if(call.path==='/v1/carriage/get'){state.hook=null;await query(sql);}};
      const result=resultA(await make().monitorRecent());
      assert.equal(result.status,'paused');assert.deepEqual(getCalls().map(row=>row.carriage),[901]);
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM ogl_dispatch_batches'))[0].n),0);
    });
    await t.test('revoked historical original shop pauses A but does not block B',async()=>{
      await reset();await query('UPDATE orders SET shop_id=21 WHERE id=1');await seedBatch(1,{shop:21});await seedBatch(2);
      await query('INSERT INTO ogl_dispatch_settings(tenant_id,default_shop_id,updated_by) VALUES(3,30,3)');
      state.hook=async call=>{if(call.shop===21&&call.path==='/v1/carriage/get'){state.hook=null;await query("UPDATE shops SET status='inactive' WHERE id=21");}};
      const service=make(),result=await service.monitorRecent();assert.equal(resultA(result).status,'paused');
      assert.equal(result.results.find(row=>row.tenant_id===3).status,'active');
      assert.ok(!getCalls().some(row=>row.carriage===1002));assert.ok(calls.some(row=>row.shop===30));
      calls.length=0;assert.equal(resultA(await service.monitorRecent()).status,'paused');
      assert.ok(!calls.some(row=>row.shop===20||row.shop===21),'A revoked historical original shop must be rechecked before the next round starts external work');
      await query('UPDATE orders SET shop_id=20 WHERE id=1');
    });
    await t.test('an upstream 403 or denied logistics refresh stops before the next batch',async()=>{
      for(const kind of ['official','logistics']) {
        await reset();await seedBatch(1);await seedBatch(2);
        if(kind==='official')state.bad.set(1001,403);else state.syncFailure=403;
        assert.equal(resultA(await make().monitorRecent()).status,'paused');
        assert.ok(!getCalls().some(row=>row.carriage===1002));
      }
    });
  } finally {await pool.end();await fixture.cleanup();}
});
