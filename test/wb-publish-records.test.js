import test from 'node:test';
import assert from 'node:assert/strict';
import {createWbPublishRecords,wbPublishRecordView,wbListingCompleteness} from '../src/services/wb-publish-records.js';
import {wbRoutePermission} from '../src/server/wb-paths.js';

const variant=(vendor='NEW')=>({card:{vendorCode:vendor,title:'Product',dimensions:{length:12,width:8,height:4,weightBrutto:.2},sizes:[{price:258,skus:['submitted-only']}],characteristics:[{id:7,value:0}]},images:['https://example.test/submitted.jpg']});
function fixture(){
 const payload={template_id:4,subject_id:5,currency:'CNY',attributes_schema:[{charcID:7,charcType:4,required:true}],variants:[variant()],card:variant().card};
 const job={id:1,tenant_id:2,shop_id:3,person_id:8,status:'completed',created_at:'2026-11-13 01:00:00',updated_at:'2026-11-13 02:00:00',shop_name:'Shop',publisher_name:'Publisher',category_name:'Category',payload_json:JSON.stringify(payload),state_json:JSON.stringify({items:[{vendor_code:'NEW',nm_id:50,phase:'done'}]})};
 const state={job,cards:[],calls:[],requests:[],snapshots:0};
 const service=createWbPublishRecords({
  account:async(tenant,shop)=>{assert.equal(tenant,2);assert.equal(shop,3);return{tenant_id:2,shop_id:3};},
  query:async(sql,args)=>{
   state.calls.push({sql,args});
   if(sql.startsWith('SELECT j.*')){if(sql.includes('WHERE j.id=?'))return args[0]===1&&args[1]===2?[structuredClone(job)]:[];return args[0]===2&&!JSON.parse(job.state_json).record_hidden?[structuredClone(job)]:[];}
   if(sql.startsWith('SELECT * FROM wb_product_cards'))return args[0]===2?structuredClone(state.cards):[];
   if(sql.startsWith('INSERT INTO wb_product_cards')){state.cards=[{id:10,tenant_id:args[0],shop_id:args[1],nm_id:args[2],vendor_code:args[3],raw_json:args[5],synced_at:'2026-11-13 03:00:00'}];return {insertId:10};}
   if(sql.startsWith('UPDATE wb_publish_jobs')){if(args[0]!==1||args[1]!==2||['queued','processing'].includes(job.status))return{affectedRows:0};job.state_json=JSON.stringify({...JSON.parse(job.state_json),record_hidden:true});return {affectedRows:1};}
   throw Error('Unexpected SQL: '+sql);
  },
  request:async(a,service,path,options)=>{state.requests.push({path,options});return {cards:[{nmID:50,vendorCode:'NEW',title:'Online product',createdAt:'2026-11-13T01:00:00Z',photos:[{big:'https://example.test/online.jpg'}],sizes:[{chrtID:60,skus:['online-barcode']}],dimensions:variant().card.dimensions,characteristics:variant().card.characteristics}]};},
  refreshProductSnapshots:async()=>{state.snapshots++;const card=JSON.parse(state.cards[0].raw_json);card._erp_snapshot={price_info:{currency:'CNY',sizes:[{chrt_id:60,price:299,original_price:299}]}};state.cards[0].raw_json=JSON.stringify(card);return {warnings:[]};}
 });
 return {service,state};
}

test('publish record reads show frozen content, provenance and honest unknown online identifiers',async()=>{
 const {service,state}=fixture(),result=await service.publishRecords(2),record=result.rows[0];
 assert.equal(record.publisher_name,'Publisher');assert.equal(record.category_name,'Category');assert.equal(record.products[0].title,'Product');
 assert.deepEqual(record.products[0].images,['https://example.test/submitted.jpg']);assert.deepEqual(record.products[0].barcodes,[]);
 assert.equal(record.products[0].online_status,'not_synced');assert.equal(record.products[0].price_source,'submitted');
 assert.equal(record.score,100);assert.equal(record.score_source,'erp_completeness');assert.equal(record.score_label,'ERP资料完整度');
 assert.equal(state.requests.length,0);assert.ok(state.calls.every(call=>call.sql.startsWith('SELECT')));
});

