import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficRowFocus,trafficComparisonText} from '../frontend/admin/utils/sku-traffic-row-focus.js';
const day=(date,metric,value,available=true)=>({date_key:date,available,[metric]:value});
test('list change uses adjacent calendar days and preserves zero and missing values',()=>{
 const metric='total_views';
 let result=trafficRowFocus([day('2026-11-14',metric,100),day('2026-11-15',metric,125)],metric);
 assert.equal(result.value,125);assert.equal(result.comparison.direction,'up');assert.equal(result.comparison.value,25);assert.equal(result.comparison.unit,'%');
 result=trafficRowFocus([day('2026-11-14',metric,100),day('2026-11-15',metric,0)],metric);assert.equal(result.value,0);assert.equal(result.comparison.value,-100);
 result=trafficRowFocus([day('2026-11-14',metric,0),day('2026-11-15',metric,12)],metric);assert.equal(result.comparison.value,12);assert.equal(result.comparison.unit,'');
 for(const series of [[day('2026-11-13',metric,100),day('2026-11-15',metric,125)],[day('2026-11-14',metric,null,false),day('2026-11-15',metric,125)],[day('2026-11-15',metric,125)]])assert.equal(trafficRowFocus(series,metric).comparison,null);
 result=trafficRowFocus([day('2026-11-14',metric,100),day('2026-11-15',metric,null,false)],metric);assert.equal(result.value,null);assert.equal(result.available,false);assert.equal(result.comparison,null);
});
test('rate changes are percentage points and an undefined ratio stays unknown',()=>{
 const key='pdp_order_rate';const result=trafficRowFocus([day('2026-11-14',key,2),day('2026-11-15',key,4.5)],key);
 assert.equal(result.comparison.value,2.5);assert.equal(result.comparison.unit,'个百分点');
 const missing=trafficRowFocus([day('2026-11-14',key,2),day('2026-11-15',key,null)],key);assert.equal(missing.available,true);assert.equal(missing.value,null);assert.equal(missing.comparison,null);
 assert.equal(trafficRowFocus([],key).comparison,null);
});

test('small changes retain their direction without displaying a rounded zero change',()=>{
 assert.equal(trafficComparisonText({direction:'down',value:-0.002,unit:'个百分点'}),'较前日 ↓ <0.01个百分点');
 assert.equal(trafficComparisonText({direction:'up',value:0.03,unit:'%'}),'较前日 ↑ <0.1%');
 assert.equal(trafficComparisonText({direction:'flat',value:0,unit:'%'}),'与前日持平');
});
