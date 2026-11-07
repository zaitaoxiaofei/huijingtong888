import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficDate,trafficDays,trafficToday,dailyTrafficCoverage,normalizeDailyTrafficMetric,dailyTrafficSeries} from '../src/shared/sku-traffic-daily.js';
import {createCollectRun,saveSnapshot,finishCollectRequest} from '../src/services/seller-analytics.js';
import {createSellerAnalyticsRoutes} from '../src/server/routes/sellerAnalytics.js';
import {tenantIsolationDecision} from '../src/server/tenant-isolation.js';
const page=(index,count=2)=>({source_key:'all_metrics',endpoint_type:'by_sku',page_index:index,status:'success',auto_all_pages:true,snapshot_id:'p'+index,limit:2,returned_count:count});
const run=(requests=[page(0,1)])=>({id:'r',store_id:'s',status:'success',daily_traffic:true,current_period:{date_from:'2026-11-05',date_to:'2026-11-05'},requests});

test('retention uses Beijing calendar days and rejects invalid dates',()=>{
 assert.equal(trafficToday(new Date('2026-11-05T16:01:00Z')),'2026-11-06');
 const days=trafficDays(new Date('2026-11-05T16:01:00Z'));assert.equal(days.length,15);assert.equal(days[0],'2026-10-22');assert.equal(days.at(-1),'2026-11-05');
 for(const value of ['2026-02-30','2026-99-99','today',''])assert.equal(trafficDate(value),'');
});
test('only a fully completed single-day SKU chain can publish, including a proven empty day',()=>{
 assert.equal(dailyTrafficCoverage(run()).ok,true);assert.equal(dailyTrafficCoverage(run([page(0,0)])).expectedRows,0);
 assert.equal(dailyTrafficCoverage(run([page(0),page(1,1)])).ok,true);
 const failures=[{...run(),status:'failed'},{...run(),current_period:{date_from:'2026-10-30',date_to:'2026-11-05'}},run([page(0)]),run([page(1,1)]),run([page(0,1),page(1,1)]),run([{...page(0,1),auto_all_pages:false}]),run([{...page(0,1),snapshot_id:null}])];
 for(const r of failures)assert.equal(dailyTrafficCoverage(r).ok,false);
});
test('daily facts preserve missing versus zero and retain exact official meanings without metadata/raw duplication',()=>{
 const row=normalizeDailyTrafficMetric({sku:'123',product_name:'Not repeated',image_url:'not stored',raw_data:JSON.stringify({metrics:{total_views:0,pdp_views:10,total_hits_to_cart:2,ordered_units:1,conv_views_to_order:3}})});
 assert.equal(row.total_views,0);assert.equal(row.search_views,null);assert.equal(row.ordered_units,1);assert.equal(row.conv_total_views_to_cart,null);
 for(const key of ['raw_data','product_name','image_url','clicks','order_count'])assert.equal(key in row,false);
 assert.throws(()=>normalizeDailyTrafficMetric({sku:'123',raw_data:{metrics:{total_views:-1}}}));
 assert.throws(()=>normalizeDailyTrafficMetric({sku:'123',raw_data:{metrics:{unrecognized:1}}}));
 assert.throws(()=>normalizeDailyTrafficMetric({raw_data:{metrics:{total_views:1}}}));
});
test('missing dates remain null and actual zero remains a plotted point',()=>{
 const series=dailyTrafficSeries(['2026-11-04','2026-11-05'],[{date_key:'2026-11-05',total_views:0}]);
 assert.equal(series[0].available,false);assert.equal(series[0].total_views,null);assert.equal(series[1].available,true);assert.equal(series[1].total_views,0);
});
test('daily API scope comes from session, all registered paths are tenant-gated',async()=>{
 const calls=[];const routes=createSellerAnalyticsRoutes({services:{skuTrafficDailyRead:async(...args)=>calls.push(args),skuTrafficDailyQueue:async(...args)=>calls.push(args)},readJson:async()=>({shop_id:4,tenant_id:999})});
 const req={_session:{tenant:{id:2,slug:'customer'}}};
 await routes['GET /api/db/seller-analytics/sku-daily'](req,new URL('http://local/api/db/seller-analytics/sku-daily?tenant_id=999&shop_id=4'));
 await routes['POST /api/db/seller-analytics/sku-daily/collect'](req);
 assert.deepEqual(calls,[[{shop_id:'4'},'2'],[{shop_id:4},'2']]);
 for(const [method,path] of [['GET','/api/db/seller-analytics/sku-daily'],['POST','/api/db/seller-analytics/sku-daily/collect']])assert.equal(tenantIsolationDecision(req._session,path.split('/').filter(Boolean),method).allowed,true);
 assert.throws(()=>routes['GET /api/db/seller-analytics/sku-daily']({},new URL('http://local/')),/企业上下文/);
});

