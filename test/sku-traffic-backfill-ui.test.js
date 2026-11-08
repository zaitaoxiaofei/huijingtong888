import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {ref,reactive,computed} from 'vue';
import {SKU_TRAFFIC_OPERATION_METRICS,SKU_TRAFFIC_PRIMARY_RATE_KEYS} from '../src/shared/sku-traffic-monitor-query.js';
import {trafficRowSeries} from '../frontend/admin/utils/sku-traffic-row-series.js';
import {collectionDayState,verifiedCollectionShop} from '../frontend/admin/utils/sku-traffic-collection-state.js';
function harness(){
 const source=fs.readFileSync('frontend/admin/views/analytics/SkuTrafficMonitorView.vue','utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm,'');
 const days=Array.from({length:7},(_,i)=>'2026-11-0'+(i+1)),calls=[],warnings=[];let dispose,identity={ok:true,companyId:'111'},checks=0;
 const data={rows:[],shops:[{id:11,name:'Z',store_id:'111'},{id:12,name:'X',store_id:'222'}],days,coverage:[],date:days.at(-1),report_end_date:days.at(-1),range_from:days[0]};
 const context=vm.createContext({ref,reactive,computed,Date,useRouter:()=>({push(){}}),onMounted(){},onBeforeUnmount:fn=>dispose=fn,SKU_TRAFFIC_OPERATION_METRICS,SKU_TRAFFIC_PRIMARY_RATE_KEYS,trafficRowSeries,collectionDayState,verifiedCollectionShop,createTrafficBrowserBridge:()=>({start(){},stop(){},wake(){},check:async()=>{checks++;return identity;}}),createDailyTrafficMonitor:()=>({start(){},stop(){}}),ElMessage:{info(){},warning:message=>warnings.push(message),error:message=>warnings.push(message)},window:{location:{origin:'http://localhost:8788'},postMessage(){},clearInterval(){}},getSkuTrafficDaily:async()=>data,prepareSellerAnalyticsPlugin:async()=>({}),collectSkuTrafficDaily:async body=>{calls.push(body);return {queued:[],waiting:[]};}});
 vm.runInContext(source+';this.api={load,collect,continueBackfill,backfill,state,localBrowser};',context);context.api.localBrowser.pluginInstanceId='browser-A';return{api:context.api,days,calls,warnings,dispose:()=>dispose(),setIdentity:value=>identity=value,get checks(){return checks;}};
}
test('backfill only queues the verified local shop, continues bounded waves, and pauses after the browser switches shops',async()=>{
 const h=harness(),a=h.api;await a.load();a.backfill.value={shop_id:'11',range_days:7};await a.continueBackfill();assert.equal(h.calls.length,1);assert.equal(h.calls[0].shop_id,'11');assert.equal(h.calls[0].browser_instance_id,'browser-A');assert.equal(h.calls[0].missing_only,true);
 a.state.coverage=[{shop_id:11,date_key:h.days[0],status:'pending'}];await a.continueBackfill();assert.equal(h.calls.length,1);
 a.state.coverage=h.days.map(date_key=>({shop_id:11,date_key,status:'complete'}));await a.continueBackfill();assert.equal(a.backfill.value,null);
 a.state.coverage=[];a.backfill.value={shop_id:'11',range_days:7};h.setIdentity({ok:true,companyId:'222'});await a.continueBackfill();assert.equal(h.calls.length,1);assert.match(h.warnings.at(-1),/已切换/);assert.equal(a.backfill.value,null);
 a.backfill.value={shop_id:'11',range_days:7};h.dispose();await a.continueBackfill();assert.equal(h.calls.length,1);
});
test('existing complete dates skip duplicate collection even if the local browser is unavailable; mismatched shops never queue',async()=>{
 const h=harness(),a=h.api;await a.load();a.state.shop_id='11';a.state.coverage=[{shop_id:11,date_key:h.days.at(-1),status:'complete'}];await a.collect('latest');assert.equal(h.calls.length,0);assert.equal(h.checks,0);
 a.state.coverage=[];a.state.shop_id='12';h.setIdentity({ok:false,code:'store_mismatch',pageCompanyId:'111'});await a.collect('latest');assert.equal(h.calls.length,0);assert.match(h.warnings.at(-1),/切换/);
});
