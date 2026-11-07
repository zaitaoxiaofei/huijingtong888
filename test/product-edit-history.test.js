import test from 'node:test';
import assert from 'node:assert/strict';
import {productIdentitySnapshot,recordProductEdit,createProductEditHistory} from '../src/services/product-edit-history.js';
import {PRODUCT_IDENTITY_FIELDS} from '../src/shared/product-edit-history.js';
import {handleCatalogRestRoute} from '../src/server/routes/catalog.js';
import {tenantIsolationDecision} from '../src/server/tenant-isolation.js';
import {authorizeApiRequest} from '../src/server/authorization.js';

const scope={id:2,isDefault:false},session={personId:7,roles:['packing'],tenant:{id:2,slug:'a',role:'member'}};
const snapshot=values=>productIdentitySnapshot({id:23,name:'旧名',inventory_number:'1-2-3',...values});

test('identity versions contain only saved identity and stable component references, without financial or private fields',()=>{
 const value=productIdentitySnapshot({id:23,name:'saved name',inventory_number:'1-2-3',purchase_cost:88,purchase_url:'private',supplier_note:'private',owner_person_id:99,vehicle_models_json:'["T7"]'},[{component_product_id:45,quantity:'2.0000',component_role:'gift',name:'current child',purchase_cost:100}]);
 assert.deepEqual(Object.keys(value),PRODUCT_IDENTITY_FIELDS.map(row=>row.key));
 assert.equal(value.material,null);assert.deepEqual(value.vehicle_models_json,['T7']);
 assert.deepEqual(value.components,[{product_id:45,quantity:2,component_role:'gift'}]);
 assert.doesNotMatch(JSON.stringify(value),/private|purchase_cost|supplier_note|current child|owner_person_id/);
});

test('no identity change creates no version, and a real rename retains the old name once before the audit',async()=>{
 const calls=[],query=async(sql,args)=>{calls.push({sql,args});return[];};
 const before=snapshot({}),after=snapshot({name:'新名',inventory_number:'2-2-1'});
 assert.equal(await recordProductEdit(query,scope,before,structuredClone(before)),false);assert.equal(calls.length,0);
 await recordProductEdit(query,scope,before,after,{personId:7});
 assert.match(calls[1].sql,/INSERT INTO product_name_aliases/);assert.match(calls[1].sql,/'previous_name'/);assert.deepEqual(calls[1].args,[2,23,'旧名']);
 assert.match(calls[2].sql,/INSERT INTO inventory_flow_events/);assert.deepEqual(calls[2].args.slice(0,4),[2,23,7,'product_edit']);
 const saved=JSON.parse(calls[2].args[4]);assert.equal(saved.before.inventory_number,'1-2-3');assert.equal(saved.after.inventory_number,'2-2-1');assert.deepEqual(saved.changed_fields,['inventory_number','name']);
});

test('an inactive historical name is preserved and a foreign-owned name alias aborts the edit audit',async()=>{
 const before=snapshot({}),after=snapshot({name:'新名'}),calls=[];
 await recordProductEdit(async(sql,args)=>{calls.push({sql,args});return sql.startsWith('SELECT')?[{tenant_id:2,active:0}]:[];},scope,before,after,{personId:7});
 assert.equal(calls.length,2);assert.match(calls[1].sql,/inventory_flow_events/);assert.ok(calls.every(call=>!call.sql.includes('UPDATE product_name_aliases')));
 const rejected=[];
 await assert.rejects(recordProductEdit(async(sql,args)=>{rejected.push({sql,args});return[{tenant_id:3}];},scope,before,after),{statusCode:409});
 assert.equal(rejected.length,1);
});

function reader({events=[],authorize=async()=>session,product={id:23,tenant_id:2,name:'当前名',purchase_cost:99},count=events.length}={}){
 const calls=[];
 const query=async(sql,args=[])=>{
  calls.push({sql,args});
  if(sql.includes('FROM tenants'))return[{id:2,slug:'a'}];
  if(sql.includes('SELECT owned.*'))return product?[product]:[];
  if(sql.includes('FROM product_components'))return[];
  if(sql.includes('FROM inventory_number_aliases'))return[{alias_number:'OLD-1',created_at:'2026-11-06 16:00:00'}];
  if(sql.includes('FROM product_name_aliases'))return[{alias_name:'旧名',alias_type:'previous_name',active:1,created_at:'2026-11-06 16:00:00'}];
  if(sql.startsWith('SELECT COUNT'))return[{n:count}];
  if(sql.includes('FROM inventory_flow_events'))return events;
  throw Error('Unexpected history query '+sql);
 };
 return{calls,read:createProductEditHistory({query,authorize}).read};
}

