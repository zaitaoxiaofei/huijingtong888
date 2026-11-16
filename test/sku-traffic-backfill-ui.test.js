import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyCollectionContext,dailyCollectionRoute,monitorReturnQuery} from '../frontend/admin/utils/sku-traffic-navigation.js';
test('single-day collection route restores multiple shops, inventory grouping, watch and search filters',()=>{
 const saved={shops:'4,7',view:'focused',tag:'新品',group_by:'inventory',range_days:7,query:'INV-12',search_by:'inventory',date:'2026-11-14',page:2,filters:'[{"metric":"total_views","op":"gt","value":0}]'};
 const route=dailyCollectionRoute(4,'2026-11-13',saved);
 assert.deepEqual(dailyCollectionContext(route.query),{shopId:'4',date:'2026-11-13'});
 assert.deepEqual(monitorReturnQuery(route.query),Object.fromEntries(Object.entries(saved).map(([k,v])=>[k,String(v)])));
 assert.equal(dailyCollectionContext({...route.query,shop_id:'all'}),null);
 assert.equal(dailyCollectionContext({...route.query,date:'2026-02-30'}),null);
 assert.deepEqual(monitorReturnQuery({monitor_redirect:'https://untrusted.test',monitor_shops:'4'}),{shops:'4'});
});

test('switching the analysis view does not cancel another browser shop collection',async()=>{
 const {default:fs}=await import('node:fs');const {default:vm}=await import('node:vm');
 const source=fs.readFileSync('frontend/admin/views/analytics/SellerAnalyticsView.vue','utf8');
 const fn=source.match(/async function handleShopChange\([\s\S]*?\n\}/)[0];
 let cancellations=0;
 const context=vm.createContext({activeShopId:{value:'7'},switchingShop:{value:false},collectRuns:{value:[{id:'other-browser'}]},analysis:{value:{}},pluginValidation:{value:{}},authBindingStatus:{value:{}},browserProfileStatus:{value:{}},retryDialog:{visible:true},state:{filters:{shopId:'4'}},handleSearch(){},wakeAnalyticsPlugin(){},loadRunsMeta:async()=>{},cancelCollectRunAndNotify:async()=>{cancellations++;},ElMessage:{error(){}}});
 vm.runInContext(fn+';this.change=handleShopChange;',context);await context.change('4');
 assert.equal(cancellations,0);assert.equal(context.activeShopId.value,'4');assert.equal(context.switchingShop.value,false);
});

test('older and unknown collector versions keep regular pagination instead of requiring an update',async()=>{
 const {supportsTrafficPartitions}=await import('../frontend/admin/utils/sku-traffic-navigation.js');
 assert.equal(supportsTrafficPartitions('1.5.6',true),false);assert.equal(supportsTrafficPartitions('',true),false);
 assert.equal(supportsTrafficPartitions('1.5.7',true),true);assert.equal(supportsTrafficPartitions('1.0.46',false),false);assert.equal(supportsTrafficPartitions('1.0.47',false),true);
});
