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


test('interval navigation binds one shop and preserves complete detail return context',async()=>{
 const {intervalCollectionRoute,monitorContextQuery}=await import('../frontend/admin/utils/sku-traffic-navigation.js');
 const saved={shops:'7',range_days:7,query:'新品',view:'focused',group_by:'inventory',sort_order:'asc',page:3,pageSize:30,scroll_top:736,trend_metric:'pdp_views',exposure_trend:'other_views',click_trend:'pdp_cart_rate',order_trend:'cart_order_rate',tags:JSON.stringify(['新品开发期','测品'])};
 const target=intervalCollectionRoute(7,'2026-11-07',7,saved);
 assert.deepEqual(dailyCollectionContext(target.query),{shopId:'7',date:'2026-11-07',rangeDays:7,from:'2026-11-01'});
 assert.equal(target.query.traffic_auto,'1');
 const expected=Object.fromEntries(Object.entries(saved).map(([k,v])=>[k,String(v)]));
 assert.deepEqual(monitorReturnQuery(target.query),expected);
 assert.deepEqual(monitorReturnQuery({...monitorContextQuery(saved),shop_id:'7',sku:'123'}),expected);
});
test('shop preference defaults to the main shop and drops shops outside current membership',async()=>{
 const {preferredMonitorShops,monitorPreferenceKey}=await import('../frontend/admin/utils/sku-traffic-navigation.js');
 const shops=[{id:7,name:'RuVibe Mart Z'},{id:4,name:'RuVibe Mart'}];
 assert.deepEqual(preferredMonitorShops(shops,null),['4']);
 assert.deepEqual(preferredMonitorShops(shops,['7']),['7']);
 assert.deepEqual(preferredMonitorShops(shops,['999','4']),['4']);
 assert.deepEqual(preferredMonitorShops([],['7']),[]);
 assert.notEqual(monitorPreferenceKey(1),monitorPreferenceKey(2));
});

test('single-day collection closes the cached coverage drawer and keeps return filters',async()=>{
 const fs=await import('node:fs'),vm=await import('node:vm');
 const source=fs.readFileSync('frontend/admin/views/analytics/SkuTrafficMonitorView.vue','utf8');
 const fn=source.match(/function goCollect\([^\n]+/)[0],calls=[];
 const saved={shops:'4',query:'3144521577',view:'bound',group_by:'inventory',tags:'["重点关注"]',page:2,click_trend:'pdp_cart_rate'};
 const context=vm.createContext({state:{date:'2026-11-14'},syncDrawer:{value:true},saveMonitor:()=>saved,router:{push:route=>calls.push(route)},dailyCollectionRoute});
 vm.runInContext(fn+';this.go=goCollect;',context);context.go({id:4});
 assert.equal(context.syncDrawer.value,false);assert.equal(calls.length,1);
 assert.equal(calls[0].query.shop_id,'4');assert.equal(calls[0].query.date,'2026-11-14');
 assert.deepEqual(monitorReturnQuery(calls[0].query),Object.fromEntries(Object.entries(saved).map(([key,value])=>[key,String(value)])));
 context.go(null);assert.equal(context.syncDrawer.value,true);assert.equal(calls.length,1);
});
