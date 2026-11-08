import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficDerivedMetrics,normalizeTrafficMonitorQuery} from '../src/shared/sku-traffic-monitor-query.js';
test('operating ratios use explicit denominators, preserve zero, and never fill unknown or zero denominators',()=>{
 assert.deepEqual(trafficDerivedMetrics({total_views:100,search_views:40,pdp_views:20,ordered_units:2}),{search_share:40,detail_view_rate:20,pdp_order_rate:10});
 assert.equal(trafficDerivedMetrics({total_views:100,search_views:0}).search_share,0);
 assert.equal(trafficDerivedMetrics({pdp_views:0,ordered_units:1}).pdp_order_rate,null);
 assert.equal(trafficDerivedMetrics({pdp_views:null,ordered_units:1}).pdp_order_rate,null);
 assert.equal(trafficDerivedMetrics({available:false,pdp_views:10,ordered_units:1}).pdp_order_rate,null);
 assert.equal(trafficDerivedMetrics({pdp_views:1,ordered_units:2}).pdp_order_rate,200);
 const options=normalizeTrafficMonitorQuery({search_by:'inventory_id',query:'123',sort_key:'pdp_order_rate',filters:[{metric:'search_share',op:'gt',value:30}]});assert.equal(options.searchBy,'inventory_id');assert.equal(options.sort,'pdp_order_rate');
});
