import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from 'mysql2/promise';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createOglDispatchService, oglPlatformProgress, summarizeOglMembers, isOglLogisticsFresh } from '../src/services/ogl-dispatch.js';
import { ensureOglDispatchSchema } from '../src/services/ogl-dispatch-schema.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('OGL progress uses platform evidence; handover, missing data and cancellation remain distinct', () => {
  assert.equal(oglPlatformProgress({status:'awaiting_deliver'}).online,false);
  assert.equal(oglPlatformProgress({status:'awaiting_deliver',tracking_stage:'driver_pickup'}).handover,true);
  assert.equal(oglPlatformProgress({status:'awaiting_deliver',tracking_stage:'driver_pickup'}).awaiting_delivery,false);
  assert.equal(oglPlatformProgress({status:'delivering'}).online,true);
  assert.equal(oglPlatformProgress({status:'cancelled',tracking_stage:'delivering'}).online,false);
  const at='2026-10-22 16:30:00';
  const rows=[
    {active:true,dispatched_at:at,last_synced_at:at,online:true},
    {active:true,dispatched_at:at,last_synced_at:at,online:false},
    {active:true,dispatched_at:at,last_synced_at:null,online:false},
    {active:true,dispatched_at:at,last_synced_at:'2026-10-22 16:00:00',online:false,sync_error:'timeout'},
    {active:false,withdrawn_at:'now'}
  ];
  assert.deepEqual(summarizeOglMembers(rows),{planned:5,active:4,withdrawn:1,dispatched:4,awaiting_dispatch:0,online:1,delivered:0,not_online:1,exception:0,sync_pending:2});
  assert.equal(isOglLogisticsFresh({dispatched_at:at,last_synced_at:'2026-10-22 16:00:00'}),false);
  assert.equal(isOglLogisticsFresh({dispatched_at:at,last_synced_at:new Date('2026-10-22T16:30:00Z')}),true);
  const mixed=Array.from({length:100},(_,index)=>({active:true,dispatched_at:at,last_synced_at:at,online:index<97}));
  assert.equal(summarizeOglMembers(mixed).online,97);assert.equal(summarizeOglMembers(mixed).not_online,3);
});

