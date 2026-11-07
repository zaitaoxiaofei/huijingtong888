import assert from 'node:assert/strict';
import {ensureSellerAnalyticsSchema,queueSkuTrafficDaily,claimNextCollectRequest,finishCollectRequest,sellerAnalyticsDb} from '../../src/services/seller-analytics.js';
import {mysqlQuery,closeMysqlPool} from '../../src/mysql-pool.js';
import {trafficDays} from '../../src/shared/sku-traffic-daily.js';
try{
 await ensureSellerAnalyticsSchema();
 if(process.argv.includes('--bootstrap')) process.exitCode=0;
 else{
  const day=trafficDays().at(-1),queued=await queueSkuTrafficDaily({shop_id:11,date:day},'admin');
  assert.equal(queued.queued.length,1);
  let count=0;
  while(count<5){const request=await claimNextCollectRequest(sellerAnalyticsDb,'admin',{store_id:'111111'});if(!request)break;count++;
   assert.equal(request.request_body.current_period.date_from,day);assert.equal(request.request_body.current_period.date_to,day);
   assert.equal(request.request_body.metrics.length,8);
   const result=await finishCollectRequest(sellerAnalyticsDb,request.run_id,request.request_id,{success:true,response_status:200,request_headers:{'X-O3-Company-Id':'111111'},verified_company_id:'111111',response_body:request.endpoint_type==='by_sku'?{items:[{sku:'same',productInfo:{name:'Temporary name, not a daily column'},metrics:{total_views:25,pdp_views:5,total_hits_to_cart:2,ordered_units:1}},{sku:'zero',metrics:{total_views:0,pdp_views:0,total_hits_to_cart:0,ordered_units:0}}]}:{totals:{total_views:25}}},'admin');
   if(result.run.status==='success')break;
  }
  assert.equal(count,2,'daily collection must not add ABC or extra metric tabs');
  const facts=await mysqlQuery('SELECT sku,total_views FROM seller_sku_traffic_daily WHERE tenant_id=? AND shop_id=? AND date_key=? ORDER BY sku',['admin',11,day]);
  assert.equal(facts.length,2);assert.equal(Number(facts[0].total_views),25);assert.equal(Number(facts[1].total_views),0);
  const [coverage]=await mysqlQuery('SELECT status,product_count FROM seller_sku_traffic_days WHERE tenant_id=? AND shop_id=? AND date_key=?',['admin',11,day]);assert.equal(coverage.status,'complete');assert.equal(coverage.product_count,2);
  const [metrics]=await mysqlQuery('SELECT COUNT(*) n FROM seller_analytics_product_metrics');assert.equal(metrics.n,0,'staged page must not be duplicated per SKU');
  const [snapshots]=await mysqlQuery("SELECT COUNT(*) n FROM seller_analytics_snapshots WHERE source='sku-traffic-daily-stage'");assert.equal(snapshots.n,2);
  console.log(JSON.stringify({ok:true,queued:1,requests:count,day,finalFacts:facts.length,stagedPages:snapshots.n,duplicateMetricRows:metrics.n}));
 }
}finally{await closeMysqlPool();}
