import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficRowSeries} from '../frontend/admin/utils/sku-traffic-row-series.js';
import {renderTrafficRows} from './helpers/sku-traffic-row-render.mjs';
test('compact page histories preserve distinct SKU dates, missing values and real zeros',()=>{
 const response={series_days:['2026-11-01','2026-11-02','2026-11-03'],series_columns:['total_views','ordered_units'],range_from:'2026-11-01',date:'2026-11-03'};
 const series=trafficRowSeries({trend_values:[[0,0],null,[10,1]]},response);
 assert.equal(series[0].total_views,0);assert.equal(series[0].available,true);assert.equal(series[1].available,false);assert.equal(series[1].total_views,null);assert.equal(series[2].ordered_units,1);
 assert.equal(trafficRowSeries({series},response).length,3);
 assert.throws(()=>trafficRowSeries({trend_values:[[1]]},response),/不一致/);
});
test('each actual rendered SKU row contains its own compact chart and visible product/store identifiers',async()=>{
 const series=trafficRowSeries({trend_values:[[0,0],null,[10,1]]},{series_days:['2026-11-01','2026-11-02','2026-11-03'],series_columns:['total_views','ordered_units']});
 const rows=['SKU-A','SKU-B','SKU-C'].map((sku,index)=>({sku,shop_id:index+1,shop_name:'Shop '+index,product_name:'Item '+index,image_url:index===0?'https://cdn.example.com/product-a.jpg':index===1?'data:image/png;base64,AAAA':null,offer_id:'Offer '+index,inventory:[],summary:{total_views:10,available_days:2},series}));
 const {html}=await renderTrafficRows(rows);
 assert.equal((html.match(/<article /g)||[]).length,3);assert.equal((html.match(/<svg /g)||[]).length,3);
 for(const sku of ['SKU-A','SKU-B','SKU-C'])assert.ok(html.includes(sku));
 assert.ok(html.includes('Shop 2'));assert.ok(html.includes('Offer 1'));assert.ok(html.includes('11-01'));assert.ok(html.includes('11-03'));
 assert.equal((html.match(/viewBox="0 0 700 140"/g)||[]).length,3);
 assert.equal((html.match(/class="trend-chart compact"/g)||[]).length,3);
 assert.equal((html.match(/class="traffic-product-image"/g)||[]).length,3);assert.equal((html.match(/class="el-image"/g)||[]).length,1);assert.ok(!html.includes('data:image'));assert.ok(html.includes('无图'));
 assert.ok(!html.includes('trend-panel'));assert.ok(!html.includes('<aside'));
});
