import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryModules,inventoryTabKey,inventoryRouteTab,fbpRouteStatus} from '../frontend/admin/constants/inventory-modules.js';
import {receivingFilters,restoreReceivingFilters,receivingParams,receivingRouteQuery} from '../frontend/admin/utils/receiving-search.js';
test('receipt tabs have fixed pending and approved routes; FBP statuses have unique route-backed tabs',()=>{
 const receiving=inventoryModules.find(g=>g.label==='收货入库');assert.deepEqual(receiving.tabs.map(t=>t.label),['待入库','已入库']);
 const fbp=inventoryModules.find(g=>g.label==='FBP');assert.equal(new Set(fbp.tabs.map(inventoryTabKey)).size,8);
 for(const tab of fbp.tabs.filter(t=>t.status))assert.equal(inventoryRouteTab({path:tab.path,query:{status:tab.status}}),inventoryTabKey(tab));
 assert.equal(fbpRouteStatus({orderId:'123',status:'applying'}),'all');assert.equal(fbpRouteStatus({status:'sent'}),'pending_receipt');assert.equal(fbpRouteStatus({status:'unexpected'}),'applying');
});
test('both receipt lists share product filters but never submit hidden old status, date, buyer or platform filters',()=>{
 for(const status of ['pending_arrival','approved']){
  const f=receivingFilters(status);
  restoreReceivingFilters({status:'all',personId:'99',supplierId:'98',sourceType:'pdd',startDate:'2026-01-01',searchMode:'sku',query:'12345',vehicleModel:'T4,T7',demandType:'fbp_stock',inventoryType:'combo'},f,status);
  const params=new URLSearchParams(receivingParams(f,status));assert.equal(params.get('status'),status);assert.equal(params.get('searchMode'),'sku');assert.equal(params.get('inventoryType'),'combo');assert.equal(params.get('demandType'),'fbp_stock');assert.equal(params.get('vehicleModel'),'T4,T7');
  for(const key of ['personId','supplierId','sourceType','startDate','endDate'])assert.equal(params.has(key),false);
  const route=receivingRouteQuery({status:'all',personId:'99',startDate:'2026-01-01'},f);assert.equal(route.status,undefined);assert.equal(route.personId,undefined);assert.equal(route.startDate,undefined);
 }
});
test('an exact order procurement link keeps its context without mistaking the context title for a product-name filter',()=>{
 const query={orderId:'7',orderItemId:'8',orderNo:'TEST-ORDER',productId:'12',productName:'套装中的某个产品',quantity:'2'};
 const f=receivingFilters('pending_arrival');restoreReceivingFilters(query,f,'pending_arrival');assert.equal(f.productId,'12');assert.equal(f.productName,'');
 f.productName='黑色';const next=receivingRouteQuery(query,f);assert.equal(next.orderId,'7');assert.equal(next.orderItemId,'8');assert.equal(next.productName,query.productName);assert.equal(next.filterProductName,'黑色');
 const restored=receivingFilters('pending_arrival');restoreReceivingFilters(next,restored,'pending_arrival');assert.equal(restored.productName,'黑色');assert.equal(restored.productId,'12');
});
