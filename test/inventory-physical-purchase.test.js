import test from 'node:test';
import assert from 'node:assert/strict';
import {physicalInventoryComponents} from '../src/shared/inventory-composition.js';
import {inventoryLocalEvidence} from '../src/shared/inventory-local-evidence.js';
import {bundleReviewRevision,planPurchaseBundleReview,suggestBundleCostAllocation} from '../src/shared/purchase-bundle-review.js';
import {synchronizeInventoryFbp} from '../frontend/admin/utils/inventory-fbp-sync.js';
import {loadFbpSafetyProjections} from '../src/services/fbp-safety-projection.js';
import {fbpSupplyState} from '../src/shared/fbp-supply-state.js';
const products=[{id:1,active:1,quantity:8},{id:2,active:1},{id:3,active:1},{id:4,active:1}];
const edges=[{product_id:1,component_product_id:2,quantity:2},{product_id:1,component_product_id:3,quantity:1},{product_id:3,component_product_id:2,quantity:3},{product_id:3,component_product_id:4,quantity:1}];
test('minimum physical units flatten shared nested parts; descriptive pack size is not multiplied',()=>{
 assert.deepEqual(physicalInventoryComponents(1,products,edges).map(p=>[p.product_id,p.per_set_quantity]),[[2,5],[4,1]]);
 for(const invalid of [[...edges,{product_id:4,component_product_id:1,quantity:1}],edges.map(e=>({...e,quantity:0})),[{product_id:1,component_product_id:99,quantity:1}]])assert.throws(()=>physicalInventoryComponents(1,products,invalid),{statusCode:409});
 assert.throws(()=>physicalInventoryComponents(1,products.map(p=>p.id===2?{...p,active:0}:p),edges));
});
test('counted zero, negative book and pending deducted pieces remain distinct facts',()=>{
 const input={physical_estimate:-3,local_stock:-15,open_order_deducted:12,stocktake_evidence:{created_at:'2026-10-30 10:36:01',result_json:JSON.stringify({physical_after:0})}};
 const evidence=inventoryLocalEvidence(input);assert.equal(evidence.last_counted_quantity,0);assert.equal(evidence.physical_quantity,null);assert.equal(evidence.book_quantity,-3);assert.equal(evidence.change_since_count,-3);assert.equal(evidence.pending_deducted_quantity,12);assert.equal(input.physical_estimate,-3);
 assert.equal(inventoryLocalEvidence({}).last_counted_quantity,null);
});
const batch={id:1,product_id:1,quantity:10,amount:100,shipping_amount:10,status:'pending_arrival'};
const components=[{product_id:2,per_set_quantity:2,quantity:20},{product_id:4,per_set_quantity:1,quantity:10}];
const context={batch,components,revision:bundleReviewRevision(batch,components)};
const whole={revision:context.revision,mode:'whole',note:'凭证核对',allocation_confirmed:true,items:[{product_id:2,quantity:20,amount:60,shipping_amount:6},{product_id:4,quantity:10,amount:40,shipping_amount:4}]};
test('whole purchase requires every part, exact conversion and separately conserved goods/freight',()=>{
 assert.equal(planPurchaseBundleReview(context,whole).items.length,2);
 for(const body of [{...whole,revision:'stale'},{...whole,allocation_confirmed:false},{...whole,items:whole.items.slice(0,1)},{...whole,items:whole.items.map(i=>({...i,quantity:1}))},{...whole,items:[{...whole.items[0],amount:61,shipping_amount:5},whole.items[1]]}])assert.throws(()=>planPurchaseBundleReview(context,body));
 const suggestions=suggestBundleCostAllocation(batch,components,[{id:2,purchase_cost:2},{id:4,purchase_cost:3}]);
 assert.equal(suggestions.reduce((n,r)=>n+Math.round(r.suggested_amount*10000),0),1000000);assert.equal(suggestions.reduce((n,r)=>n+Math.round(r.suggested_shipping_amount*10000),0),100000);
 assert.equal(suggestBundleCostAllocation(batch,components,[])[0].suggested_amount,null);
});
test('component-only correction never includes other kit parts; different amount needs explicit confirmation',()=>{
 const body={...whole,mode:'parts',items:[{product_id:2,quantity:7,amount:35,shipping_amount:0}]};
 assert.throws(()=>planPurchaseBundleReview(context,body));assert.equal(planPurchaseBundleReview(context,{...body,confirm_amount_change:true}).items[0].quantity,7);
 assert.throws(()=>planPurchaseBundleReview(context,{...body,confirm_amount_change:true,items:[{product_id:99,quantity:7,amount:35}]}));
});
test('missing FBP SKU and partial warehouse snapshots stay unknown instead of zero',async()=>{
 const mapping={inventory_product_id:1,shop_id:20,ozon_sku:'ONE',per_set_quantity:1};
 const query=async sql=>sql.includes('AS inventory_product_id')?[mapping]:sql.includes('FROM ozon_stock_snapshots')?[]:[];
 const result=(await loadFbpSafetyProjections(query,[{id:1}],{id:2,isDefault:false},()=>({}))).get(1);
 assert.equal(result.skus[0].available,null);assert.equal(fbpSupplyState(result).missing_stock_count,1);assert.equal(fbpSupplyState(result).known,false);
 const partial=async sql=>sql.includes('AS inventory_product_id')?[mapping]:sql.includes('FROM ozon_stock_snapshots')?[{...mapping,present:3,available:2},{...mapping,present:1,available:null}]:[];
 const mixed=(await loadFbpSafetyProjections(partial,[{id:1}],{id:2,isDefault:false},()=>({}))).get(1);assert.equal(mixed.skus[0].available,null);assert.equal(fbpSupplyState(mixed).known,false);
});
test('FBP retry uses canonical background sync, exact task identity and fresh scope',async()=>{
 const calls=[];let polls=0;const api={post:async(path,body)=>{calls.push([path,body]);return{task_id:'a',running:true};},get:async()=>++polls===1?{task_id:'a',running:true}:{task_id:'a',running:false,result:{ok:true}}};
 assert.equal((await synchronizeInventoryFbp(api,1,{wait:async()=>{}})).ok,true);assert.equal(polls,2);assert.deepEqual(calls,[['/api/inventory-flow/sync',{product_id:1,background:true}]]);
 await assert.rejects(synchronizeInventoryFbp({...api,get:async()=>({task_id:'b',running:false,result:{ok:true}})},1,{wait:async()=>{}}),/任务已变更/);
 let current=true;await assert.rejects(synchronizeInventoryFbp(api,1,{wait:async()=>{current=false;},isCurrent:()=>current}),{name:'AbortError'});
 await assert.rejects(synchronizeInventoryFbp({post:async()=>({task_id:'a',result:{ok:false,results:[{ok:false,shop_name:'店铺M',message:'授权失效'}]}})},1),/店铺M：授权失效/);
});