test('official-only views show yesterday and today without local batches, remain read-only and redact unrelated fields',async()=>{
  const session={personId:2,tenant:{id:2,slug:'fixture-enterprise'}};
  let defaultShop=20;let linked=false;let changeDuringRequest=false;let revoked=false;let labelMode='found';let labelReads=0;let containersCount=1;const sqlCalls=[];const apiCalls=[];
  const connection={async execute(sql,params=[]){
    sqlCalls.push({sql,params});assert.match(sql.trim(),/^SELECT/,'Official-only viewing must never write workflow data');
    if(sql.includes('FROM tenants t'))return [revoked?[]:[{id:2,slug:'fixture-enterprise',tenant_role:'member',business_roles_json:['packing']}]];
    if(sql.includes('FROM ogl_dispatch_settings'))return [[{default_shop_id:defaultShop}]];
    if(sql.includes('FROM shops s'))return [[{id:Number(params[0]),name:'Fixture default shop',ozon_client_id:'fixture-client',ozon_api_key:'fixture-key'}]];
    if(sql.includes('FROM ogl_dispatch_batches'))return [linked?[{id:8,batch_number:'OGL-fixture',official_carriage_id:'901'}]:[]];
    if(sql.includes('FROM orders o')){assert.equal(params[1],20);return [[{id:1,posting_number:'LOCAL-OWN',shop_id:20,platform_status:'awaiting_deliver',tracking_stage:'posting_in_carriage',last_synced_at:'2026-10-22 01:00:00'}]];}
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const api={
    async deliveryMethods(shop,filter){
      apiCalls.push({shop:shop.id,path:'delivery-list',filter});assert.ok(['2026-10-21','2026-10-22'].includes(filter.departure_date));
      if(changeDuringRequest)defaultShop=21;
      const yesterday=filter.departure_date==='2026-10-21';
      return [{delivery_method_id:77,delivery_method_name:'OGL fixture pickup',departure_date:yesterday?'2026-10-20T16:00:00Z':'2026-10-21T16:00:00Z',has_entrusted_acceptance:true,
        carriages:[{id:0,status:'new',available_actions:['create']},{id:yesterday?901:902,status:yesterday?'received':'formed',postings_count:3,available_actions:['get_details']}]},
        {delivery_method_id:88,departure_date:'2026-10-19T16:00:00Z',carriages:[{id:903,status:'formed'}]}];
    },
    async request(shop,path,body){
      apiCalls.push({shop:shop.id,path,body});assert.equal(shop.id,20);
      if(path==='/v1/carriage/get')return {carriage_id:body.carriage_id,delivery_method_id:77,status:body.carriage_id===901?'received':'formed',containers_count:containersCount,
        first_mile_type:'pickup',integration_type:'ozon_outsourced',phone:'secret-phone',recipient:{name:'private-customer'},available_actions:['get_label_containers']};
      if(path==='/v2/posting/fbs/act/get-postings')return {result:[{posting_number:'LOCAL-OWN'},{posting_number:'OTHER-SHOP'},{posting_number:'NOT-SYNCED',customer:{name:'private-customer'}}]};
      if(path==='/v2/posting/fbs/act/get-container-labels') {
        labelReads++;
        if(labelMode==='network-error')throw new Error('private-customer remote error');
        if(labelMode==='revoke')revoked=true;
        if(labelMode==='change-default')defaultShop=21;
        return {buffer:Buffer.from('%PDF-fixture'),contentType:'application/pdf'};
      }
      throw new Error(`Read-only views attempted an unsupported API ${path}`);
    }
  };
  const makeService=()=>createOglDispatchService({transaction:fn=>fn(connection),api,now:()=>new Date('2026-10-21T16:30:00Z'),extractLabelTracking:async(buffer,{containersCount})=>{
    assert.equal(buffer.toString(),'%PDF-fixture');
    const numbers=labelMode==='not_found'?[]:labelMode==='ambiguous'?['YT3000000000001','YT3000000000002']:['YT3000000000001'];
    return {status:labelMode==='not_found'?'not_found':numbers.length>1?'ambiguous':'found',source:'official_container_label',carrier_name:numbers.length?'圆通':null,
      tracking_numbers:numbers,master_tracking_number:numbers.length===1?numbers[0]:null,labels:[{label_page:1,tracking_numbers:numbers}],page_count:1,containers_count:containersCount,container_mapping_confirmed:false,notice:numbers.length?'标签读取结果':'标签没有可识别文字'};
  }});
  const service=makeService();
  const yesterday=await service.listOfficial(session,{date:'2026-10-21'});assert.equal(yesterday.total,1);assert.equal(yesterday.rows[0].carriage_id,'901');assert.equal(yesterday.rows[0].status_label,'验收中');assert.equal(yesterday.rows[0].official_only,true);
  const today=await service.listOfficial(session,{date:'2026-10-22'});assert.equal(today.departure_date,'2026-10-22');assert.equal(today.rows[0].carriage_id,'902');assert.equal(today.rows[0].status_label,'已生成');
  const detail=await service.officialDetail(session,{id:902,date:'2026-10-22'});
  assert.equal(detail.carriage.status,'formed');assert.equal(detail.carriage.status_label,'已生成');assert.equal(detail.summary.matched_local,1);assert.equal(detail.summary.unmatched_local,2);
  assert.equal(detail.members[0].platform_status,'awaiting_deliver');assert.equal(detail.members[0].online,false,'Carriage formed never promotes member logistics');
  assert.equal(detail.members[1].matched_local,false);assert.equal(detail.members[1].order_id,null);
  assert.ok(!/fixture-key|secret-phone|private-customer/.test(JSON.stringify({today,yesterday,detail})));
  const before=apiCalls.length;await assert.rejects(service.officialDetail(session,{id:901,date:'2026-10-22'}),/不在所选原店铺/);assert.equal(apiCalls.slice(before).filter(call=>call.path!=='delivery-list').length,0);
  await assert.rejects(service.listOfficial(session,{date:'2026-02-30'}),/有效的北京日期/);
  linked=true;assert.equal((await service.listOfficial(session,{date:'2026-10-21'})).rows[0].local_batch_id,8);
  const [tracking,concurrent]=await Promise.all([service.officialTracking(session,{id:902,date:'2026-10-22'}),service.officialTracking(session,{id:902,date:'2026-10-22'})]);
  assert.equal(labelReads,1,'Concurrent reads share a single label/PDF parse');assert.equal(tracking.tracking.master_tracking_number,'YT3000000000001');assert.equal(concurrent.tracking.master_tracking_number,tracking.tracking.master_tracking_number);
  tracking.tracking.tracking_numbers.push('tampered');assert.deepEqual((await service.officialTracking(session,{id:902,date:'2026-10-22'})).tracking.tracking_numbers,['YT3000000000001']);assert.equal(labelReads,1);
  containersCount=2;assert.equal((await service.officialTracking(session,{id:902,date:'2026-10-22'})).tracking.containers_count,2);assert.equal(labelReads,2,'A fresh detail count change must not reuse the old parsed-label cache');
  const uncached=makeService();labelMode='not_found';const beforeMissing=labelReads;
  assert.equal((await uncached.officialTracking(session,{id:902,date:'2026-10-22'})).tracking.status,'not_found');
  assert.match((await uncached.officialTracking(session,{id:902,date:'2026-10-22'})).tracking.notice,/未取得标签中的运单号/);assert.equal(labelReads,beforeMissing+2,'Not-found results are never cached');
  labelMode='ambiguous';const ambiguous=await uncached.officialTracking(session,{id:902,date:'2026-10-22'});assert.equal(ambiguous.tracking.master_tracking_number,null);assert.equal(ambiguous.tracking.container_mapping_confirmed,false);
  labelMode='network-error';await assert.rejects(makeService().officialTracking(session,{id:902,date:'2026-10-22'}),error=>error.statusCode===502&&/未取得标签中的运单号/.test(error.message)&&!error.message.includes('private-customer'));
  assert.equal((await service.officialDetail(session,{id:902,date:'2026-10-22'})).carriage.status,'formed','A tracking failure never destroys the independently readable application detail');
  labelMode='revoke';await assert.rejects(makeService().officialTracking(session,{id:902,date:'2026-10-22'}),error=>error.statusCode===403);revoked=false;
  labelMode='change-default';await assert.rejects(makeService().officialTracking(session,{id:902,date:'2026-10-22'}),/默认发运店铺已变更/);defaultShop=20;labelMode='found';
  changeDuringRequest=true;await assert.rejects(service.listOfficial(session,{date:'2026-10-22'}),/默认发运店铺已变更/);
  assert.ok(sqlCalls.every(call=>/^SELECT/.test(call.sql.trim())));assert.ok(apiCalls.every(call=>['delivery-list','/v1/carriage/get','/v2/posting/fbs/act/get-postings','/v2/posting/fbs/act/get-container-labels'].includes(call.path)));
});

test('OGL isolated MySQL batches, official fixtures, tenant boundaries and concurrent retries', {
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires independent socket-only MySQL',timeout:120000
}, async t=>{
  const fixture=await createTenantMysqlFixture('ogl_dispatch');
  await ensureOglDispatchSchema(fixture.connection);
  const pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database:fixture.database,connectionLimit:4,timezone:'Z'});
  const transaction=async fn=>{const connection=await pool.getConnection();try{await connection.beginTransaction();const result=await fn(connection);await connection.commit();return result;}catch(error){await connection.rollback();throw error;}finally{connection.release();}};
  const query=fixture.query; const session=id=>({personId:id,tenant:{id,slug:id===1?'default':`ogl-${id}`}});
  const calls=[]; const official=new Map(); let mode='normal'; let nextId=1000; let pauseDelivery=null; let pauseGet=null;let labelPdfBuffer=Buffer.from('%PDF-fixture');
  const api={
    async deliveryMethods(shop,filter){calls.push({shop:shop.id,path:'delivery',filter});if(pauseDelivery){const pause=pauseDelivery;pauseDelivery=null;pause.enter();await pause.wait;}
      if(mode==='approved-rediscovery')return [{delivery_method_id:77,departure_date:'2026-10-22T16:00:00Z',has_entrusted_acceptance:true,
        carriages:[...official.entries()].map(([id,value])=>({id,status:value.status,containers_count:value.containers,available_actions:['get_label_containers']}))}];
      if(mode==='official-readonly')return [{delivery_method_id:77,delivery_method_name:'OGL fixture pickup',departure_date:filter.departure_date==='2026-10-21'?'2026-10-20T16:00:00Z':'2026-10-21T16:00:00Z',has_entrusted_acceptance:true,
        carriages:[{id:0,available_actions:['create']},{id:Number(shop.id)===30?991:filter.departure_date==='2026-10-21'?901:902,status:filter.departure_date==='2026-10-21'?'received':'formed',postings_count:4,available_actions:['get_label_containers']}]}];
      return [{delivery_method_id:77,name:'OGL pickup',departure_date:'2026-10-22T16:00:00Z',has_entrusted_acceptance:true,carriages:[{id:0,available_actions:['create']}]}];},
    async request(shop,path,body,options){
      calls.push({shop:Number(shop.id),path,body,options});
      if(path.endsWith('/create')) {
        if(mode==='timeout') throw Object.assign(new Error('transport timeout'),{unknown:true,operationOutcome:'unknown'});
        const carriage_id=++nextId;official.set(carriage_id,{status:'new',numbers:['A1','EXTRA'],method:body.delivery_method_id});return {carriage_id};
      }
      const carriageId=Number(body.carriage_id??body.id);const item=official.get(carriageId);
      if(path.endsWith('/get')) {if(pauseGet){const pause=pauseGet;pauseGet=null;pause.enter();await pause.wait;}if(!item)throw new Error('Unknown official carriage');return {status:item.status,containers_count:item.containers,delivery_method_id:item.method,first_mile_type:'pickup',integration_type:'ozon_outsourced',available_actions:['get_label_containers','get_barcode']};}
      if(path.endsWith('/get-postings')) return {result:item.numbers.map(posting_number=>({posting_number}))};
      if(path.endsWith('/set-postings')) {item.numbers=body.posting_numbers;return {result:body.posting_numbers.map(posting_number=>({posting_number,result:true,error:''}))};}
      if(path.endsWith('/approve')) {item.status='sended';item.containers=body.containers_count;return {};}
      if(path.endsWith('/courier-contact/set'))return {};
      if(options?.binary)return {buffer:labelPdfBuffer,contentType:'application/pdf'};
      throw new Error(`Unexpected API fixture ${path}`);
    }
  };
  const service=createOglDispatchService({transaction,api,now:()=>new Date('2026-10-22T16:30:00Z'),syncPostings:async (current,shopId,numbers)=>({rows:numbers.filter(number=>number!=='A2').map(posting_number=>({posting_number,shop_id:shopId})),errors:[]})});
  let first;
  try {
    for(const tenantId of [1,2,3]) {
      await query('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)',[tenantId,tenantId===1?'default':`ogl-${tenantId}`,`Enterprise ${tenantId}`]);
      await query("INSERT INTO people(id,name,role) VALUES(?,?,'operator')",[tenantId,`OGL person ${tenantId}`]);
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'admin',JSON_ARRAY('operator'))",[tenantId,tenantId]);
    }
    await query("INSERT INTO people(id,name,role) VALUES(4,'Packing user','packing')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,4,'member',JSON_ARRAY('packing'))");
    for(const [shopId,tenantId] of [[10,null],[20,2],[21,2],[30,3]]) await query("INSERT INTO shops(id,tenant_id,name,ozon_client_id,api_key_hint) VALUES(?,?,?,'fixture-client','fixture-key')",[shopId,tenantId,`Shop ${shopId}`]);
    const seeds=[[1,20,'A1','OGL','awaiting_deliver',true],[2,21,'A2','OGL','awaiting_deliver',true],[3,30,'B1','OGL','awaiting_deliver',true],[4,20,'A4','GUOO','awaiting_deliver',true],[5,20,'A5','OGL','awaiting_deliver',false],[6,20,'A6','OGL','awaiting_packaging',true],[7,20,'A7','OGL','awaiting_deliver',true],[8,20,'A8','OGL','awaiting_deliver',true],[9,20,'A9','OGL','awaiting_deliver',true],[10,10,'LEGACY','OGL','awaiting_deliver',true],[11,20,'A11','OGL','awaiting_deliver',true]];
    for(const [orderId,shopId,number,carrier,status,printed] of seeds) {
      await query('INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,?,UTC_TIMESTAMP())',[orderId,shopId,number,status]);
      await query("INSERT INTO ozon_orders_raw(store_id,posting_number,status,raw_json) VALUES(?,?,?,?)",[shopId,number,status,JSON.stringify({posting_number:number,status,delivery_method:{id:77,name:`${carrier} pickup`}})]);
      if(printed)await query('INSERT INTO order_label_prints(order_id) VALUES(?)',[orderId]);
    }
    await t.test('preview validates real ownership, OGL, printing and current status; default slug grants no other tenant',async()=>{
      const checked=await service.preview(session(2),{order_ids:[1,2,3,4,5,6,10],tenant_id:3});
      assert.deepEqual(checked.counts,{selected:7,eligible:2,rejected:5});
      assert.equal((await service.preview(session(1),{order_ids:[1,3,10]})).counts.eligible,1);
      assert.equal((await service.bootstrap(session(2))).shops.length,2);
      assert.ok(!JSON.stringify(await service.bootstrap(session(2))).includes('fixture-key'));
      await assert.rejects(service.saveSettings({personId:4,tenant:{id:2,slug:'ogl-2'}},{dispatch_shop_id:20}),/负责人|管理员/);
      await assert.rejects(service.saveSettings(session(2),{dispatch_shop_id:30}),/不属于/);
      await service.saveSettings(session(2),{dispatch_shop_id:20});
    });
    await t.test('existing official carriages need no ERP batch and exact original-shop matching does not cross enterprises',async()=>{
      await service.saveSettings(session(3),{dispatch_shop_id:30});mode='official-readonly';
      for(const [carriageId,status] of [[901,'received'],[902,'formed']])official.set(carriageId,{status,method:77,containers:1,numbers:['A1','A2','B1','NOT-SYNCED']});
      const snapshot=await query('SELECT (SELECT COUNT(*) FROM ogl_dispatch_batches) AS batches,(SELECT COUNT(*) FROM ogl_dispatch_members) AS members,(SELECT COUNT(*) FROM ogl_dispatch_events) AS events,(SELECT COUNT(*) FROM ogl_dispatch_official_locks) AS locks');
      const offset=calls.length;
      await assert.rejects(service.listOfficial(session(2),{date:'2026-10-21',shop_id:30}),{statusCode:409});
      const yesterday=await service.listOfficial(session(2),{date:'2026-10-21',tenant_id:3,shop_id:20});
      assert.equal(yesterday.rows[0].carriage_id,'901');assert.equal(yesterday.rows[0].status,'received');assert.equal(yesterday.rows[0].official_only,true);assert.equal(yesterday.rows[0].local_batch_id,null);
      const today=await service.listOfficial(session(2),{date:'2026-10-22'});assert.equal(today.rows[0].status_label,'已生成');assert.equal(today.rows[0].containers_count,1);
      const current=await service.officialDetail(session(2),{id:902,date:'2026-10-22',tenant_id:3,shop_id:20});
      assert.deepEqual(current.summary,{official_members:4,matched_local:1,unmatched_local:3,online:0});assert.equal(current.members[0].order_id,1);
      assert.equal(current.members.find(row=>row.posting_number==='A2').matched_local,false,'Same-enterprise other shop is not the official source shop');
      assert.equal(current.members.find(row=>row.posting_number==='B1').order_id,null,'Foreign-enterprise order details are not exposed');
      assert.equal(current.carriage.status,'formed');assert.equal(current.members[0].platform_status,'awaiting_deliver');assert.equal(current.members[0].online,false);
      await assert.rejects(service.officialDetail(session(3),{id:902,date:'2026-10-22',tenant_id:2,shop_id:20}),/不属于当前企业/);
      const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Helvetica);pdf.addPage().drawText('YT3000000000001',{font,size:18,x:30,y:300});labelPdfBuffer=Buffer.from(await pdf.save());
      const [tracking,concurrent]=await Promise.all([service.officialTracking(session(2),{id:902,date:'2026-10-22'}),service.officialTracking(session(2),{id:902,date:'2026-10-22'})]);
      assert.equal(tracking.tracking.master_tracking_number,'YT3000000000001');assert.equal(concurrent.tracking.master_tracking_number,tracking.tracking.master_tracking_number);
      assert.equal(tracking.tracking.containers_count,1);assert.equal(tracking.tracking.container_mapping_confirmed,false);
      assert.equal(calls.slice(offset).filter(call=>call.path==='/v2/posting/fbs/act/get-container-labels').length,1);
      official.get(902).containers=2;const revalidated=await service.officialTracking(session(2),{id:902,date:'2026-10-22'});assert.equal(revalidated.tracking.containers_count,2);
      assert.equal(calls.slice(offset).filter(call=>call.path==='/v2/posting/fbs/act/get-container-labels').length,2,'The real parser is called again after a verified count change');official.get(902).containers=1;
      let enter,release;const entered=new Promise(resolve=>{enter=resolve;});const wait=new Promise(resolve=>{release=resolve;});pauseDelivery={enter,wait};
      const pending=service.listOfficial(session(2),{date:'2026-10-22'}).then(value=>({value}),error=>({error}));
      await entered;await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');release();assert.equal((await pending).error.statusCode,403);
      await query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
      assert.deepEqual(await query('SELECT (SELECT COUNT(*) FROM ogl_dispatch_batches) AS batches,(SELECT COUNT(*) FROM ogl_dispatch_members) AS members,(SELECT COUNT(*) FROM ogl_dispatch_events) AS events,(SELECT COUNT(*) FROM ogl_dispatch_official_locks) AS locks'),snapshot);
      assert.ok(calls.slice(offset).every(call=>['delivery','/v1/carriage/get','/v2/posting/fbs/act/get-postings','/v2/posting/fbs/act/get-container-labels'].includes(call.path)));
      assert.ok(calls.slice(offset).filter(call=>call.path==='delivery').every(call=>/^2026-10-(21|22)$/.test(call.filter.departure_date)));
      mode='normal';
    });
    await t.test('idempotent creation and concurrent overlap preserve one active association',async()=>{
      const payload={order_ids:[1,2],container_count:3,client_request_id:'retry-one'};
      const [a,b]=await Promise.all([service.createBatch(session(2),payload),service.createBatch(session(2),payload)]);
      assert.equal(a.batch.id,b.batch.id);first=a;
      assert.match(a.batch.batch_number,/OGL-20261023-/);
      assert.equal(a.members[0].container_no,null);
      const attempts=await Promise.allSettled(['x','y'].map(client_request_id=>service.createBatch(session(2),{order_ids:[7],container_count:1,client_request_id})));
      assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
      const [[count]]=await fixture.connection.query('SELECT COUNT(*) AS n FROM ogl_dispatch_members WHERE active_order_id=7');assert.equal(count.n,1);
      await assert.rejects(service.detail(session(3),first.batch.id),/不存在/);
      await assert.rejects(service.action(session(3),{batch_id:first.batch.id,action:'dispatch'}),/不存在/);
      await assert.rejects(service.file(session(3),first.batch.id,'barcode'),/不存在/);
      await service.action(session(2),{batch_id:first.batch.id,action:'assign',order_ids:[1],container_no:2});
    });
    await t.test('one creation-shop carriage includes local mixed members; only own postings are submitted and verified',async()=>{
      await query("UPDATE ozon_orders_raw SET raw_json=JSON_SET(raw_json,'$.delivery_method.id',78) WHERE store_id=20 AND posting_number='A1'");
      await assert.rejects(service.action(session(2),{batch_id:first.batch.id,action:'official-create',delivery_method_id:77,departure_date:'2026-10-23'}),/配送方式不一致/);
      assert.equal(calls.filter(row=>row.path.endsWith('/create')).length,0);
      await query("UPDATE ozon_orders_raw SET raw_json=JSON_SET(raw_json,'$.delivery_method.id',77) WHERE store_id=20 AND posting_number='A1'");
      const created=await service.action(session(2),{batch_id:first.batch.id,action:'official-create',delivery_method_id:77,departure_date:'2026-10-23'});
      assert.equal(created.batch.official_status,'created');
      assert.equal(calls.find(call=>call.path.endsWith('/create')).body.departure_date,'2026-10-22T16:00:00Z','Match the Beijing-calendar day but submit the exact official date-time across the UTC midnight boundary');
      const set=calls.find(call=>call.path.endsWith('/set-postings'));assert.deepEqual(set.body.posting_numbers,['A1']);assert.equal(set.shop,20);
      assert.deepEqual(created.batch.official_result.cross_shop_local_only,['A2']);
      assert.equal(created.members.find(row=>row.posting_number==='A2').official_member,0);
      const approved=await service.action(session(2),{batch_id:first.batch.id,action:'official-confirm',courier_contact:{phone:'+8613812345678',wechat_nickname:'fixture'}});
      assert.equal(approved.batch.official_status,'approved');assert.equal(approved.batch.status,'ready');assert.equal(calls.find(call=>call.path.endsWith('/approve')).body.containers_count,3);
      assert.equal(calls.find(call=>call.path.endsWith('/courier-contact/set')).body.phone,'+86(138)1234-5678');
      assert.match((await service.file(session(2),first.batch.id,'container-labels')).filename,/container-labels.pdf$/);
      const remote=official.get(Number(approved.batch.official_carriage_id));
      for(const [field,value] of [['numbers',['A7']],['containers',4],['method',78]]) {
        const previous=remote[field];remote[field]=value;mode='approved-rediscovery';
        if(field==='method')await assert.rejects(service.discover(session(2),{date:'2026-10-23'}),/配送方式不一致/);
        else {
          await service.discover(session(2),{date:'2026-10-23'});
          assert.equal((await service.detail(session(2),first.batch.id)).batch.official_status,'approved','Discovery metadata cannot itself imply a new physical handover');
        }
        const offset=calls.length;
        await assert.rejects(service.action(session(2),{batch_id:first.batch.id,action:'dispatch',verifiedOfficial:{kind:'approved',count:3}}),error=>error.statusCode===409&&/已变化/.test(error.message));
        const blocked=await service.detail(session(2),first.batch.id);
        assert.ok(['mismatch','sync_required'].includes(blocked.batch.official_status));assert.ok(blocked.members.every(row=>!row.dispatched_at));
        assert.ok(calls.slice(offset).some(row=>row.path.endsWith('/get-postings')),'Every approved dispatch reads the current official manifest');
        assert.ok(calls.slice(offset).every(row=>!['/v1/carriage/create','/v1/carriage/approve','/v1/carriage/set-postings'].includes(row.path)));
        remote[field]=previous;mode='normal';await service.action(session(2),{batch_id:first.batch.id,action:'official-sync'});
      }
      for(const [field,value,flag] of [['containers',4,'container_count_mismatch'],['containers',undefined,'container_count_mismatch'],['method',78,'delivery_method_mismatch'],['method',undefined,'delivery_method_mismatch']]) {
        const previous=remote[field];remote[field]=value;
        const conflict=await service.action(session(2),{batch_id:first.batch.id,action:'official-sync'});
        assert.ok(['mismatch','sync_required'].includes(conflict.batch.official_status));assert.equal(conflict.summary[flag],true);assert.ok(conflict.batch.official_error);
        await assert.rejects(service.file(session(2),first.batch.id,'container-labels'),/尚未核实确认/);
        await assert.rejects(service.action(session(2),{batch_id:first.batch.id,action:'dispatch'}),/先创建、核对并确认/);
        const [gate]=await query('SELECT batch_id FROM ogl_dispatch_official_locks WHERE tenant_id=2 AND default_shop_id=20 AND delivery_method_id=77');assert.equal(Number(gate.batch_id),Number(first.batch.id));
        remote[field]=previous;
        const fixed=await service.action(session(2),{batch_id:first.batch.id,action:'official-sync'});assert.equal(fixed.batch.official_status,'approved');assert.equal(fixed.summary[flag],false);
        assert.equal((await query('SELECT batch_id FROM ogl_dispatch_official_locks WHERE tenant_id=2 AND default_shop_id=20 AND delivery_method_id=77')).length,0);
      }
      await service.action(session(2),{batch_id:first.batch.id,action:'dispatch'});
      const [[raw]]=await fixture.connection.query('SELECT status FROM orders WHERE id=1');assert.equal(raw.status,'awaiting_deliver');
      await assert.rejects(service.action(session(2),{batch_id:first.batch.id,action:'withdraw',order_ids:[1],reason:'Not handed over'}),/官方发运清单/);
      await service.action(session(2),{batch_id:first.batch.id,action:'withdraw',order_ids:[2],reason:'Short stock'});
      const newer=await service.createBatch(session(2),{order_ids:[2],container_count:1,client_request_id:'resend-A2'});
      assert.notEqual(newer.batch.id,first.batch.id);
      const pending=await service.action(session(2),{batch_id:newer.batch.id,action:'refresh'});
      assert.equal(pending.summary.not_online,0);assert.equal(pending.summary.sync_pending,1);assert.equal(pending.batch.last_refreshed_at,null);
      await query("UPDATE orders SET last_synced_at='2026-10-22 16:31:00',status='delivering',tracking_stage='posting_in_transit' WHERE id=2");
      const automaticallyUpdated=await service.detail(session(2),newer.batch.id);
      assert.equal(automaticallyUpdated.members[0].sync_error,null);assert.equal(automaticallyUpdated.summary.sync_pending,0);assert.equal(automaticallyUpdated.summary.online,1);
      const [failureHistory]=await query('SELECT sync_error FROM ogl_dispatch_members WHERE batch_id=?',[newer.batch.id]);assert.ok(failureHistory.sync_error,'Failed attempt remains stored for audit while view uses newer successful platform sync');
      const old=await service.detail(session(2),first.batch.id);assert.equal(old.summary.withdrawn,1);assert.ok(old.events.some(row=>row.action==='withdraw'));
    });
    await t.test('real handover blocks local withdrawal; refresh failures stay separate from not-online',async()=>{
      await query("UPDATE orders SET tracking_stage='driver_pickup' WHERE id=7");
      const [owned]=await query('SELECT batch_id FROM ogl_dispatch_members WHERE active_order_id=7');
      await assert.rejects(service.action(session(2),{batch_id:owned.batch_id,action:'withdraw',reason:'Missing'}),/真实物流/);
      const refreshed=await service.action(session(2),{batch_id:first.batch.id,action:'refresh'});assert.ok(refreshed.batch.last_refreshed_at);
      await query("UPDATE orders SET status='delivering',tracking_stage='posting_in_transit' WHERE id=1");
      const current=await service.detail(session(2),first.batch.id);assert.equal(current.summary.online,1);assert.equal(current.summary.not_online,0);
      await service.action(session(2),{batch_id:first.batch.id,action:'close'});
    });
    await t.test('network pauses do not allow cancelled creation or clear a newer official-operation token',async()=>{
      const draft=await service.createBatch(session(2),{order_ids:[11],container_count:1,client_request_id:'cancel-race'});
      let enter,release;const entered=new Promise(resolve=>{enter=resolve;});const wait=new Promise(resolve=>{release=resolve;});pauseDelivery={enter,wait};
      const before=calls.filter(row=>row.path.endsWith('/create')).length;
      const request=service.action(session(2),{batch_id:draft.batch.id,action:'official-create',delivery_method_id:77,departure_date:'2026-10-23'}).then(value=>({value}),error=>({error}));
      await entered;await service.action(session(2),{batch_id:draft.batch.id,action:'cancel',reason:'Not sending this batch'});release();
      assert.match((await request).error.message,/取消|结束/);assert.equal(calls.filter(row=>row.path.endsWith('/create')).length,before);
      let getEnter,getRelease;const getEntered=new Promise(resolve=>{getEnter=resolve;});const getWait=new Promise(resolve=>{getRelease=resolve;});pauseGet={enter:getEnter,wait:getWait};
      const sync=service.action(session(2),{batch_id:first.batch.id,action:'official-sync'}).then(value=>({value}),error=>({error}));
      await getEntered;
      await query("UPDATE ogl_dispatch_batches SET official_status='confirming',official_operation_token='parallel-token' WHERE id=?",[first.batch.id]);getRelease();
      assert.match((await sync).error.message,/官方操作已变化/);
      const [row]=await query('SELECT official_operation_token FROM ogl_dispatch_batches WHERE id=?',[first.batch.id]);assert.equal(row.official_operation_token,'parallel-token');
      await query("UPDATE ogl_dispatch_batches SET official_status='approved',official_operation_token=NULL WHERE id=?",[first.batch.id]);
    });
    await t.test('unknown mutation outcome prevents blind recreation; explicit membership revocation stops all access',async()=>{
      const next=await service.createBatch(session(2),{order_ids:[8],container_count:1,client_request_id:'unknown'});mode='timeout';
      await assert.rejects(service.action(session(2),{batch_id:next.batch.id,action:'official-create',delivery_method_id:77,departure_date:'2026-10-23'}),/timeout/);
      assert.equal((await service.detail(session(2),next.batch.id)).batch.official_status,'create_unknown');
      const before=calls.filter(row=>row.path.endsWith('/create')).length;
      await assert.rejects(service.action(session(2),{batch_id:next.batch.id,action:'official-create',delivery_method_id:77,departure_date:'2026-10-23'}),/勿重复创建/);
      assert.equal(calls.filter(row=>row.path.endsWith('/create')).length,before);
      const other=await service.createBatch(session(2),{order_ids:[9],container_count:1,client_request_id:'blocked-by-unknown'});
      await assert.rejects(service.action(session(2),{batch_id:other.batch.id,action:'official-create',delivery_method_id:77,departure_date:'2026-10-23'}),/待核实官方发运/);
      assert.equal(calls.filter(row=>row.path.endsWith('/create')).length,before,'Unknown result retains same-shop/method gate across batches');
      await query("UPDATE tenants SET subscription_status='expired' WHERE id=2");await assert.rejects(service.bootstrap(session(2)),/订阅已失效/);await query("UPDATE tenants SET subscription_status='trial' WHERE id=2");
      await query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
      await assert.rejects(service.bootstrap(session(2)),/已失效/);
      await assert.rejects(service.action(session(2),{batch_id:next.batch.id,action:'official-sync',official_carriage_id:1001}),/已失效/);
    });
  } finally {await pool.end();await fixture.cleanup();}
});