test('SKU synchronization reads exact frozen target and enriches actual barcodes and price without changing job history',async()=>{
 const {service,state}=fixture(),before=structuredClone(state.job),result=await service.syncPublishRecord(2,{job_id:1});
 assert.equal(result.job.products[0].nm_id,50);assert.deepEqual(result.job.products[0].barcodes,['online-barcode']);assert.equal(result.job.products[0].price,299);assert.equal(result.job.products[0].price_source,'online');
 assert.equal(result.job.products[0].published_at,'2026-11-13T01:00:00Z');assert.equal(state.snapshots,1);assert.deepEqual(state.job,before);
 assert.ok(state.requests.every(call=>call.path==='/content/v2/get/cards/list'&&call.options.method==='POST'));
 await assert.rejects(service.syncPublishRecord(99,{job_id:1}),error=>error.statusCode===404);
});

test('record deletion hides only the tenant-owned local entry and keeps frozen payload, task status and draft identity',async()=>{
 const {service,state}=fixture(),before=structuredClone(state.job);await service.deletePublishRecord(2,{job_id:1});
 assert.equal((await service.publishRecords(2)).rows.length,0);assert.equal(state.job.payload_json,before.payload_json);assert.equal(state.job.status,before.status);
 assert.deepEqual(JSON.parse(state.job.state_json).items,JSON.parse(before.state_json).items);assert.equal(state.requests.length,0);
 await assert.rejects(service.deletePublishRecord(99,{job_id:1}),error=>error.statusCode===404);
 for(const status of ['queued','processing']){state.job.status=status;await assert.rejects(service.deletePublishRecord(2,{job_id:1}),error=>error.statusCode===409);}
});

test('record enrichment never matches another shop and content completeness is explicitly ERP-only',()=>{
 const {state}=fixture();const foreign={shop_id:9,nm_id:50,raw_json:JSON.stringify({nmID:50,title:'Foreign',sizes:[{skus:['foreign']}],photos:[]})};
 const result=wbPublishRecordView(state.job,[foreign]);assert.equal(result.products[0].title,'Product');assert.deepEqual(result.products[0].barcodes,[]);
 const incomplete=variant();incomplete.images=[];incomplete.card.sizes[0].price=null;
 assert.ok(wbListingCompleteness(incomplete,{})<100);assert.equal(wbListingCompleteness(variant(),{attributes_schema:[{charcID:7,charcType:4,required:true}]}),100);
});

test('local inventory writes and record actions have explicit route permissions',()=>{
 for(const path of ['products/bind','products/create-inventory'])assert.equal(wbRoutePermission(['api','wb',...path.split('/')],'POST'),'inventory.write');
 for(const path of ['products/refresh','publish-records/sync','publish-records/delete'])assert.equal(wbRoutePermission(['api','wb',...path.split('/')],'POST'),'operations');
 assert.equal(wbRoutePermission(['api','wb','publish-records'],'GET'),'operations');
 assert.equal(wbRoutePermission(['api','wb','publish-records','delete'],'DELETE'),null);
});

test('missing online amounts retain a consistently labeled submitted price while a real returned zero stays online',()=>{
 const {state}=fixture(),card={nmID:50,vendorCode:'NEW',sizes:[{chrtID:60,skus:['online']}],_erp_snapshot:{price_info:{currency:'RUB',sizes:[{chrt_id:60,price:null}]}}};
 const project=()=>wbPublishRecordView(state.job,[{shop_id:3,nm_id:50,raw_json:JSON.stringify(card)}]).products[0];
 for(const missing of [null,undefined,'',false,' ',{}]){
  card._erp_snapshot.price_info.sizes[0].price=missing;const result=project();
  assert.equal(result.price,258);assert.deepEqual(result.prices,[258]);assert.equal(result.currency,'CNY');assert.equal(result.price_source,'submitted');
 }
 card._erp_snapshot.price_info.sizes[0].price=0;const zero=project();assert.equal(zero.price,0);assert.deepEqual(zero.prices,[0]);assert.equal(zero.currency,'RUB');assert.equal(zero.price_source,'online');
});
