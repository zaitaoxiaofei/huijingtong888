import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryWorkflow} from '../src/shared/inventory-workflow.js';
import {inventorySupplyLines} from '../src/shared/inventory-supply-lines.js';
import {fbpSupplyState} from '../src/shared/fbp-supply-state.js';

const ledger={physical_estimate:51,open_order_demand:0,fbp_reserved:0,incoming_quantity:200,current_shortage:0,current_incoming:0,flow_summary:{safety:0}};
const sku={shop_id:1,ozon_sku:'A',per_set_quantity:1,present:30,available:25,fbp_target:125,in_transit:0,committed_qty:0};
const forecast={skus:[sku]};
test('FBP shortage stays quantitative when local stock and procurement inbound cover all purchases',()=>{
 const state=inventoryWorkflow(ledger,{applications:[],forecast}),lines=inventorySupplyLines(state);
 assert.equal(state.fbp.physical,30);assert.equal(state.fbp.available,25);
 assert.deepEqual(lines.map(r=>r.key),['forecast']);
 assert.equal(lines[0].quantity,100);assert.equal(lines[0].stock,51);assert.equal(lines[0].incoming,49);assert.equal(lines[0].purchase,0);
 assert.equal(state.supply_plan.required_purchase+state.supply_plan.optional_purchase,0);
});
test('partial coverage shows separate shortage and purchase amounts; inbound is spent only once',()=>{
 const state=inventoryWorkflow({...ledger,physical_estimate:5,open_order_demand:10,current_shortage:2,current_incoming:3,incoming_quantity:8,flow_summary:{safety:4}},{applications:[],forecast});
 const lines=inventorySupplyLines(state),order=lines.find(r=>r.key==='orders'),local=lines.find(r=>r.key==='safety'),fbp=lines.find(r=>r.key==='forecast');
 assert.equal(order.quantity,5);assert.equal(order.incoming,3);assert.equal(order.purchase,2);
 assert.equal(local.quantity,4);assert.equal(local.incoming,4);assert.equal(local.purchase,0);
 assert.equal(fbp.incoming,1);assert.equal(fbp.purchase,99);
 assert.equal(lines.reduce((sum,r)=>sum+(r.incoming||0),0),8);
});
test('a pending FBP application replaces the same-SKU forecast, without hiding the official shortage',()=>{
 const state=inventoryWorkflow(ledger,{applications:[{status:'pending_review',shop_id:1,ozon_sku:'A',requested_quantity:100}],forecast});
 const lines=inventorySupplyLines(state),application=lines.find(r=>r.key==='fbp'),prediction=lines.find(r=>r.key==='forecast');
 assert.equal(application.quantity,100);assert.equal(application.stock,51);assert.equal(application.incoming,49);
 assert.equal(prediction.quantity,100);assert.equal(prediction.unsubmitted,0);assert.equal(prediction.purchase,0);
});
test('unknown local allocation does not hide known FBP shortage or invent procurement zeroes',()=>{
 const state=inventoryWorkflow({...ledger,physical_estimate:-2},{applications:[],forecast}),line=inventorySupplyLines(state).find(r=>r.key==='forecast');
 assert.equal(state.physical_recorded,-2);assert.equal(state.fbp.physical,30);
 assert.equal(line.quantity,100);assert.equal(line.unsubmitted,100);assert.equal(line.purchase,null);
});
test('official physical counts all warehouses and recipe units independently of target validity',()=>{
 const physical=fbpSupplyState({official_qty:80,skus:[{...sku,fbp_target:null}]});
 assert.equal(physical.known,false);assert.equal(physical.physical,80);
 const parts=fbpSupplyState({skus:[{...sku,per_set_quantity:2},{...sku,ozon_sku:'B',present:4}]});
 assert.equal(parts.physical,64);assert.equal(parts.available,75);
 const missing=fbpSupplyState({official_qty:30,stock_incomplete:true,skus:[sku,{...sku,ozon_sku:'B',present:null,available:null}]});
 assert.equal(missing.physical,null);assert.equal(missing.known,false);
 assert.equal(inventorySupplyLines(inventoryWorkflow(ledger,{applications:[],forecast:{skus:[]}})).find(r=>r.key==='forecast').quantity,null);
});