function memoryDb(){
 const tables={Setting:[],SellerAnalyticsSnapshot:[],SellerAnalyticsProductMetric:[]};
 const match=(row,where)=>Object.entries(where||{}).every(([k,v])=>v&&typeof v==='object'&&v.__sellerAnalyticsOp==='in'?v.values.includes(row[k]):row[k]===v);
 return{tables,getRepository(name){return{async save(value){for(const row of Array.isArray(value)?value:[value]){const found=tables[name].findIndex(x=>name==='Setting'?x.key===row.key&&x.tenant_id===row.tenant_id:x.id===row.id);if(found>=0)tables[name][found]=row;else tables[name].push(row);}return value;},async find({where}={}){return tables[name].filter(r=>match(r,where));},async findOne({where}={}){return tables[name].find(r=>match(r,where))||null;},async delete(where){tables[name]=tables[name].filter(r=>!match(r,where));return{affected:0};},createQueryBuilder(){const context={where(){return context;},andWhere(){return context;},orderBy(){return context;},take(){return context;},async getMany(){return tables[name];}};return context;}};}};
}
test('daily collector requests only needed metrics and stages each response once without per-SKU raw rows',async()=>{
 const db=memoryDb();
 const r=await createCollectRun(db,{daily_traffic:true,period_key:'custom',date_from:'2026-11-05',date_to:'2026-11-05',store_id:'5',company_id:'5',source_keys:['all_metrics'],full_store:true,limit:2},'admin');
 assert.equal(r.daily_traffic,true);assert.equal(r.requests[0].request_body.metrics.length,8);
 assert.ok(!r.requests[0].request_body.metrics.includes('revenue'));
 assert.equal(r.requests[1].request_body.sort.key,'total_views_sort');
 const payload={daily_traffic:true,source:'sku-traffic-daily-stage',store_id:'5',period_key:'custom',request_url:r.requests[1].request_url,request_body:r.requests[1].request_body,response_status:200,response_body:{items:[{sku:'123',metrics:{total_views:2}}]}};
 await saveSnapshot(db,payload,'admin');await saveSnapshot(db,{...payload,request_body:{...payload.request_body,current_period:{date_from:'2026-11-04',date_to:'2026-11-04'}}},'admin');
 assert.equal(db.tables.SellerAnalyticsSnapshot.length,2);assert.equal(db.tables.SellerAnalyticsProductMetric.length,0);
 // Another day cannot delete a staged page needed by a concurrent day run.
 assert.equal(JSON.parse(db.tables.SellerAnalyticsSnapshot[0].response_body).items[0].metrics.total_views,2);
});


test('unknown daily response shape cannot be treated as an empty successful day',async()=>{
 const db=memoryDb();const r=await createCollectRun(db,{daily_traffic:true,period_key:'custom',date_from:'2026-11-05',date_to:'2026-11-05',store_id:'111111',company_id:'111111',source_keys:['all_metrics'],full_store:true},'admin');
 const request=r.requests.find(q=>q.endpoint_type==='by_sku');
 const result=await finishCollectRequest(db,r.id,request.id,{success:true,response_status:200,request_headers:{'X-O3-Company-Id':'111111'},response_body:{new_shape:{entries:[]}}},'admin');
 assert.equal(result.request.status,'failed');assert.match(result.request.error_message,/不当作空日/);assert.equal(db.tables.SellerAnalyticsSnapshot.length,0);
});


