import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {ref,reactive,computed} from 'vue';
import {SKU_TRAFFIC_OPERATION_METRICS,SKU_TRAFFIC_PRIMARY_RATE_KEYS} from '../src/shared/sku-traffic-monitor-query.js';
import {trafficRowSeries} from '../frontend/admin/utils/sku-traffic-row-series.js';
test('manual missing-day backfill continues in bounded waves, waits for active shop work and stops after completion/disposal',async()=>{
 const source=fs.readFileSync('frontend/admin/views/analytics/SkuTrafficMonitorView.vue','utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm,'');
 const days=Array.from({length:7},(_,i)=>'2026-11-0'+(i+1)),calls=[];let dispose;
 const data={rows:[],shops:[{id:11,name:'Owned shop'}],days,coverage:[],date:days.at(-1),report_end_date:days.at(-1),range_from:days[0]};
 const context=vm.createContext({ref,reactive,computed,useRouter:()=>({push(){}}),onMounted(){},onBeforeUnmount:fn=>dispose=fn,SKU_TRAFFIC_OPERATION_METRICS,SKU_TRAFFIC_PRIMARY_RATE_KEYS,trafficRowSeries,createDailyTrafficMonitor:()=>({start(){},stop(){}}),ElMessage:{success(){},error(message){throw new Error(message);}},window:{location:{origin:'http://localhost:8788'},postMessage(){}},getSkuTrafficDaily:async params=>{assert.equal(params.date_mode,'latest_report_day');return data;},collectSkuTrafficDaily:async body=>{calls.push(body);return {queued:[],waiting:[]};}});
 vm.runInContext(source+';this.api={load,continueBackfill,backfill,state};',context);const api=context.api;await api.load();
 api.backfill.value={shop_id:'all',range_days:7};await api.continueBackfill();assert.equal(calls.length,1);assert.equal(calls[0].range_days,7);assert.equal(calls[0].missing_only,true);
 api.state.coverage=[{shop_id:11,date_key:days[0],status:'pending'}];await api.continueBackfill();assert.equal(calls.length,1);
 api.state.coverage=days.map(date_key=>({shop_id:11,date_key,status:'complete'}));await api.continueBackfill();assert.equal(api.backfill.value,null);
 api.state.coverage=[];api.backfill.value={shop_id:'all',range_days:7};dispose();await api.continueBackfill();assert.equal(calls.length,1);
});
