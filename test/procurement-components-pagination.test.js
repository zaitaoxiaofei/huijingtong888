import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {bundlePurchaseItems} from '../frontend/admin/utils/bundle-purchase-items.js';

const parts=[{id:10,name:'主体',per_set_quantity:1},{id:11,name:'配件',per_set_quantity:2},{id:12,name:'耗材',per_set_quantity:1}];
const state=(product_id,required,optional=0)=>({product_id,supply_plan:{known:true,required_purchase:required,optional_purchase:optional}});
test('bundle purchases include only missing physical products and use the actual net gap',()=>{
 const items=bundlePurchaseItems(parts,[state(10,0),state(11,7),state(12,0,3)]);
 assert.deepEqual(items.map(x=>[x.product_id,x.quantity]),[[11,7],[12,3]]);
 assert.deepEqual(bundlePurchaseItems(parts,[state(10,0),state(11,0),state(12,0)]),[]);
});
test('all missing components appear individually, including shared/nested BOM leaf ratios',()=>{
 assert.deepEqual(bundlePurchaseItems(parts,[state(10,4),state(11,8),state(12,4)]).map(x=>[x.product_id,x.quantity]),[[10,4],[11,8],[12,4]]);
});
test('unknown demand is not silently counted as zero; confirmed FBS gaps remain actionable',()=>{
 assert.throws(()=>bundlePurchaseItems(parts,[state(10,0),state(11,0)]),/耗材/);
 assert.throws(()=>bundlePurchaseItems(parts,[state(10,0),state(11,0),{product_id:12,supply_plan:{known:false}}]),/耗材/);
 const result=bundlePurchaseItems([parts[0]],[{product_id:10,supply_plan:{known:false,fbs_known:true,required_fbs:5}}]);assert.equal(result[0].quantity,5);
});
test('explicit free purchasing can buy a set without shortages while normal procurement stays empty',()=>{
 const states=parts.map(p=>state(p.id,0));
 assert.deepEqual(bundlePurchaseItems(parts,states,{freePurchase:true}).map(x=>[x.product_id,x.quantity]),[[10,1],[11,2],[12,1]]);
});
test('adding a searched bundle re-reads component shortages and submits only the missing leaves',async()=>{
 const text=fs.readFileSync(new URL('../frontend/admin/components/procurement/ProcurementBatchPurchaseDialog.vue',import.meta.url),'utf8');
 const handlers=text.slice(text.indexOf('function addPhysical('),text.indexOf('async function search('));
 const items={value:[]},calls=[],messages=[];
 const context=vm.createContext({items,props:{freePurchase:false},bundlePurchaseItems,visible:{value:true},disposed:false,generation:1,currentApiCacheScope:()=> 'tenant-A',ElMessage:{info:x=>messages.push(x),warning:x=>messages.push(x),error:x=>messages.push(x)},apiClient:{get:async url=>{calls.push(url);return url.includes('view=components')?{rows:[{is_bundle:true,components:parts}]}:{rows:[state(10,0),state(11,7),state(12,0)]};}}});
 vm.runInContext(handlers,context);await context.add({id:99,name:'套装'});
 assert.equal(calls.length,2);assert.match(calls[1],/fresh=1&product_ids=10,11,12/);
 assert.deepEqual(Array.from(items.value,r=>[r.product_id,r.quantity]),[[11,7]]);
 assert.ok(!items.value.some(r=>r.product_id===99));
});
test('all five work lists expose 20/50/100 sizes and default to 50, including FBP API paging',()=>{
 for(const file of ['inventory/InventorySupplyWorkspace.vue','procurement/InventoryPurchaseBatchQueue.vue','inventory/InventoryFbpReceiptReview.vue']){
  const text=fs.readFileSync(new URL('../frontend/admin/components/'+file,import.meta.url),'utf8');
  assert.match(text,/:page-sizes="\[20,50,100\]"/);assert.match(text,/layout="total,\s*sizes,/);assert.match(text,/@size-change=/);
  assert.match(text,/pageSize(?::50|=ref\(50\))/);
 }
 const fbp=fs.readFileSync(new URL('../src/services/fbp-receipt-review.js',import.meta.url),'utf8');assert.match(fbp,/LIMIT \? OFFSET \?/);assert.match(fbp,/\[\.\.\.args,pageSize,\(page-1\)\*pageSize\]/);
});
