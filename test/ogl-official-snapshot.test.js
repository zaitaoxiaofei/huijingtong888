import test from 'node:test';
import assert from 'node:assert/strict';
import { createOglDispatchService, oglFileCapabilities } from '../src/services/ogl-dispatch.js';

function fixture() {
  const session={personId:7,tenant:{id:2,slug:'snapshot-a'}};
  const state={active:true,shop:20,afterRead:null,apiHook:null};const sql=[],network=[];
  const row=(batchId,carriageId,day)=>({id:batchId,tenant_id:2,batch_number:`OGL-fixture-${carriageId}`,default_shop_id:20,official_carriage_id:String(carriageId),official_status:'observed',status:'preparing',containers_count:1,delivery_method_id:'77',departure_date:day,
    official_result_json:{source:'official_discovery',last_observed_at:'2026-12-31T16:30:00Z',carriage:{id:String(carriageId),carriage_id:String(carriageId),delivery_method_id:'77',departure_date:day,created_at:'2026-12-31T15:00:00Z',status:'received',containers_count:1,postings_count:2,available_actions:['get_label_containers']},
      official_posting_numbers:['OWN','UNMATCHED'],label_tracking:{source:'official_container_label',status:'found',carrier_name:'Fixture carrier',master_tracking_number:'YT3000000000001',tracking_numbers:['YT3000000000001']}}});
  const rows=[row(8,901,'2026-12-31'),row(9,902,'2027-01-01'),row(10,903,'2026-12-30')];
  const member={id:1,batch_id:8,order_id:42,active_order_id:42,shop_id:20,posting_number:'OWN',official_member:1,platform_status:'awaiting_deliver',ordered_at:'2026-12-30T23:00:00Z',shop_status:'active',dispatched_at:null};
  const connection={async execute(statement,params=[]) {
    sql.push({statement,params});assert.match(statement.trim(),/^SELECT/,'Snapshot and file reads must not write business state');
    if(statement.includes('FROM tenants t'))return [state.active&&Number(params[0])===7&&Number(params[1])===2?[{id:2,slug:'snapshot-a',tenant_role:'member',business_roles_json:['packing']}]:[]];
    if(statement.includes('FROM ogl_dispatch_settings'))return [[{default_shop_id:state.shop}]];
    if(statement.includes('FROM shops s'))return [statement.includes('ORDER BY s.id')?[20,21].map(id=>({id,name:`Fixture shop ${id}`,ozon_client_id:'fixture-client',ozon_api_key:'fixture-secret'})):[20,21].includes(Number(params[0]))?[{id:Number(params[0]),name:'Fixture shop',ozon_client_id:'fixture-client',ozon_api_key:'fixture-secret'}]:[]];
    if(statement.includes('FROM ogl_dispatch_events')&&!statement.includes('FROM ogl_dispatch_members m'))return [[]];
    if(statement.includes('FROM ogl_dispatch_members m')&&!statement.includes('FROM ogl_dispatch_batches'))return [[member]];
    if(statement.includes('FROM ogl_dispatch_batches')) {
      let selected;
      if(statement.includes('LEFT JOIN shops'))selected=rows.filter(row=>row.id===Number(params[1]));
      else if(statement.includes('official_carriage_id=?'))selected=rows.filter(row=>row.official_carriage_id===String(params[2]));
      else {assert.deepEqual(params.slice(0,2),[2,2]);selected=rows.filter(row=>params.slice(2).includes(row.default_shop_id));}
      if(state.afterRead){const fn=state.afterRead;state.afterRead=null;fn();}
      return [structuredClone(selected)];
    }
    throw new Error(`Unexpected SQL ${statement}`);
  }};
  let remote={carriage_id:901,status:'received',available_actions:['get_label_containers']};
  const api={deliveryMethods:async()=>assert.fail('Snapshot never requests official delivery pages'),request:async(shop,path,body)=>{
    network.push({shop:shop.id,path,body});if(state.apiHook)await state.apiHook(path);
    if(path==='/v1/carriage/get')return remote;
    if(path==='/v2/posting/fbs/act/get-postings')return {result:[{posting_number:'OWN'}]};
    if(path.endsWith('get-container-labels'))return {buffer:Buffer.from('%PDF-fixture'),contentType:'application/pdf'};
    if(path.endsWith('get-barcode'))return {buffer:Buffer.from([137,80,78,71]),contentType:'image/png'};
    assert.fail(`Unexpected API ${path}`);
  }};
  const service=createOglDispatchService({transaction:fn=>fn(connection),api,now:()=>new Date('2027-01-01T08:00:00Z')});
  return {service,session,state,rows,sql,network,setRemote:value=>{remote=value;}};
}

