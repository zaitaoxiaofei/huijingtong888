import assert from 'node:assert/strict';
import {queueSkuTrafficDaily,claimNextCollectRequests,finishCollectRequest,cancelCollectRun,sellerAnalyticsDb} from '../../src/services/seller-analytics.js';
import {mysqlQuery,closeMysqlPool} from '../../src/mysql-pool.js';
import {trafficDays,shiftTrafficDate} from '../../src/shared/sku-traffic-daily.js';
try{
 await mysqlQuery("INSERT INTO shops VALUES(188,1,'Week shop','active','1888888'),(199,1,'Other week shop','active','1999999')");
 const end=shiftTrafficDate(trafficDays().at(-1),-2),complete=shiftTrafficDate(end,-3);
 await mysqlQuery("INSERT INTO seller_sku_traffic_days(tenant_id,shop_id,date_key,status,requested_at,last_success_at) VALUES('admin',188,?,'complete',UTC_TIMESTAMP(),UTC_TIMESTAMP())",[complete]);
 await mysqlQuery("INSERT INTO seller_sku_traffic_days(tenant_id,shop_id,date_key,status,requested_at) VALUES('admin',188,?,'partial',UTC_TIMESTAMP()),('admin',188,?,'failed',UTC_TIMESTAMP())",[shiftTrafficDate(end,-1),shiftTrafficDate(end,-2)]);
 const payload={shop_id:188,end_date:end,range_days:7,missing_only:true};
 const first=await queueSkuTrafficDaily(payload,'admin');
 assert.equal(first.queued.length,6);assert.equal(first.skipped,1);
 const expected=Array.from({length:7},(_,i)=>shiftTrafficDate(end,-i)).filter(d=>d!==complete);
 assert.deepEqual(first.queued.map(q=>q.day),expected);
 const duplicate=await queueSkuTrafficDaily(payload,'admin');assert.equal(duplicate.queued.length,0);assert.equal(duplicate.waiting.length,6);
 const otherQueue=await queueSkuTrafficDaily({shop_id:199,end_date:end,range_days:7,missing_only:true},'admin');
 const visited=[];
 for(const day of expected){
  const requests=await claimNextCollectRequests(sellerAnalyticsDb,'admin',20,{store_id:'1888888'});
  assert.equal(requests.length,2);assert.equal(new Set(requests.map(r=>r.run_id)).size,1);
  assert.ok(requests.every(r=>r.current_period.date_from===day));
  assert.equal((await claimNextCollectRequests(sellerAnalyticsDb,'admin',20,{store_id:'1888888'})).length,0);
  if(!visited.length){const other=await claimNextCollectRequests(sellerAnalyticsDb,'admin',20,{store_id:'1999999'});assert.equal(other.length,2);assert.ok(other.every(r=>r.store_id==='1999999'));}
  for(const r of requests)await finishCollectRequest(sellerAnalyticsDb,r.run_id,r.request_id,{success:true,response_status:200,current_company_id:'1888888',request_headers:{'X-O3-Company-Id':'1888888'},request_body:r.request_body,response_body:r.endpoint_type==='by_sku'?{items:[{productInfo:{sku:'week-sku'},metrics:{totalViews:10,pdpViews:2,orderedUnits:1}}]}:{metrics:{totalViews:10}}},'admin');
  visited.push(day);
 }
 assert.deepEqual(visited,expected);
 const final=await queueSkuTrafficDaily(payload,'admin');assert.equal(final.queued.length,0);assert.equal(final.skipped,7);
 for(const run of otherQueue.queued)await cancelCollectRun(sellerAnalyticsDb,run.run_id,'admin');
 for(const table of ['seller_sku_traffic_daily','seller_sku_traffic_days'])await mysqlQuery(`DELETE FROM ${table} WHERE tenant_id='admin' AND shop_id IN (188,199)`);
 await mysqlQuery('DELETE FROM shops WHERE id IN (188,199)');
 console.log(JSON.stringify({ok:true,queued:6,skippedComplete:1,datesRunInOrder:visited,sameShopSequential:true,otherShopConcurrent:true}));
}finally{await closeMysqlPool();}
