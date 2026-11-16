import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
function harness(){
 const events=new EventTarget(),pending=[];
 const storage={getItem:()=>null,setItem(){},removeItem(){},length:0};
 const context=vm.createContext({window:{localStorage:storage,sessionStorage:storage,addEventListener:events.addEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),setTimeout,clearTimeout,location:{hash:'#/sku-traffic-monitor',pathname:'/admin.html'}},URL,URLSearchParams,AbortController,DOMException,CustomEvent,console,beginApiPerf:()=>({}),endApiPerf(){},setTimeout,clearTimeout,
 fetch:(url,options)=>new Promise((resolve,reject)=>{pending.push({url,options,resolve:data=>resolve({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data})});options.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')));})});
 vm.runInContext(read('frontend/admin/utils/api.js').replace(/^import .*$/gm,'').replace(/^export /gm,'')+';this.client=apiClient;',context);
 vm.runInContext(read('frontend/admin/api/sellerAnalytics.js').replace(/^import .*$/gm,'').replace(/^export /gm,''),context);
 const source=read('frontend/admin/views/analytics/SkuTrafficMonitorView.vue');
 Object.assign(context,{sessionKey:{value:'tenant:user'},preferenceKey:{value:'sku-traffic-monitor.1'},disposed:false,initialized:false,state:{shops:[]},tagOptions:{value:[]},DEFAULT_TRAFFIC_TAGS:['重点关注'],selectedShops:{value:['4']},preferredMonitorShops:(_shops,selected)=>selected,error:{value:''},load:async()=>{context.reads=(context.reads||0)+1;},restoreScroll:async()=>{},startRefresh(){}});
 vm.runInContext(source.match(/async function initialize\(\)\{[\s\S]*?\n\}/)[0]+source.match(/function refreshMonitor\(\)\{[^\n]+\}/)[0]+';this.initialize=initialize;this.refreshMonitor=refreshMonitor;',context);
 return {context,pending,events};
}
test('monitor bootstrap survives route cancellation and then reads selected-shop data',async()=>{
 const {context,pending,events}=harness();const task=context.initialize();
 assert.equal(pending.length,2);assert.ok(pending.every(request=>!request.options.signal));
 events.dispatchEvent(new CustomEvent('admin:route-changing'));
 pending[0].resolve({shops:[{id:4,name:'RuVibe Mart'}]});pending[1].resolve({value:{shops:['4']}});
 await task;assert.equal(context.initialized,true);assert.equal(context.reads,1);assert.equal(context.state.shops[0].id,4);
});
test('late bootstrap responses cannot populate a different account or a disposed page',async()=>{
 for(const changed of ['account','disposed']){
  const {context,pending}=harness();const task=context.initialize();
  if(changed==='account')context.sessionKey.value='other-account';else context.disposed=true;
  pending[0].resolve({shops:[{id:4,name:'Old account'}]});pending[1].resolve(null);
  await task;assert.equal(context.initialized,false);assert.equal(context.state.shops.length,0);assert.equal(context.reads,undefined);
 }
});
test('refresh retries an incomplete bootstrap instead of silently returning',async()=>{
 const {context,pending}=harness();const task=context.refreshMonitor();assert.equal(pending.length,2);
 pending[0].resolve({shops:[{id:4,name:'RuVibe Mart'}]});pending[1].resolve(null);await task;
 assert.equal(context.initialized,true);await context.refreshMonitor();assert.equal(context.reads,2);
});
