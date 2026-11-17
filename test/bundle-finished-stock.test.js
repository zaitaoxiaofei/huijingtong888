import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateBundleFinishedDemands,remainingAssemblyBatches} from '../src/shared/bundle-finished-stock.js';
import {expandCurrentProcurementDemands} from '../src/services/procurement-demand-composition.js';
const graph={isBundle:id=>id===100,components:id=>id===100?[{id:1,per_set_quantity:2},{id:2,per_set_quantity:1}]:[{id,per_set_quantity:1}]};
const order=(id,n)=>({order_id:id,order_item_id:id,root_product_id:100,root_quantity:n,product_id:1,quantity:n*2,needs_fulfillment:1,stock_location:'LOCAL',ordered_at:`2026-11-${10+id}`});
test('finished units are allocated once across orders; only remaining sets consume loose parts',()=>{
 const demands=[order(1,20),{...order(1,20),product_id:2,quantity:20},order(2,20)];
 const rows=expandCurrentProcurementDemands(allocateBundleFinishedDemands(demands,graph,[{product_id:100,ledger:30}]),graph);
 assert.deepEqual(rows.map(r=>[r.order_item_id,r.product_id,r.quantity,r.finished_bundle||false]),[[1,100,20,true],[2,100,10,true],[2,1,20,false],[2,2,10,false]]);
});
test('zero finished stock retains loose-parts fulfillment and recipes never consume unrelated finished kits',()=>{
 const rows=allocateBundleFinishedDemands([order(1,5),{...order(2,5),recipe_id:9}],graph,[]);
 assert.equal(rows.find(r=>r.order_item_id===1).assembly_required,true);
 assert.equal(rows.find(r=>r.order_item_id===2).recipe_id,9);
});
test('batch reconstruction honors explicit disassembly and FIFO shipped consumption',()=>{
 const events=[{id:1,action:'bundle_assembly',detail_json:{quantity:30,components:[{product_id:1,per_set_quantity:2}]}},{id:2,action:'bundle_assembly',detail_json:{quantity:20,components:[{product_id:1,per_set_quantity:3}]}},{id:3,action:'bundle_disassembly',detail_json:{quantity:5,batch_id:2}}];
 assert.deepEqual(remainingAssemblyBatches(events,35).map(b=>[b.id,b.remaining]),[[1,20],[2,15]]);
 assert.equal(remainingAssemblyBatches(events,0).length,0);
});

test('approved FBP reservations do not displace FBS finished kits',()=>{
 const rows=allocateBundleFinishedDemands([order(1,4)],graph,[{product_id:100,ledger:5,fbp_reserved:5}]);
 assert.equal(rows.length,1);assert.equal(rows[0].finished_bundle,true);assert.equal(rows[0].quantity,4);
});
