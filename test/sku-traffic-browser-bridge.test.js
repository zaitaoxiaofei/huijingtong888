import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrafficBrowserBridge} from '../frontend/admin/utils/sku-traffic-browser-bridge.js';
import {collectionDayState,verifiedCollectionShop} from '../frontend/admin/utils/sku-traffic-collection-state.js';
function harness(){const listeners=new Set(),sent=[];const host={location:{origin:'https://erp.hjt888.xyz'},setTimeout,clearTimeout,addEventListener:(name,fn)=>listeners.add(fn),removeEventListener:(name,fn)=>listeners.delete(fn),postMessage:data=>sent.push(data)};return{host,sent,emit:(data,origin=host.location.origin)=>{for(const fn of listeners)fn({source:host,origin,data});}};}
test('browser-local discovery is targeted, ignores foreign replies and invalidates pending checks after an instance change',async()=>{
 const h=harness(),bridge=createTrafficBrowserBridge({host:h.host});bridge.start();h.emit({type:'BAODAN_ANALYTICS_PLUGIN_INSTANCE',pluginInstanceId:'browserA',capabilities:{collector:true,storeDiscovery:true}});
 const pending=bridge.check('Z'),request=h.sent.at(-1);assert.equal(request.pluginInstanceId,'browserA');
 h.emit({type:'BAODAN_ANALYTICS_PLUGIN_CHECK_STORE_RESULT',requestId:request.requestId,pluginInstanceId:'browserB',result:{ok:true,companyId:'Z'}});
 h.emit({type:'BAODAN_ANALYTICS_PLUGIN_INSTANCE',pluginInstanceId:'browserB',capabilities:{collector:true,storeDiscovery:true}});assert.equal(await pending,null);
 const check=bridge.check(''),next=h.sent.at(-1);h.emit({type:'BAODAN_ANALYTICS_PLUGIN_CHECK_STORE_RESULT',requestId:next.requestId,pluginInstanceId:'browserB',result:{ok:true,companyId:'Z'}},'https://other.test');
 h.emit({type:'BAODAN_ANALYTICS_PLUGIN_CHECK_STORE_RESULT',requestId:next.requestId,pluginInstanceId:'browserB',result:{ok:true,companyId:'Z'}});assert.equal((await check).companyId,'Z');bridge.wake('Z');assert.equal(h.sent.at(-1).pluginInstanceId,'browserB');bridge.stop();
});
test('older plugins retain selected-shop collection without pretending they can discover every shop',async()=>{const h=harness(),b=createTrafficBrowserBridge({host:h.host});b.start();h.emit({type:'BAODAN_ANALYTICS_PLUGIN_INSTANCE',pluginInstanceId:'old',capabilities:{collector:true}});await assert.rejects(b.check(''),/先选择/);const p=b.check('Z'),r=h.sent.at(-1);h.emit({type:'BAODAN_ANALYTICS_PLUGIN_CHECK_STORE_RESULT',requestId:r.requestId,pluginInstanceId:'old',result:{ok:true,companyId:'Z'}});assert.equal((await p).companyId,'Z');b.stop();});
test('queued, running, completed requests and published daily data remain separate; source attribution needs evidence',()=>{
 assert.equal(collectionDayState({status:'pending'}).kind,'queued');
 assert.equal(collectionDayState({status:'pending',progress:{stale_requests:1}}).kind,'stale');
 assert.equal(collectionDayState({status:'pending',progress:{cancelled_requests:1}}).label,'采集已取消');
 assert.equal(collectionDayState({status:'pending',progress:{total_requests:2,completed_requests:1,active_requests:1}}).kind,'running');
 assert.equal(collectionDayState({status:'pending',progress:{total_requests:2,completed_requests:2}}).kind,'publishing');
 assert.equal(collectionDayState({status:'complete'},'A').label,'已入库');
 assert.equal(collectionDayState({status:'complete',progress:{collector_instance_ids:['B']}},'A').label,'其他浏览器已同步');
 assert.equal(collectionDayState({status:'complete',progress:{collector_instance_ids:['A']}},'A').label,'已入库');
});
test('only the verified local shop may collect while all-shop inventory comparisons remain available',()=>{const shops=[{id:7,name:'Z',store_id:'77'},{id:8,name:'X',store_id:'88'}];assert.equal(verifiedCollectionShop(shops,'all',{ok:true,companyId:'77'}).id,7);assert.throws(()=>verifiedCollectionShop(shops,'8',{ok:true,companyId:'77'}),/切换/);assert.throws(()=>verifiedCollectionShop(shops,'all',{ok:false,companyId:'77'}),/尚未验证/);assert.throws(()=>verifiedCollectionShop(shops,'all',{ok:true,companyId:'99'}),/不属于/);});

test('a unified browser-instance bridge is not replaced by a competing legacy announcement',()=>{const h=harness(),b=createTrafficBrowserBridge({host:h.host});b.start();h.emit({type:'BAODAN_ANALYTICS_PLUGIN_INSTANCE',pluginInstanceId:'new-browser',capabilities:{collector:true,browserInstance:true,storeDiscovery:true}});h.emit({type:'BAODAN_ANALYTICS_PLUGIN_INSTANCE',pluginInstanceId:'legacy-extension',capabilities:{collector:true}});assert.equal(b.instanceId,'new-browser');b.stop();});
