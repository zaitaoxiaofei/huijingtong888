import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficFunnelMetrics} from '../frontend/admin/utils/sku-traffic-funnel.js';
import {trafficRowFocus} from '../frontend/admin/utils/sku-traffic-row-focus.js';
test('non-search exposure and cart-to-card count ratio use known same-period values',()=>{
 const row=trafficFunnelMetrics({total_views:100,search_views:60,pdp_views:10,total_hits_to_cart:15,ordered_units:3});
 assert.equal(row.other_views,40);assert.equal(row.pdp_cart_rate,150);assert.equal(row.cart_order_rate,20);
 assert.equal(trafficFunnelMetrics({ordered_units:2,total_hits_to_cart:0}).cart_order_rate,null);
 for(const source of [{total_views:null,search_views:10},{total_views:100,search_views:null},{total_views:10,search_views:20},{available:false,total_views:100,search_views:10}])assert.equal(trafficFunnelMetrics(source).other_views,null);
 for(const source of [{pdp_views:0,total_hits_to_cart:10},{pdp_views:10,total_hits_to_cart:null}])assert.equal(trafficFunnelMetrics(source).pdp_cart_rate,null);
 assert.equal(trafficFunnelMetrics({total_views:0,search_views:0,pdp_views:10,total_hits_to_cart:0}).other_views,0);
 assert.equal(trafficFunnelMetrics({pdp_views:10,total_hits_to_cart:0}).pdp_cart_rate,0);
});
test('new funnel dimensions can drive the existing daily trend and comparisons',()=>{
 const series=[{date_key:'2026-11-14',available:true,total_views:100,search_views:60,pdp_views:10,total_hits_to_cart:5},{date_key:'2026-11-15',available:true,total_views:100,search_views:40,pdp_views:20,total_hits_to_cart:8}].map(trafficFunnelMetrics);
 assert.equal(trafficRowFocus(series,'other_views').value,60);
 assert.equal(trafficRowFocus(series,'other_views').comparison.value,50);
 assert.equal(trafficRowFocus(series,'pdp_cart_rate').comparison.value,-10);
 assert.equal(trafficRowFocus(series,'pdp_cart_rate').comparison.unit,'个百分点');
});

test('interval ratios divide interval counts instead of averaging daily percentages',()=>{
 const summary=trafficFunnelMetrics({pdp_views:30,total_hits_to_cart:13,ordered_units:6});
 assert.equal(summary.pdp_cart_rate,13/30*100);assert.equal(summary.cart_order_rate,6/13*100);
});