test('old name and number aliases remain separate evidence, not invented paired historical versions',async()=>{
 const h=reader(),result=await h.read(23,{},session);
 assert.equal(result.rows.length,0);assert.equal(result.total,0);assert.equal(result.history_complete,false);assert.match(result.history_notice,/不能据此配对/);
 assert.equal(result.number_aliases[0].recorded_at,'2026-11-06 16:00:00');assert.equal(result.number_aliases[0].number,'OLD-1');assert.equal(result.name_aliases[0].name,'旧名');
 assert.ok(h.calls.every(call=>/^SELECT/.test(call.sql)),'reading history never prepares schema or writes a baseline');
 assert.match(h.calls.find(call=>call.sql.includes('FROM product_name_aliases')).sql,/tenant_id = 2/);
 assert.deepEqual(h.calls.find(call=>call.sql.includes('FROM inventory_number_aliases')).args,[23,2]);
 assert.equal(result.current.purchase_cost,undefined);
});

test('history is paged and projected safely, including malformed cross-product snapshots',async()=>{
 const valid={before:{...snapshot({}),purchase_cost:90,purchase_url:'private'},after:snapshot({name:'当前名'}),source:'catalog_edit'};
 const h=reader({count:80,events:[{id:8,person_id:7,actor_name:'本企业人员',created_at:'2026-11-06 16:00:00',detail_json:valid},{id:7,person_id:null,created_at:'2026-11-06 15:00:00',detail_json:{...valid,before:{id:999,name:'foreign secret'}}}]});
 const result=await h.read(23,{page:2,pageSize:10},session);
 assert.equal(result.total,80);assert.deepEqual(h.calls.find(call=>call.sql.includes('actor.name AS actor_name')).args,[2,23,10,10]);
 assert.equal(result.rows[0].source_label,'库存资料编辑');assert.equal(result.rows[0].before.name,'旧名');assert.deepEqual(result.rows[0].changed_fields,['name']);
 assert.equal(result.rows[1].before,null);assert.equal(result.rows[1].after,null);assert.equal(result.rows[1].unavailable,true);
 assert.doesNotMatch(JSON.stringify(result),/foreign secret|private|purchase_cost/);
 for(const params of [{page:'Infinity'},{page:'1e100'},{page:-1},{pageSize:'NaN'}])await assert.rejects(h.read(23,params,session),{statusCode:400});
});

test('authorization and owned product checks precede any historical alias or version read',async()=>{
 const denied=reader({authorize:async()=>({...session,roles:['technical']})});await assert.rejects(denied.read(23,{},session),{statusCode:403});assert.equal(denied.calls.length,0);
 const revoked=reader({authorize:async()=>{throw Object.assign(Error('revoked'),{statusCode:403});}});await assert.rejects(revoked.read(23,{},session),{statusCode:403});assert.equal(revoked.calls.length,0);
 const foreign=reader({product:null});await assert.rejects(foreign.read(23,{},session),{statusCode:404});assert.ok(foreign.calls.every(call=>!call.sql.includes('inventory_flow_events')&&!call.sql.includes('aliases')));
});

test('a missing archived identity field stays unrecorded rather than becoming an empty historical value',async()=>{
 const h=reader({events:[{id:9,created_at:'2026-11-06 16:00:00',detail_json:{source:'catalog_edit',before:{id:23,name:'旧名'},after:{id:23,name:'新名',color:'黑色'}}}]});
 const result=await h.read(23,{},session),row=result.rows[0];
 assert.equal(Object.hasOwn(row.before,'color'),false);assert.equal(Object.hasOwn(row.before,'material'),false);assert.equal(row.after.color,'黑色');assert.deepEqual(row.changed_fields,['name','color']);
});

test('the new history route is an exact GET scoped to the current session, and editing forwards the server actor',async()=>{
 const path=['api','products','23','edit-history'];
 for(const slug of ['default','a']){
  const current={...session,tenant:{...session.tenant,slug}};
  assert.equal(tenantIsolationDecision(current,path,'GET').allowed,true);assert.equal(authorizeApiRequest({_session:current,method:'GET'},path).allowed,true);
  assert.equal(tenantIsolationDecision(current,[...path,'extra'],'GET').allowed,false);assert.equal(tenantIsolationDecision(current,path,'POST').allowed,false);
 }
 let captured;
 const services={productEditHistory:async(...args)=>{captured=args;return{rows:[]};}};
 await handleCatalogRestRoute({req:{method:'GET',_session:session},parts:path,url:new URL('http://localhost:8788/api/products/23/edit-history?page=2&tenant_id=999'),services,json:(_,result)=>result});
 assert.equal(captured[0],23);assert.equal(captured[2],session);
 services.updateProduct=async(...args)=>{captured=args;};services.selectionProduct=async()=>({id:23});
 await handleCatalogRestRoute({req:{method:'PUT',_session:session},parts:path.slice(0,3),services,readJson:async()=>({name:'新名',created_by_person_id:999}),json:(_,result)=>result});
 assert.equal(captured[2],'2');assert.equal(captured[3].session,session);assert.equal(captured[3].personId,undefined);
});
