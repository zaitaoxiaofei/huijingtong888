import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyMetricChange} from '../frontend/admin/utils/sku-traffic-detail.js';
import {pagePermission} from '../src/shared/permissions.js';
test('SKU analysis compares actual observed endpoints without filling missing days or dividing by zero',()=>{
 const days=[{date_key:'2026-11-01',available:false,total_views:null},{date_key:'2026-11-02',available:true,total_views:0},{date_key:'2026-11-03',available:false,total_views:null},{date_key:'2026-11-04',available:true,total_views:20}];
 assert.deepEqual(dailyMetricChange(days,'total_views'),{from:'2026-11-02',to:'2026-11-04',first:0,last:20,change:20,percent:null});
 assert.equal(dailyMetricChange(days,'ordered_units'),null);
 assert.equal(dailyMetricChange(days.slice(0,3),'total_views'),null);
 assert.equal(dailyMetricChange([{date_key:'1',available:true,total_views:20},{date_key:'2',available:true,total_views:10}],'total_views').percent,-50);
});
test('SKU detail requires the same analytics permission as its monitor',()=>{
 assert.equal(pagePermission('/sku-traffic-monitor/detail'),'analytics');
 assert.equal(pagePermission('/sku-traffic-monitor'),pagePermission('/sku-traffic-monitor/detail'));
});
