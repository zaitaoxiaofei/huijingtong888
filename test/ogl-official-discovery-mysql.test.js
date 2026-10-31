import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createOglDispatchService } from '../src/services/ogl-dispatch.js';
import { withOglDispatch, oglBoundStatusSql, oglDispatchedStatusSql, oglPhysicalDispatchSql } from '../src/services/ogl-dispatch-state.js';

test('official discovery and scheduler retain tenant/original-shop authority without physical handover',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:120000
},async t=>{
  const fixture=await createTenantMysqlFixture('ogl_discovery');const query=fixture.query;
  const pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:fixture.database,connectionLimit:5,timezone:'Z'});
  let switchAfterFinalList=false;
  const transaction=async fn=>{const connection=await pool.getConnection();try{await connection.beginTransaction();
    const wrapped={query:(...args)=>connection.query(...args),execute:async(sql,params=[])=>{
      const result=await connection.execute(sql,params);
      if(switchAfterFinalList&&sql.includes('FROM ogl_dispatch_batches b WHERE b.tenant_id = ?')) {
        switchAfterFinalList=false;await connection.execute('UPDATE ogl_dispatch_settings SET default_shop_id=21 WHERE tenant_id=2');
      }
      return result;
    }};
    const result=await fn(wrapped);await connection.commit();return result;}catch(error){await connection.rollback();throw error;}finally{connection.release();}};
  const session=tenantId=>({personId:tenantId,roles:['operations'],tenant:{id:tenantId,slug:tenantId===1?'default':`discovery-${tenantId}`,role:'member'}});
  const calls=[],syncCalls=[];let hook=null;let labelError=false;
  const manifests=new Map([[10,['LEGACY']],[20,['OWN','OTHER-SHOP','FOREIGN','MISSING']],[30,['FOREIGN']]]);
  const statuses=new Map();
  const api={
    async deliveryMethods(shop,filter){calls.push({shop:Number(shop.id),path:'delivery',filter});
      return filter.departure_date==='2026-10-22'&&manifests.has(Number(shop.id))?[{delivery_method_id:77,departure_date:'2026-10-21T16:00:00Z',carriages:[{id:901,status:statuses.get(Number(shop.id))||'received',containers_count:1,available_actions:['get_label_containers','get_barcode']}]}]:[];
    },
    async request(shop,path,body,options){calls.push({shop:Number(shop.id),path,body,options});
      assert.ok(['/v1/carriage/get','/v2/posting/fbs/act/get-postings','/v2/posting/fbs/act/get-container-labels','/v2/posting/fbs/act/get-barcode'].includes(path),'Discovery never creates, approves or changes Ozon');
      if(hook)await hook(path,shop);
      if(path==='/v1/carriage/get')return {carriage_id:901,delivery_method_id:77,status:statuses.get(Number(shop.id))||'received',containers_count:1,created_at:'2026-10-22T07:21:15.322672Z',available_actions:['get_label_containers','get_barcode'],phone:'private-phone'};
      if(path.endsWith('get-postings'))return {result:(manifests.get(Number(shop.id))||[]).map(posting_number=>({posting_number,customer:{name:'private-name'}}))};
      if(labelError)throw new Error('private-label-error');
      return {buffer:Buffer.from('%PDF-fixture'),contentType:'application/pdf'};
    }
  };
  const make=()=>createOglDispatchService({transaction,api,now:()=>new Date('2026-10-22T08:00:00Z'),
    extractLabelTracking:async()=>({source:'official_container_label',status:'found',carrier_name:'Fixture carrier',tracking_numbers:['YT3000000000001'],master_tracking_number:'YT3000000000001'}),
    syncPostings:async(current,shopId,numbers)=>{syncCalls.push({tenant:Number(current.tenant.id),person:current.personId,shopId,numbers});return {rows:numbers.map(posting_number=>({posting_number,shop_id:shopId}))};}});
  const service=make();let batchId;
  const evidence=async orderId=>(await query(`SELECT (${oglBoundStatusSql('o')} OR ${oglDispatchedStatusSql('o')}) AS tracking,${oglPhysicalDispatchSql('o')} AS physical FROM orders o WHERE id=?`,[orderId]))[0];
  try {
    for(const tenantId of [1,2,3]) {
      await query('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)',[tenantId,tenantId===1?'default':`discovery-${tenantId}`,`Fixture ${tenantId}`]);
      await query("INSERT INTO people(id,name,role) VALUES(?,?,'operator')",[tenantId,`Fixture ${tenantId}`]);
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'member',JSON_ARRAY('operations'))",[tenantId,tenantId]);
    }
    for(const [shopId,tenantId] of [[10,null],[20,2],[21,2],[30,3]])await query("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(?,?,?,'fixture-client','fixture-key')",[shopId,tenantId,`Fixture shop ${shopId}`]);
    for(const [orderId,shopId,posting] of [[1,20,'OWN'],[2,21,'OTHER-SHOP'],[3,30,'FOREIGN'],[4,10,'LEGACY']]) {
      await query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,'awaiting_deliver','2026-10-22 00:30:00')",[orderId,shopId,posting]);
      await query("INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES(?,?,'awaiting_deliver',?)",[shopId,posting,JSON.stringify({delivery_method:{id:77,name:'OGL pickup'}})]);
    }
    for(const [tenantId,shopId] of [[1,10],[2,20],[3,30]])await query('INSERT INTO ogl_dispatch_settings(tenant_id,default_shop_id,updated_by) VALUES(?,?,?)',[tenantId,shopId,tenantId]);
    await t.test('same official ID imports only exact original-shop orders, real dates and reliable label identifiers',async()=>{
      const start=calls.length;await assert.rejects(service.discover(session(2),{date:'2026-10-22',shop_id:30}),{statusCode:409});assert.equal(calls.length,start);
      const result=await service.discover(session(2),{date:'2026-10-22',tenant_id:3,shop_id:20,actor_id:3},{readTracking:true});
      batchId=result.rows[0].batch_id;assert.ok(batchId);assert.equal(result.rows[0].created_at,'2026-10-22T07:21:15.322672Z');
      assert.equal(result.rows[0].master_tracking_number,'YT3000000000001');assert.ok(calls.slice(start).every(row=>row.shop===20));
      const detail=await service.detail(session(2),batchId);
      assert.equal(detail.batch.official_status,'observed');assert.equal(detail.batch.status,'preparing');assert.equal(detail.batch.created_by,2);
      assert.equal(detail.members.length,1);assert.equal(detail.members[0].order_id,1);assert.equal(detail.members[0].dispatched_at,null);assert.match(detail.members[0].order_path,/orderId=1.*shopId=20/);
      assert.equal(detail.batch.official_result.source,'official_discovery');assert.ok(!/private-phone|private-name|fixture-key/.test(JSON.stringify(detail)));
      assert.equal(Number((await evidence(1)).tracking),1);assert.equal(Number((await evidence(1)).physical),0);
      const member={...detail.members[0],default_shop_id:20,official_carriage_id:'901',official_status:'observed',batch_status:'preparing'};
      const state=withOglDispatch({id:1,shop_id:20,status:'awaiting_deliver',logistics_carrier:'ogl'},member);
      assert.equal(state.ogl_dispatch.tracking,true);assert.equal(state.ogl_dispatch.applied,true);assert.equal(state.ogl_dispatch.dispatched,false);assert.equal(state.ogl_dispatch.stage,'bound');
      assert.equal(withOglDispatch({...state,status:'delivered'},member).display_status,'delivered');
      await assert.rejects(service.detail(session(3),batchId),{statusCode:404});
      const other=await service.discover(session(3),{date:'2026-10-22'});assert.notEqual(other.rows[0].batch_id,batchId);
      const legacy=await service.discover(session(1),{date:'2026-10-22'});assert.equal((await service.detail(session(1),legacy.rows[0].batch_id)).members[0].order_id,4);
    });
    await t.test('snapshot SQL isolates A/B/default NULL, original shops, dates and poisoned references with no external request',async()=>{
      const offset=calls.length;
      for(const [tenantId,orderId] of [[1,4],[2,1],[3,3]]) {
        const list=await service.listOfficial(session(tenantId),{source:'snapshot',date:'2026-10-22',tenant_id:3});
        assert.equal(list.total,1);assert.equal(list.rows[0].carriage_id,'901');assert.equal(list.source,'snapshot');
        const detail=await service.officialDetail(session(tenantId),{source:'snapshot',date:'2026-10-22',id:901,tenant_id:3});
        assert.equal(detail.members.find(row=>row.matched_local).order_id,orderId);assert.equal(detail.members_complete,true);
        assert.equal(detail.members.filter(row=>row.matched_local).length,1);
      }
      await query("INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,dispatched_at) VALUES(2,?,3,3,30,'FOREIGN',UTC_TIMESTAMP())",[batchId]);
      let list=await service.listOfficial(session(2),{source:'snapshot',date:'2026-10-22'});assert.equal(list.rows[0].dispatch_stage,'applied','A poisoned foreign member cannot supply physical stage');
      let detail=await service.officialDetail(session(2),{source:'snapshot',date:'2026-10-22',id:901});assert.equal(detail.members.find(row=>row.posting_number==='FOREIGN').order_id,null);
      await query('DELETE FROM ogl_dispatch_members WHERE tenant_id=2 AND order_id=3');
      await query("INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,dispatched_at) VALUES(2,?,2,2,21,'OTHER-SHOP',UTC_TIMESTAMP())",[batchId]);
      list=await service.listOfficial(session(2),{source:'snapshot',date:'2026-10-22'});detail=await service.officialDetail(session(2),{source:'snapshot',date:'2026-10-22',id:901});
      assert.equal(list.rows[0].dispatch_stage,'dispatched');assert.equal(detail.carriage.dispatch_stage,'dispatched','A real same-enterprise mixed-shop handover has one consistent stage');
      await query('DELETE FROM ogl_dispatch_members WHERE tenant_id=2 AND order_id=2');
      const saved=(await query('SELECT official_result_json FROM ogl_dispatch_batches WHERE id=?',[batchId]))[0].official_result_json;
      const ownOther={...saved,carriage:{...saved.carriage,carriage_id:'901'},official_posting_numbers:[]};
      const [extra]=await fixture.connection.execute("INSERT INTO ogl_dispatch_batches(tenant_id,batch_number,client_request_id,default_shop_id,containers_count,official_carriage_id,official_status,delivery_method_id,departure_date,official_result_json,created_by) VALUES(2,'Snapshot-other-shop','snapshot-other-shop',21,1,'901','observed','77','2026-10-22',?,2)",[JSON.stringify(ownOther)]);
      await query('UPDATE ogl_dispatch_settings SET default_shop_id=21 WHERE tenant_id=2');
      list=await service.listOfficial(session(2),{source:'snapshot',date:'2026-10-22',shop_id:21});assert.equal(list.rows[0].batch_id,extra.insertId);assert.notEqual(list.rows[0].batch_id,batchId);
      detail=await service.officialDetail(session(2),{source:'snapshot',date:'2026-10-22',id:901});assert.equal(detail.members.length,0);assert.equal(detail.dispatch_shop.id,21);
      await query('UPDATE ogl_dispatch_settings SET default_shop_id=20 WHERE tenant_id=2');await query('DELETE FROM ogl_dispatch_batches WHERE id=?',[extra.insertId]);
      for(const [number,departure] of [['902','2026-12-31T16:00:00Z'],['903','2026-12-30T16:00:00Z']]) {
        const metadata={...saved,carriage:{...saved.carriage,carriage_id:number,id:number,departure_date:undefined},official_posting_numbers:[]};
        await query("INSERT INTO ogl_dispatch_batches(tenant_id,batch_number,client_request_id,default_shop_id,containers_count,official_carriage_id,official_status,delivery_method_id,departure_date,official_result_json,created_by) VALUES(2,?,?,20,1,?,'observed','77',?,?,2)",[`Snapshot-${number}`,`snapshot-${number}`,number,departure,JSON.stringify(metadata)]);
      }
      list=await service.listOfficial(session(2),{source:'snapshot',date_from:'2026-12-31',date_to:'2027-01-01'});assert.deepEqual(list.rows.map(row=>row.carriage_id),['902','903']);
      assert.equal((await service.listOfficial(session(2),{source:'snapshot',date:'2027-01-01'})).total,1);
      await query("DELETE FROM ogl_dispatch_batches WHERE tenant_id=2 AND official_carriage_id IN ('902','903')");
      assert.equal(calls.length,offset,'All snapshot list/detail/tenant/date checks use zero Ozon reads');
    });
    await t.test('every saved snapshot hit rechecks role, membership and subscription, and interactive refresh cannot request PDF via body',async()=>{
      for(const [revoke,restore] of [["UPDATE tenant_members SET business_roles_json=JSON_ARRAY('technical') WHERE tenant_id=2","UPDATE tenant_members SET business_roles_json=JSON_ARRAY('operations') WHERE tenant_id=2"],["UPDATE tenant_members SET active=0 WHERE tenant_id=2","UPDATE tenant_members SET active=1 WHERE tenant_id=2"],["UPDATE tenants SET subscription_status='expired' WHERE id=2","UPDATE tenants SET subscription_status='active' WHERE id=2"]]) {
        await service.listOfficial(session(2),{source:'snapshot',date:'2026-10-22'});await query(revoke);const offset=calls.length;
        await assert.rejects(service.listOfficial(session(2),{source:'snapshot',date:'2026-10-22'}),{statusCode:403});
        await assert.rejects(service.officialDetail(session(2),{source:'snapshot',id:901,date:'2026-10-22'}),{statusCode:403});assert.equal(calls.length,offset);await query(restore);
      }
      const offset=calls.length;await service.discover(session(2),{date:'2026-10-22',source:'snapshot',readTracking:true,options:{readTracking:true}});
      assert.ok(!calls.slice(offset).some(row=>row.path.endsWith('get-container-labels')),'Client body cannot opt into internal PDF work');
      const list=await service.listOfficial(session(2),{source:'snapshot',date:'2026-10-22'});assert.equal(list.rows[0].master_tracking_number,'YT3000000000001','Interactive refresh preserves previously verified label identifiers');
    });
    await t.test('explicit shop sync works without default settings, all-shop snapshots retain exact identities and fresh authority',async()=>{
      const settings=await query('SELECT * FROM ogl_dispatch_settings ORDER BY tenant_id');
      const savedSettings=settings.find(row=>row.tenant_id===2);let extraBatchId;
      manifests.set(21,['OTHER-SHOP']);await query('DELETE FROM ogl_dispatch_settings WHERE tenant_id=2');
      try {
        assert.equal((await service.listOfficial(session(2),{source:'snapshot',date:'2026-10-22'})).total,1,'Saved enterprise records do not require a default-shop setting');
        const before=calls.length;const imported=await service.discover(session(2),{date:'2026-10-22',shop_id:21,tenant_id:3,actor_id:3});extraBatchId=imported.rows[0].batch_id;
        assert.ok(calls.slice(before).every(row=>row.shop===21));assert.equal(imported.rows[0].dispatch_shop.id,21);
        assert.deepEqual(await query('SELECT * FROM ogl_dispatch_settings ORDER BY tenant_id'),settings.filter(row=>row.tenant_id!==2),'Selecting sync shop never creates or changes default settings');
        const all=await service.listOfficial(session(2),{source:'snapshot',date:'2026-10-22'});
        assert.equal(all.total,2);assert.deepEqual(all.rows.map(row=>row.dispatch_shop.id).sort(),[20,21]);
        for(const [shopId,orderId] of [[20,1],[21,2]]) {
          const exact=await service.officialDetail(session(2),{source:'snapshot',date:'2026-10-22',id:901,shop_id:shopId});
          assert.equal(exact.dispatch_shop.id,shopId);assert.equal(exact.members.find(row=>row.matched_local).order_id,orderId);
        }
        for(const method of ['listOfficial','officialDetail','officialTracking','discover']) {
          const offset=calls.length;await assert.rejects(service[method](session(2),{source:method==='discover'?undefined:'snapshot',id:901,date:'2026-10-22',shop_id:30}),{statusCode:409});assert.equal(calls.length,offset);
        }
        await query('INSERT INTO ogl_dispatch_settings(tenant_id,default_shop_id,updated_by,updated_at) VALUES(?,?,?,?)',[2,20,2,savedSettings.updated_at]);
        hook=async(path,selected)=>{if(path==='/v1/carriage/get'&&selected.id===21){hook=null;await query('UPDATE ogl_dispatch_settings SET default_shop_id=21 WHERE tenant_id=2');}};
        const selected=await service.discover(session(2),{date:'2026-10-22',shop_id:21});assert.equal(selected.rows[0].batch_id,extraBatchId,'Changing the default does not invalidate the explicit selected original shop');
        const snapshot=(await query('SELECT official_result_json FROM ogl_dispatch_batches WHERE id=?',[extraBatchId]))[0].official_result_json;
        for(const [revoke,restore,code] of [["UPDATE shops SET status='inactive' WHERE id=21","UPDATE shops SET status='active' WHERE id=21",409],["UPDATE tenant_members SET active=0 WHERE tenant_id=2","UPDATE tenant_members SET active=1 WHERE tenant_id=2",403],["UPDATE tenants SET subscription_status='expired' WHERE id=2","UPDATE tenants SET subscription_status='active' WHERE id=2",403]]) {
          hook=async(path,shop)=>{if(path==='/v1/carriage/get'&&shop.id===21){hook=null;await query(revoke);}};
          const offset=calls.length;await assert.rejects(service.discover(session(2),{date:'2026-10-22',shop_id:21}),{statusCode:code});
          assert.ok(!calls.slice(offset).some(row=>row.path.endsWith('get-postings')));await query(restore);
          assert.deepEqual((await query('SELECT official_result_json FROM ogl_dispatch_batches WHERE id=?',[extraBatchId]))[0].official_result_json,snapshot);
        }
        hook=async(path,shop)=>{if(path.endsWith('get-postings')&&shop.id===21){hook=null;await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2');}};
        await assert.rejects(service.discover(session(2),{date:'2026-10-22',shop_id:21}),{statusCode:403});await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2');
        assert.deepEqual((await query('SELECT official_result_json FROM ogl_dispatch_batches WHERE id=?',[extraBatchId]))[0].official_result_json,snapshot,'Selected shop persistence is also blocked after manifest response revocation');
      } finally {
        hook=null;manifests.delete(21);await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2');await query("UPDATE tenants SET subscription_status='active' WHERE id=2");await query("UPDATE shops SET status='active' WHERE id=21");
        if(extraBatchId){await query('DELETE FROM ogl_dispatch_members WHERE tenant_id=2 AND batch_id=?',[extraBatchId]);await query('DELETE FROM ogl_dispatch_events WHERE tenant_id=2 AND batch_id=?',[extraBatchId]);await query('DELETE FROM ogl_dispatch_batches WHERE tenant_id=2 AND id=?',[extraBatchId]);}
        await query('DELETE FROM ogl_dispatch_settings WHERE tenant_id=2');await query('INSERT INTO ogl_dispatch_settings(tenant_id,default_shop_id,updated_by,updated_at) VALUES(?,?,?,?)',[2,savedSettings.default_shop_id,savedSettings.updated_by,savedSettings.updated_at]);
      }
    });
    await t.test('concurrent rediscovery/restart is SQL-idempotent and file reads cannot approve or dispatch',async()=>{
      await Promise.all([service.discover(session(2),{date:'2026-10-22'}),make().discover(session(2),{date:'2026-10-22'})]);
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM ogl_dispatch_batches WHERE tenant_id=2'))[0].n),1);
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM ogl_dispatch_members WHERE tenant_id=2'))[0].n),1);
      const file=await service.file(session(2),batchId,'container-labels');assert.equal(file.contentType,'application/pdf');
      assert.equal((await service.detail(session(2),batchId)).members[0].dispatched_at,null);
      const list=await service.listBatches(session(2),{date_from:'2026-10-22',date_to:'2026-10-22'});assert.equal(list.total,1);
      assert.equal((await service.listBatches(session(2),{date_from:'2026-10-21',date_to:'2026-10-21'})).total,0);
    });
    await t.test('default-shop change between listing and discovery context rejects stale rows before any association or label read',async()=>{
      const before=await query('SELECT id,default_shop_id,official_result_json FROM ogl_dispatch_batches WHERE tenant_id=2');
      const offset=calls.length;switchAfterFinalList=true;
      await assert.rejects(service.discover(session(2),{date:'2026-10-22'}),error=>error.statusCode===409&&/默认发运店铺已变更/.test(error.message));
      assert.equal(switchAfterFinalList,false);assert.ok(!calls.slice(offset).some(row=>row.path.endsWith('get-container-labels')));
      assert.deepEqual(await query('SELECT id,default_shop_id,official_result_json FROM ogl_dispatch_batches WHERE tenant_id=2'),before);
      await query('UPDATE ogl_dispatch_settings SET default_shop_id=20 WHERE tenant_id=2');
    });
    await t.test('manifest removal/cancellation releases only pending linkage; it never manufactures physical evidence',async()=>{
      statuses.set(20,'cancelled');await service.discover(session(2),{date:'2026-10-22'});
      let detail=await service.detail(session(2),batchId);assert.equal(detail.members[0].active,false);assert.equal(detail.members[0].dispatched_at,null);assert.equal(Number((await evidence(1)).tracking),0);
      await assert.rejects(service.file(session(2),batchId,'container-labels'),{statusCode:409});
      statuses.delete(20);await service.discover(session(2),{date:'2026-10-22'});detail=await service.detail(session(2),batchId);assert.equal(detail.members[0].active,true);
      await query("UPDATE orders SET status='delivering',tracking_stage='posting_in_transit' WHERE id=1");assert.equal(Number((await evidence(1)).tracking),0);assert.equal(Number((await evidence(1)).physical),0);
      await query("UPDATE orders SET status='awaiting_deliver',tracking_stage='' WHERE id=1");
    });
    await t.test('fresh role/member/subscription revocation stops external reads and post-response persistence',async()=>{
      for(const [revoke,restore] of [["UPDATE tenant_members SET business_roles_json=JSON_ARRAY('technical') WHERE tenant_id=2","UPDATE tenant_members SET business_roles_json=JSON_ARRAY('operations') WHERE tenant_id=2"],["UPDATE tenant_members SET active=0 WHERE tenant_id=2","UPDATE tenant_members SET active=1 WHERE tenant_id=2"],["UPDATE tenants SET subscription_status='expired' WHERE id=2","UPDATE tenants SET subscription_status='active' WHERE id=2"]]) {
        await query(revoke);const offset=calls.length;await assert.rejects(service.discover(session(2),{date:'2026-10-22'}),{statusCode:403});assert.equal(calls.length,offset);await query(restore);
      }
      const before=(await query('SELECT official_result_json FROM ogl_dispatch_batches WHERE id=?',[batchId]))[0].official_result_json;
      hook=async(path,shop)=>{if(path.endsWith('get-postings')&&shop.id===20){hook=null;await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2');}};
      await assert.rejects(service.discover(session(2),{date:'2026-10-22'}),{statusCode:403});
      assert.deepEqual((await query('SELECT official_result_json FROM ogl_dispatch_batches WHERE id=?',[batchId]))[0].official_result_json,before);await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2');
    });
    await t.test('scheduler uses persisted real actor, resumes after restart and continues old original shop after settings change',async()=>{
      await query('UPDATE ogl_dispatch_settings SET default_shop_id=21 WHERE tenant_id=2');
      const fresh=make();const result=await fresh.monitorRecent();assert.equal(result.results.find(row=>row.tenant_id===2).status,'active');
      assert.ok(syncCalls.some(row=>row.tenant===2&&row.person===2&&row.shopId===20&&row.numbers.includes('OWN')));
      assert.equal((await fresh.detail(session(2),batchId)).members[0].dispatched_at,null);
      await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('technical') WHERE tenant_id=2");const offset=calls.length;
      assert.equal((await fresh.monitorRecent()).results.find(row=>row.tenant_id===2).status,'paused');assert.ok(!calls.slice(offset).some(row=>row.shop===20||row.shop===21));
      await query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('operations') WHERE tenant_id=2");
      await query('UPDATE ogl_dispatch_settings SET updated_by=999 WHERE tenant_id=2');
      assert.equal((await make().monitorRecent()).results.find(row=>row.tenant_id===2).status,'paused','No synthetic platform/default actor after restart');
      await query('UPDATE ogl_dispatch_settings SET updated_by=2 WHERE tenant_id=2');
    });
    await t.test('missing labels remain unknown and monitor failures do not falsify application creation time',async()=>{
      await query('UPDATE ogl_dispatch_settings SET default_shop_id=20 WHERE tenant_id=2');labelError=true;
      const result=await service.discover(session(2),{date:'2026-10-22'});assert.equal(result.rows[0].batch_id,batchId);assert.equal((await service.detail(session(2),batchId)).members[0].dispatched_at,null);
      assert.equal(Number((await evidence(1)).physical),0);
    });
    await t.test('explicit adoption verifies exact manifest/count; only a later explicit physical confirmation records handover',async()=>{
      await assert.rejects(service.action(session(2),{action:'dispatch',batch_id:batchId,verifiedObserved:{signature:'forged',count:1}}),{statusCode:409});
      await assert.rejects(service.action(session(2),{action:'official-adopt',batch_id:batchId,container_count:1}),/未完全匹配/);
      manifests.set(20,['OWN']);await service.discover(session(2),{date:'2026-10-22'});
      await assert.rejects(service.action(session(2),{action:'official-adopt',batch_id:batchId,container_count:2}),/不一致/);
      const before=calls.length;const adopted=await service.action(session(2),{action:'official-adopt',batch_id:batchId,container_count:1,person_id:3});
      assert.equal(adopted.batch.official_status,'observed');assert.equal(adopted.batch.official_result.local_management.adopted_by,2);assert.equal(adopted.members[0].dispatched_at,null);assert.equal(Number((await evidence(1)).physical),0);
      await query("UPDATE orders SET status='acceptance_in_progress',tracking_stage='posting_acceptance_in_progress' WHERE id=1");
      const result=await service.action(session(2),{action:'dispatch',batch_id:batchId,order_ids:[1]});
      assert.ok(result.members[0].dispatched_at);assert.equal(result.members[0].dispatched_by,2);assert.equal(Number((await evidence(1)).physical),1);
      assert.ok(calls.slice(before).every(row=>!['/v1/carriage/create','/v1/carriage/approve','/v1/carriage/set-postings'].includes(row.path)));
      statuses.set(20,'cancelled');await service.discover(session(2),{date:'2026-10-22'});
      assert.ok((await service.detail(session(2),batchId)).members[0].dispatched_at,'Cancellation never erases recorded physical history');
    });
  } finally {await pool.end();await fixture.cleanup();}
});
