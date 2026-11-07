import test from 'node:test';import assert from 'node:assert/strict';
import {fbpSupplyState,fbpLocalSupplyNeed} from '../src/shared/fbp-supply-state.js';
import {inventoryWorkflow} from '../src/shared/inventory-workflow.js';
import {calculateFlowProduct,validateFlowSettings} from '../src/services/inventory-flow-rules.js';
const sku=(patch={})=>({shop_id:20,ozon_sku:'A',per_set_quantity:2,available:5,fbp_target:20,in_transit:4,committed_qty:3,...patch});
const state=(rows)=>fbpSupplyState({skus:rows},{incomplete:false});
test('FBP available is independent of reserved, dispatched and signed stock; coverage reduces only the next replenishment',()=>{
 const result=state([sku({reserved:7})]);assert.equal(result.available,10);assert.equal(result.safety,40);assert.equal(result.shortage,30);assert.equal(result.in_transit,8);assert.equal(result.replenish_quantity,16);
 const covered=state([sku({in_transit:100})]);assert.equal(covered.available,10);assert.equal(covered.shortage,30);assert.equal(covered.replenish_quantity,0);assert.equal(covered.status,'in_transit');
 const sufficient=state([sku({available:20,reserved:10})]);assert.equal(sufficient.shortage,0);assert.equal(sufficient.available,40);
});
test('each shop/SKU is protected separately, pending applications never double count forecasts',()=>{
 const fbp=state([sku({shop_id:20,available:100,per_set_quantity:1}),sku({shop_id:30,ozon_sku:'B',available:0,fbp_target:10,in_transit:0,committed_qty:0,per_set_quantity:1})]);
 assert.equal(fbp.shortage,10);assert.equal(fbp.replenish_quantity,10);
 assert.equal(fbpLocalSupplyNeed([{shop_id:20,ozon_sku:'A',status:'pending_review',requested_quantity:5}],fbp),15);
 assert.equal(fbpLocalSupplyNeed([{shop_id:30,ozon_sku:'B',status:'pending_review',requested_quantity:15}],fbp),15);
 assert.equal(fbpLocalSupplyNeed([{shop_id:30,ozon_sku:'B',status:'draft',requested_quantity:100}],fbp),10);
});
test('missing and partial official snapshots never become zero or a confirmed safety target',()=>{
 for(const input of [null,{skus:[]},{skus:[sku({available:null})]},{skus:[sku({fbp_target:null})]},{skus:[sku()],stock_incomplete:true}])assert.equal(fbpSupplyState(input).known,false);
 assert.equal(fbpSupplyState({skus:[sku()]},{incomplete:true}).available,null);
});
test('FBP low stock creates a replenishment warning and net procurement without first requiring an application',()=>{
 const ledger={physical_estimate:20,open_order_demand:4,fbp_reserved:0,current_shortage:0,current_incoming:0,incoming_quantity:0,fbp_inventory:{incomplete:false},flow_summary:{safety:6,applications:[]}};
 const forecast={skus:[sku({available:0,fbp_target:15,per_set_quantity:1,in_transit:0,committed_qty:0})]};const result=inventoryWorkflow(ledger,{forecast});
 assert.equal(result.free,10);assert.equal(result.fbp.shortage,15);assert.equal(result.demands[3].purchase_quantity,5);assert.equal(result.requested,0);assert.equal(result.purchase_quantity,5);
 const covered=inventoryWorkflow({...ledger,physical_estimate:100},{forecast});assert.equal(covered.demands[2].purchase_quantity,0);assert.equal(covered.demands[3].status,'success');assert.equal(covered.local_stock_status,'success');
});
test('FBS sales do not inflate FBP safety or create a new FBP purchase obligation',()=>{
 const product={created_days:100,incoming_stock:0},balance={physical_stock:200,open_order_demand_qty:0,fbp_reserved_qty:0},settings=validateFlowSettings({production_days:7,local_days:3});
 const row={...sku({available:0,present:0,per_set_quantity:1,in_transit:0,committed_qty:0}),sales:{w1:70,w2:70,w3:70,w4:70,d14:140,d60:300,fbp14:0,fbs7:70}};
 const fbsOnly=calculateFlowProduct(product,balance,[row],settings,'2026-10-30');assert.equal(fbsOnly.skus[0].fbp_target,0);assert.equal(fbsOnly.skus[0].suggested_qty,0);assert.equal(fbsOnly.safety_qty,100);
 const mixed=calculateFlowProduct(product,balance,[{...row,sales:{...row.sales,fbp14:14}}],settings,'2026-10-30');assert.equal(mixed.skus[0].fbp_target,mixed.fbp_days);
});