test('subsequent daily pages keep the compact metric request and do not enqueue ABC',async()=>{
 const db=memoryDb();const r=await createCollectRun(db,{daily_traffic:true,period_key:'custom',date_from:'2026-11-05',date_to:'2026-11-05',store_id:'111111',company_id:'111111',source_keys:['all_metrics'],full_store:true,limit:2},'admin');
 const request=r.requests.find(q=>q.endpoint_type==='by_sku');
 const result=await finishCollectRequest(db,r.id,request.id,{success:true,response_status:200,request_headers:{'X-O3-Company-Id':'111111'},response_body:{items:[{sku:'1',metrics:{total_views:2}},{sku:'2',metrics:{total_views:3}}]}},'admin');
 const next=result.run.requests.find(q=>q.endpoint_type==='by_sku'&&q.page_index===1);
 assert.equal(next.request_body.metrics.length,8);assert.equal(next.request_body.sort.key,'total_views_sort');assert.equal(result.run.requests.some(q=>q.endpoint_type==='abc_analysis'),false);
});


test('an observed seven-day request cannot be labelled as one-day traffic',async()=>{
 const db=memoryDb();const r=await createCollectRun(db,{daily_traffic:true,period_key:'custom',date_from:'2026-11-05',date_to:'2026-11-05',store_id:'111111',company_id:'111111',source_keys:['all_metrics'],full_store:true},'admin');
 const request=r.requests.find(q=>q.endpoint_type==='by_sku');
 const result=await finishCollectRequest(db,r.id,request.id,{success:true,response_status:200,request_headers:{'X-O3-Company-Id':'111111'},request_body:{current_period:{date_from:'2026-10-30',date_to:'2026-11-05'}},response_body:{items:[]}},'admin');
 assert.equal(result.request.status,'failed');assert.match(result.request.error_message,/实际请求日期/);assert.equal(db.tables.SellerAnalyticsSnapshot.length,0);
});


test('official nullable metric envelopes remain missing without dropping valid daily counts',()=>{
 const row=normalizeDailyTrafficMetric({sku:'fixture',raw_data:{metrics:{total_views:{value:0},pdp_views:{value:12},conv_views_to_order:{value:null},conv_total_views_to_cart:{value:''}}}});
 assert.equal(row.total_views,0);assert.equal(row.pdp_views,12);assert.equal(row.conv_views_to_order,null);assert.equal(row.conv_total_views_to_cart,null);
 assert.throws(()=>normalizeDailyTrafficMetric({sku:'fixture',raw_data:{metrics:{total_views:{unknown:2}}}}));
});


test('explicit offset-cap coverage can retain observed SKU facts but cannot claim a full shop',()=>{
 const capped=run([{...page(0,2),auto_stop_code:'source_offset_cap'}]);
 assert.equal(dailyTrafficCoverage(capped).ok,false);
 const partial=dailyTrafficCoverage(capped,{allowPartial:true});assert.equal(partial.ok,true);assert.equal(partial.complete,false);assert.equal(partial.expectedRows,2);
 assert.equal(dailyTrafficCoverage(run([page(0,2)]),{allowPartial:true}).ok,false);
 assert.equal(dailyTrafficCoverage(run([{...page(1,2),auto_stop_code:'source_offset_cap'}]),{allowPartial:true}).ok,false);
 assert.equal(dailyTrafficCoverage(run(),{allowPartial:true}).complete,true);
});

test('the real controlled paginator labels its 1000-row source cap and retains all received daily pages',async()=>{
 const db=memoryDb();let current=await createCollectRun(db,{daily_traffic:true,period_key:'custom',date_from:'2026-11-05',date_to:'2026-11-05',store_id:'555555',company_id:'555555',source_keys:['all_metrics'],full_store:true,auto_all_pages:true,limit:100,max_pages:500},'admin');
 for(let index=0;index<12;index++){
  const request=current.requests.find(r=>r.status==='pending');if(!request)break;
  const items=Array.from({length:100},(_,i)=>({sku:String(request.page_index*100+i),metrics:{total_views:i}}));
  const result=await finishCollectRequest(db,current.id,request.id,{success:true,response_status:200,request_headers:{'X-O3-Company-Id':'555555'},verified_company_id:'555555',response_body:request.endpoint_type==='by_sku'?{items}:{totals:{total_views:1}}},'admin');current=result.run;
 }
 assert.equal(current.status,'success');
 const coverage=dailyTrafficCoverage(current,{allowPartial:true});assert.equal(coverage.ok,true);assert.equal(coverage.complete,false);assert.equal(coverage.expectedRows,1000);assert.equal(coverage.snapshotIds.length,10);
 assert.equal(dailyTrafficCoverage(current).ok,false);
 assert.equal(db.tables.SellerAnalyticsProductMetric.length,0);
});
