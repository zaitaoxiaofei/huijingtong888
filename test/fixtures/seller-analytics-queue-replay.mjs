import assert from 'node:assert/strict';
import {createCollectRun,claimNextCollectRequests,finishCollectRequest,sellerAnalyticsDb} from '../../src/services/seller-analytics.js';
import {mysqlQuery,closeMysqlPool} from '../../src/mysql-pool.js';
import {trafficDays} from '../../src/shared/sku-traffic-daily.js';

try {
  const day=trafficDays().at(-1);
  const run=await createCollectRun(sellerAnalyticsDb,{daily_traffic:true,period_key:'custom',date_from:day,date_to:day,store_id:'111111',source_keys:['all_metrics'],auto_all_pages:true,limit:2},'admin');
  const batch=await claimNextCollectRequests(sellerAnalyticsDb,'admin',2,{store_id:'111111'});
  assert.equal(batch.length,2);
  const payload={success:true,response_status:200,request_headers:{'X-O3-Company-Id':'111111'},verified_company_id:'111111'};
  const skuRequest=batch.find(request=>request.endpoint_type==='by_sku');
  for(const request of batch)await finishCollectRequest(sellerAnalyticsDb,run.id,request.request_id,{...payload,response_body:request.endpoint_type==='by_sku'?{items:[{sku:'r1',metrics:{total_views:2}},{sku:'r2',metrics:{total_views:3}}]}:{totals:{total_views:5}}},'admin');
  const [next]=await mysqlQuery("SELECT id FROM seller_analytics_collect_requests WHERE run_id=? AND status='pending'",[run.id]);
  assert.ok(next,'full page must enqueue its next page');
  // Simulate canonical state persisted but its queue insertion being lost.
  await mysqlQuery('DELETE FROM seller_analytics_collect_requests WHERE id=?',[next.id]);
  const replay=await finishCollectRequest(sellerAnalyticsDb,run.id,skuRequest.request_id,payload,'admin');
  assert.equal(replay.snapshot,null,'replay must not save a second copy');
  const child=await claimNextCollectRequests(sellerAnalyticsDb,'admin',1,{store_id:'111111'});
  assert.equal(child.length,1);assert.equal(child[0].request_id,next.id);
  await finishCollectRequest(sellerAnalyticsDb,run.id,skuRequest.request_id,payload,'admin');
  const [lease]=await mysqlQuery('SELECT status,attempts,claimed_at FROM seller_analytics_collect_requests WHERE id=?',[next.id]);
  assert.equal(lease.status,'running','replayed parent must not reset an already claimed child');
  assert.equal(Number(lease.attempts),1);assert.ok(lease.claimed_at);
  const completed=await finishCollectRequest(sellerAnalyticsDb,run.id,next.id,{...payload,response_body:{items:[]}},'admin');
  assert.equal(completed.run.status,'success');
  const snapshots=await mysqlQuery("SELECT COUNT(*) n FROM seller_analytics_snapshots WHERE JSON_UNQUOTE(JSON_EXTRACT(source_context,'$.collection_run_id'))=?",[run.id]);
  assert.equal(Number(snapshots[0].n),3,'duplicate callbacks must not duplicate snapshots');
  console.log(JSON.stringify({ok:true,requests:3,replayedWithoutDuplicate:true,missingChildRepaired:true}));
} finally {await closeMysqlPool();}
