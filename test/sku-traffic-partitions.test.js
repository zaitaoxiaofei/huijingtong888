import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficCategoryPartitions,trafficPartitionFilters,reconcileDailyTotals} from '../src/shared/sku-traffic-partitions.js';
import {dailyTrafficCoverage} from '../src/shared/sku-traffic-daily.js';
test('category partitions preserve official hierarchy and reject malformed plans',()=>{
 const roots=trafficCategoryPartitions({result:{1:{descriptionCategoryId:'1',nodes:{2:{descriptionCategoryId:'2',nodes:{3:{descriptionTypeId:'3'}}}}}}});
 assert.deepEqual(trafficPartitionFilters(roots[0]),{desc_type_ids:[],category_3_ids:[],category_2_ids:['1']});
 assert.deepEqual(trafficPartitionFilters(roots[0].children[0].children[0]),{desc_type_ids:['3'],category_3_ids:[],category_2_ids:[]});
 assert.throws(()=>trafficCategoryPartitions({result:{}}),/为空/);
});
test('partition coverage needs every planned leaf and continuous terminal pages; superseded parent pages do not publish',()=>{
 const page=(partition_key,page_index,count)=>({partition_key,page_index,source_key:'all_metrics',endpoint_type:'by_sku',status:'success',auto_all_pages:true,limit:50,returned_count:count,snapshot_id:partition_key+':'+page_index});
 const run={status:'success',current_period:{date_from:'2026-11-15',date_to:'2026-11-15'},daily_partition_leaves:['1:2','1:3'],requests:[{...page(undefined,0,50),partition_replaced:true},page('1:2',0,50),page('1:2',1,2),page('1:3',0,0)]};
 const result=dailyTrafficCoverage(run);assert.equal(result.complete,true);assert.equal(result.expectedRows,52);assert.equal(result.snapshotIds.length,3);
 assert.equal(dailyTrafficCoverage({...run,requests:run.requests.slice(0,-1)}).ok,false);
 assert.equal(dailyTrafficCoverage({...run,requests:run.requests.map(r=>r.partition_key==='1:3'?{...r,returned_count:50}:r)}).complete,false);
 const metrics={total_views:20,search_views:10,pdp_views:5,total_hits_to_cart:3,ordered_units:1};reconcileDailyTotals([metrics],{metrics});
 assert.throws(()=>reconcileDailyTotals([metrics],{metrics:{...metrics,ordered_units:2}}),/不一致/);
});