test('snapshot list is a complete scoped Beijing-date read across year boundaries with explicit saved freshness',async()=>{
  const f=fixture();
  const result=await f.service.listOfficial(f.session,{source:'snapshot',date_from:'2026-12-31',date_to:'2027-01-01',tenant_id:3});
  assert.deepEqual(result.rows.map(row=>row.carriage_id),['902','901']);assert.equal(result.total,2);assert.equal(result.source,'snapshot');assert.equal(result.freshness,'saved');
  assert.equal(result.last_checked_at,'2026-12-31T16:30:00Z');assert.notEqual(result.last_checked_at,'2027-01-01T08:00:00.000Z');assert.match(result.notice,/不代表刚刚读取/);
  assert.equal(result.rows[0].file_capabilities.container_labels.available,true);assert.equal(result.rows[0].file_capabilities.barcode.available,false);
  assert.ok(f.sql.every(row=>row.statement.trim().startsWith('SELECT')));assert.equal(f.network.length,0);assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  assert.equal(result.dispatch_shop,null);assert.equal(result.shop_scope,'enterprise');assert.equal(result.rows[0].dispatch_shop.id,20);
  await assert.rejects(f.service.listOfficial(f.session,{source:'snapshot',date:'2026-12-31',shop_id:30}),{statusCode:409});
});
test('empty/unknown and over-limit snapshots cannot masquerade as a complete live official list',async()=>{
  const f=fixture();
  let result=await f.service.listOfficial(f.session,{source:'snapshot',date:'2027-02-01'});assert.equal(result.total,0);assert.match(result.notice,/不代表官方没有申请/);
  f.rows[0].official_result_json.last_observed_at=undefined;f.rows[0].official_result_json.carriage.created_at=undefined;
  result=await f.service.listOfficial(f.session,{source:'snapshot',date:'2026-12-31'});assert.equal(result.rows[0].snapshot_at,null);assert.equal(result.rows[0].created_at,null);
  f.rows[0].official_result_json.carriage.departure_date=null;f.rows[0].departure_date=null;
  result=await f.service.listOfficial(f.session,{source:'snapshot',date:'2026-12-31'});assert.equal(result.unknown_departure_count,1);assert.match(result.notice,/缺少发运日期/);
  f.rows.splice(0,f.rows.length,...Array.from({length:101},(_,index)=>({...f.rows[1],id:100+index,official_carriage_id:String(1000+index),official_result_json:{...f.rows[1].official_result_json,carriage:{...f.rows[1].official_result_json.carriage,id:String(1000+index),carriage_id:String(1000+index)}}})));
  await assert.rejects(f.service.listOfficial(f.session,{source:'snapshot',date:'2027-01-01'}),error=>error.statusCode===409&&/未截断/.test(error.message));assert.equal(f.network.length,0);
});
test('snapshot hit and structured details recheck authority/current default shop and never leak foreign posting data',async()=>{
  const f=fixture();
  const result=await f.service.officialDetail(f.session,{source:'snapshot',id:901,date:'2026-12-31',tenant_id:3});
  assert.equal(result.carriage.local_batch_id,8);assert.equal(result.source,'snapshot');assert.equal(result.members_complete,true);
  assert.equal(result.members[0].order_id,42);assert.match(result.members[0].order_path,/orderId=42.*shopId=20/);
  assert.equal(result.members[1].posting_number,'UNMATCHED');assert.equal(result.members[1].order_id,null);assert.equal(result.members[1].matched_local,false);
  assert.equal(result.summary.matched_local,1);assert.equal(result.summary.unmatched_local,1);
  const batch=await f.service.detail(f.session,8);assert.equal(batch.batch.file_capabilities.container_labels.available,true);assert.equal(batch.batch.snapshot_at,result.last_checked_at);
  f.state.afterRead=()=>{f.state.active=false;};await assert.rejects(f.service.listOfficial(f.session,{source:'snapshot',date:'2026-12-31'}),{statusCode:403});
  f.state.active=true;f.state.afterRead=()=>{f.state.shop=21;};await assert.rejects(f.service.officialDetail(f.session,{source:'snapshot',id:901,date:'2026-12-31'}),{statusCode:409});
  assert.equal(f.network.length,0);
});
test('legacy snapshots explicitly disclose incomplete manifests rather than inventing missing official members',async()=>{
  const f=fixture();delete f.rows[0].official_result_json.official_posting_numbers;
  const result=await f.service.officialDetail(f.session,{source:'snapshot',id:901,date:'2026-12-31'});
  assert.equal(result.members_complete,false);assert.equal(result.members.length,1);assert.match(result.notice,/完整官方清单需显式刷新/);assert.equal(result.summary.unmatched_local,1);assert.equal(f.network.length,0);
});
test('file capabilities distinguish unknown, unsupported barcode and independently opened container labels',()=>{
  assert.equal(oglFileCapabilities({}).barcode.available,null);
  const cap=oglFileCapabilities({status:'received',available_actions:['get_label_containers']});assert.equal(cap.container_labels.available,true);assert.equal(cap.barcode.available,false);assert.match(cap.barcode.reason,/未提供交接条码/);
  assert.equal(oglFileCapabilities({status:'cancelled',available_actions:['get_label_containers','get_barcode']}).container_labels.available,false);
});
test('unsupported barcode is rejected before a binary call; a label remains a real separate PDF download',async()=>{
  const f=fixture();
  await assert.rejects(f.service.file(f.session,8,'barcode'),error=>error.code==='OGL_FILE_UNSUPPORTED'&&/未提供交接条码/.test(error.message));
  assert.deepEqual(f.network.map(row=>row.path),['/v1/carriage/get']);
  const label=await f.service.file(f.session,8,'container-labels');assert.equal(label.contentType,'application/pdf');assert.ok(f.network.some(row=>row.path.endsWith('get-container-labels')));assert.ok(!f.network.some(row=>row.path.endsWith('get-barcode')));
  f.setRemote({carriage_id:901,status:'received',available_actions:['get_barcode']});
  assert.equal((await f.service.file(f.session,8,'barcode')).contentType,'image/png');
});
test('approved files also fresh-check official capability and suppress bytes after in-flight revocation',async()=>{
  const f=fixture();f.rows[0].official_status='approved';
  f.setRemote({carriage_id:901,status:'received',delivery_method_id:77,containers_count:1});await assert.rejects(f.service.file(f.session,8,'barcode'),{code:'OGL_FILE_CAPABILITY_UNKNOWN'});assert.equal(f.network.length,2);
  f.setRemote({carriage_id:901,status:'received',delivery_method_id:77,containers_count:1,available_actions:['get_label_containers']});
  f.state.apiHook=async path=>{if(path.endsWith('get-container-labels'))f.state.active=false;};
  await assert.rejects(f.service.file(f.session,8,'container-labels'),{statusCode:403});
});
