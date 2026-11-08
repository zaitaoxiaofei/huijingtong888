import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {sellerAnalyticsPluginResultResponse} from '../src/server/seller-analytics-plugin-result.js';
const source=fs.readFileSync('ozon-erp-collector-plugin/analytics/background.js','utf8');
const functionText=source.match(/function compactDailyTrafficResult\([\s\S]*?\n\}/)?.[0];
assert.ok(functionText);
const compact=vm.runInNewContext(functionText+';compactDailyTrafficResult');
const request={daily_traffic:true,endpoint_type:'by_sku',store_id:'1001',request_body:{current_period:{date_from:'2026-11-06',date_to:'2026-11-06'}}};
const payload=()=>({success:true,response_status:200,request_body:request.request_body,current_company_id:'1001',verified_company_id:'1001',request_headers:{'X-O3-Company-Id':'1001',Cookie:'private-cookie',Authorization:'private-token'},response_headers:{'set-cookie':'private-response'},page_url:'https://seller.ozon.ru/app/analytics',response_body:{items:[{productInfo:{sku:'fixture',name:'Do not duplicate product metadata',imageUrl:'https://example.test/large-image.jpg'},metrics:{totalViews:9,searchViews:4,pdpViews:0,totalHitsToCart:0,orderedUnits:0,convViewsToOrder:0,convTotalViewsToCart:0,convHitsToCartToOrder:0,revenue:500,abc:'A'}}],has_more:true,nextOffset:'30'}});

test('generated plugin uploads only daily SKU indicators, observed identity/date and pagination evidence',()=>{
 const input=payload(),before=JSON.stringify(input),result=JSON.parse(JSON.stringify(compact(request,input)));
 assert.equal(JSON.stringify(input),before,'source response must remain untouched');
 assert.deepEqual(result.request_headers,{'X-O3-Company-Id':'1001'});
 assert.deepEqual(result.request_body,request.request_body);
 assert.equal(result.response_body.has_more,true);assert.equal(result.response_body.nextOffset,30);
 assert.deepEqual(result.response_body.items[0],{sku:'fixture',metrics:{total_views:9,search_views:4,pdp_views:0,total_hits_to_cart:0,ordered_units:0,conv_views_to_order:0,conv_total_views_to_cart:0,conv_hits_to_cart_to_order:0}});
 assert.doesNotMatch(JSON.stringify(result),/private-|imageUrl|productInfo|revenue|abc|page_url|response_headers/);
 const legacy=payload();assert.equal(compact({...request,daily_traffic:false},legacy),legacy);assert.equal(compact({...request,daily_traffic:undefined},legacy),legacy);
});

test('compact upload refuses unverified days/stores, malformed rows, duplicates and invalid metrics',()=>{
 const wrongDay=payload();wrongDay.request_body={current_period:{date_from:'2026-11-05',date_to:'2026-11-06'}};
 const wrongStore=payload();wrongStore.request_headers={'X-O3-Company-Id':'1002'};
 const noIdentity=payload();noIdentity.request_headers={};
 const unknown=payload();unknown.response_body={new_shape:{items:[]}};
 const duplicate=payload();duplicate.response_body.items.push(duplicate.response_body.items[0]);
 const invalid=payload();invalid.response_body.items[0].metrics.totalViews=-1;
 const missing=payload();missing.response_body.items[0].metrics={unrelated:4};
 for(const input of [wrongDay,wrongStore,noIdentity,unknown,duplicate,invalid,missing])assert.throws(()=>compact(request,input));
 const empty=payload();empty.response_body={items:[]};assert.equal(compact(request,empty).response_body.items.length,0);
 const nullable=payload();nullable.response_body.items[0].metrics={total_views:null,totalViews:9,pdpViews:{value:0},orderedUnits:1};
 const metrics=compact(request,nullable).response_body.items[0].metrics;assert.equal(metrics.total_views,null);assert.equal(metrics.pdp_views,0);assert.equal(metrics.search_views,null);
});

test('compact server acknowledgements stay bounded as the run grows and old plugins retain their response',()=>{
 const result={run:{id:'run',daily_traffic:true,status:'running',completed_count:1,failed_count:0,request_count:500,requests:Array.from({length:500},()=>({raw:'private-run-state'.repeat(100)}))},request:{id:'request',status:'success'},snapshot:{response_body:payload().response_body,request_headers:{Cookie:'private-cookie'}},metricCount:0};
 const ack=sellerAnalyticsPluginResultResponse(result,true);
 assert.ok(JSON.stringify(ack).length<400);assert.doesNotMatch(JSON.stringify(ack),/private-|snapshot|requests|productInfo/);
 assert.equal(ack.data.run.completed_count,1);assert.equal(ack.data.request.id,'request');
 assert.equal(sellerAnalyticsPluginResultResponse(result,false).data,result);
 assert.equal(sellerAnalyticsPluginResultResponse({...result,run:{...result.run,daily_traffic:false}},true).snapshot,result.snapshot);
});
