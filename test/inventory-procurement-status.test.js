import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryWorkflow} from '../src/shared/inventory-workflow.js';
import {inventorySupplyLines} from '../src/shared/inventory-supply-lines.js';
import {inventoryPurchaseQuantity} from '../src/shared/inventory-supply-plan.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';
import {groupProcurementRequestsMysql} from '../src/services/mysql-procurement-list.js';

const ledger={physical_estimate:-37,open_order_demand:13,current_shortage:13,current_incoming:0,incoming_quantity:0,fbp_reserved:0,flow_summary:{safety:12}};
const forecast={skus:[{shop_id:1,ozon_sku:'A',per_set_quantity:1,present:30,available:30,fbp_target:20,in_transit:0,committed_qty:0}]};
const read=(patch={},applications=[],prediction=forecast)=>inventoryWorkflow({...ledger,...patch},{applications,forecast:prediction});
const colours=state=>Object.fromEntries(inventorySupplyLines(state).map(r=>[r.key,r.status]));
const grouped=(workflow,patch={})=>groupProcurementRequestsMysql([{id:1,product_id:10,quantity:13,status:'suggested',source_order_id:100,source_order_item_id:200,source_order_status:'awaiting_packaging',operational_needs_fulfillment:true,operational_shortage:13,stock:-37,workflow,...patch}],{demandType:'real_order'});

test('negative history never hides 13 confirmed order pieces or creates 37 extra purchase pieces',()=>{
 const s=read();assert.equal(s.physical_recorded,-37);assert.equal(s.physical,null);assert.equal(s.free,null);
 assert.equal(s.supply_plan.known,false);assert.equal(s.supply_plan.fbs_known,true);
 assert.equal(s.demands[0].purchase_quantity,13);assert.equal(inventoryPurchaseQuantity(s.supply_plan),13);assert.equal(s.purchase_partial,true);
 assert.equal(s.supply_plan.optional_local,null);assert.match(s.review_reasons[0],/账面库存为负/);
 assert.deepEqual(colours(s),{orders:'danger',safety:'info',fbp:'info',forecast:'success'});
 assert.equal(grouped(s).rows[0].suggested_purchase_qty,13);
 assert.equal(inventoryWorkspacePage([{product_id:10,workflow:s}],{task:'required'}).total,1);
});
test('allocated inbound is deducted once even if the historical ledger is negative',()=>{
 const s=read({current_shortage:8,current_incoming:5,incoming_quantity:5});
 assert.equal(inventoryPurchaseQuantity(s.supply_plan),8);assert.equal(grouped(s).rows[0].suggested_purchase_qty,8);
 const covered=read({current_shortage:0,current_incoming:13,incoming_quantity:13});
 assert.equal(covered.supply_plan.required_fbs,0);assert.equal(colours(covered).orders,'success');
 assert.equal(inventoryWorkspacePage([{product_id:10,workflow:covered}],{task:'required'}).total,0);
 assert.equal(inventoryWorkspacePage([{product_id:10,workflow:covered}],{task:'review'}).total,1);
});
test('a covered submitted request stays traceable but never turns its old requested quantity into a new purchase',()=>{
 const workflow=read({physical_estimate:0,current_shortage:0,current_incoming:13,incoming_quantity:25});
 workflow.demands[0].submitted_quantity=13;
 const row=grouped(workflow).rows[0];assert.equal(row.suggested_purchase_qty,0);assert.equal(row.suggestion_reasons[0].submitted_quantity,13);
});
test('unknown order quantities remain unknown rather than permitting a guessed purchase',()=>{
 for(const patch of [{current_shortage:null},{current_shortage:14},{orders:[{needs_fulfillment:true,quantity_needs_review:true}]}]){
  const s=read(patch);assert.equal(s.supply_plan.fbs_known,false);assert.equal(inventoryPurchaseQuantity(s.supply_plan),null);assert.equal(colours(s).orders,'info');
 }
 const localUnknown=read({fbp_reserved:null});assert.equal(localUnknown.supply_plan.required_fbp,null);
});
test('required gaps are red, optional gaps yellow, covered green, and an absent application gray',()=>{
 const application=[{shop_id:1,ozon_sku:'A',status:'pending_review',requested_quantity:20}];
 assert.deepEqual(colours(read({physical_estimate:0},application)),{orders:'danger',safety:'warning',fbp:'danger',forecast:'success'});
 assert.deepEqual(colours(read({physical_estimate:200,current_shortage:0},application)),{orders:'success',safety:'success',fbp:'success',forecast:'success'});
 assert.equal(colours(read({physical_estimate:200,current_shortage:0})).fbp,'info');
 const low={skus:[{...forecast.skus[0],present:0,available:0,fbp_target:100}]};
 assert.equal(colours(read({physical_estimate:0},[],low)).forecast,'warning');
 assert.equal(colours(read({},[],null)).forecast,'info');
});
