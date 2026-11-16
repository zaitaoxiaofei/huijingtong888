import assert from 'node:assert/strict';
import {queueSkuTrafficDaily,claimNextCollectRequests,finishCollectRequest,sellerAnalyticsDb} from '../../src/services/seller-analytics.js';
import {mysqlQuery,closeMysqlPool} from '../../src/mysql-pool.js';
import {trafficDays} from '../../src/shared/sku-traffic-daily.js';
try{
 await mysqlQuery("INSERT INTO shops VALUES(88,1,'Partition fixture','active','888888')");const date=trafficDays().at(-1);
 await queueSkuTrafficDaily({shop_id:88,date,category_partitioning:true},'admin');let count=0;
 const metrics=n=>({totalViews:n,searchViews:0,pdpViews:0,totalHitsToCart:0,orderedUnits:0,convViewsToOrder:0,convTotalViewsToCart:0,convHitsToCartToOrder:0});
 for(let i=0;i<50;i++){
  const claims=await claimNextCollectRequests(sellerAnalyticsDb,'admin',2,{store_id:'888888'});if(!claims.length)break;
  for(const r of claims){
   const filter=r.request_body.filters?.category_2_ids||[];
   const response=r.endpoint_type==='totals'?{metrics:metrics(7)}:r.endpoint_type==='category_tree'?{result:{1:{descriptionCategoryId:'1',nodes:{}},2:{descriptionCategoryId:'2',nodes:{}}}}:filter.length?{items:filter[0]==='1'?[{productInfo:{sku:'A'},metrics:metrics(3)},{productInfo:{sku:'B'},metrics:metrics(4)}]:[]}:{items:Array.from({length:30},(_,i)=>({productInfo:{sku:'parent-'+r.page_index+'-'+i},metrics:metrics(1)}))};
   await finishCollectRequest(sellerAnalyticsDb,r.run_id,r.request_id,{success:true,response_status:200,request_body:r.request_body,request_headers:r.request_headers,current_company_id:r.store_id,plugin_instance_id:'partition-browser',response_body:response},'admin');count++;
  }
 }
 const [day]=await mysqlQuery("SELECT status,product_count FROM seller_sku_traffic_days WHERE tenant_id='admin' AND shop_id=88 AND date_key=?",[date]);assert.equal(day.status,'complete');assert.equal(day.product_count,2);
 const facts=await mysqlQuery("SELECT sku,total_views FROM seller_sku_traffic_daily WHERE shop_id=88 ORDER BY sku");assert.deepEqual(facts.map(r=>[r.sku,Number(r.total_views)]),[['A',3],['B',4]]);
 assert.ok(count>35);console.log(JSON.stringify({ok:true,requests:count,finalSkus:2,supersededPagesExcluded:true,categoryChildrenClaimable:true,totalsReconciled:true}));
}finally{await closeMysqlPool();}
