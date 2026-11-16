import assert from 'node:assert/strict';
import {queueSkuTrafficDaily,claimNextCollectRequests,finishCollectRequest,sellerAnalyticsDb} from '../../src/services/seller-analytics.js';
import {mysqlQuery,closeMysqlPool} from '../../src/mysql-pool.js';
import {trafficDays} from '../../src/shared/sku-traffic-daily.js';
try{
 await mysqlQuery("INSERT INTO shops VALUES(66,1,'Concurrent Mart','active','666666'),(77,1,'Concurrent Z','active','777777')");
 const date=trafficDays().at(-1);
 const queued=await Promise.all([queueSkuTrafficDaily({shop_id:66,date},'admin'),queueSkuTrafficDaily({shop_id:77,date},'admin')]);
 assert.ok(queued.every(q=>q.queued.length===1));
 const claims=await Promise.all(['666666','777777'].map(store_id=>claimNextCollectRequests(sellerAnalyticsDb,'admin',2,{store_id})));
 assert.deepEqual(claims.map(c=>c.length),[2,2]);assert.ok(claims.every((requests,i)=>requests.every(r=>r.store_id===['666666','777777'][i])));
 assert.equal(new Set(claims.flat().map(r=>r.request_id)).size,4);
 const makePayload=(r,i)=>({success:true,response_status:200,plugin_instance_id:'browser-'+i,request_headers:{'X-O3-Company-Id':r.store_id},current_company_id:r.store_id,request_body:r.request_body,response_body:r.endpoint_type==='by_sku'?{items:[{productInfo:{sku:'same-sku'},metrics:{totalViews:i+10,pdpViews:2,orderedUnits:1}}]}:{metrics:{totalViews:i+10}}});
 const wrong={...makePayload(claims[0][0],0),current_company_id:'777777'};
 await assert.rejects(finishCollectRequest(sellerAnalyticsDb,claims[0][0].run_id,claims[0][0].request_id,wrong,'admin'),/不一致/);
 await Promise.all(claims.map(async(requests,i)=>{for(const r of requests)await finishCollectRequest(sellerAnalyticsDb,r.run_id,r.request_id,makePayload(r,i),'admin');}));
 const facts=await mysqlQuery("SELECT shop_id,total_views FROM seller_sku_traffic_daily WHERE tenant_id='admin' AND shop_id IN(66,77) AND date_key=? ORDER BY shop_id",[date]);
 assert.deepEqual(facts.map(r=>[r.shop_id,Number(r.total_views)]),[[66,10],[77,11]]);
 const duplicate=await queueSkuTrafficDaily({shop_id:66,date,missing_only:true},'admin');assert.equal(duplicate.queued.length,0);assert.equal(duplicate.completed.length,1);
 console.log(JSON.stringify({ok:true,concurrentShops:2,distinctLeases:4,crossShopResultRejected:true,sameSkuIsolated:true,duplicateDaySkipped:true}));
}finally{await closeMysqlPool();}
