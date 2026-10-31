import test from 'node:test';import assert from 'node:assert/strict';
import {inventoryWorkflow,procurementDemandType} from '../src/shared/inventory-workflow.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';
import {fbpForecastSuggestions} from '../src/shared/fbp-supply-state.js';
const ledger={physical_estimate:0,open_order_demand:10,fbp_reserved:0,current_shortage:10,current_incoming:0,incoming_quantity:0,flow_summary:{safety:5},fbp_inventory:{incomplete:false}};
const forecast={skus:[{shop_id:1,ozon_sku:'A',mapping_id:1,available:0,fbp_target:20,per_set_quantity:1,in_transit:0,committed_qty:0}]};
const app=(n,patch={})=>({shop_id:1,ozon_sku:'A',status:'pending_review',requested_quantity:n,...patch});
const demand=(state,key)=>state.demands.find(d=>d.key===key);
test('four purposes separate optional yellow forecasts from required confirmed applications',()=>{
 const s=inventoryWorkflow(ledger,{applications:[],forecast});assert.equal(s.demands.length,4);assert.equal(demand(s,'fbp_stock').purchase_quantity,0);assert.equal(demand(s,'fbp_forecast').purchase_quantity,20);assert.equal(demand(s,'fbp_forecast').status,'warning');assert.equal(s.purchase_quantity,35);
 const partial=inventoryWorkflow(ledger,{applications:[app(8)],forecast});assert.equal(demand(partial,'fbp_stock').purchase_quantity,8);assert.equal(demand(partial,'fbp_stock').status,'danger');assert.equal(demand(partial,'fbp_forecast').purchase_quantity,12);assert.equal(partial.purchase_quantity,35);
 const full=inventoryWorkflow(ledger,{applications:[app(20)],forecast});assert.equal(demand(full,'fbp_stock').purchase_quantity,20);assert.equal(demand(full,'fbp_forecast').purchase_quantity,0);assert.equal(full.purchase_quantity,35);
 assert.equal(procurementDemandType({request_reason_code:'flow_fbp_forecast',source_type:'fbp'}),'fbp_forecast');
});
test('drafts never confirm demand and a different store cannot consume this SKU forecast',()=>{
 const s=inventoryWorkflow(ledger,{applications:[app(8,{status:'draft'})],forecast});assert.equal(s.supply_plan.required_fbp,0);assert.equal(s.supply_plan.optional_fbp,20);
 const other=inventoryWorkflow(ledger,{applications:[app(8,{shop_id:2})],forecast});assert.equal(other.supply_plan.required_fbp,8);assert.equal(other.supply_plan.optional_fbp,20);
});
test('known local stock can cover purchase cost but operations still needs the FBP warning and transfer entry',()=>{
 const s=inventoryWorkflow({...ledger,physical_estimate:100,current_shortage:0},{applications:[],forecast});assert.equal(s.supply_plan.optional_fbp,0);assert.equal(s.supply_plan.fbp_forecast_quantity,20);assert.equal(demand(s,'fbp_forecast').status,'warning');assert.equal(inventoryWorkspacePage([{product_id:1,workflow:s}],{task:'advisory'}).total,1);
 const incoming=inventoryWorkflow({...ledger,incoming_quantity:35,current_incoming:10,current_shortage:0},{applications:[],forecast});assert.equal(incoming.purchase_quantity,0);
});
test('quick suggestions subtract pending physical quantities per shop/SKU and retain set conversion',()=>{
 const s=inventoryWorkflow(ledger,{applications:[app(8)],forecast:{skus:[{...forecast.skus[0],per_set_quantity:2},{...forecast.skus[0],shop_id:2}]}});
 const rows=fbpForecastSuggestions([app(8)],s.fbp);assert.equal(rows[0].suggested_application_qty,16);assert.equal(rows[0].forecast_physical,32);assert.equal(rows[1].suggested_application_qty,20);
 assert.deepEqual(fbpForecastSuggestions([], {known:false}),[]);
});

test('verified low FBP stock remains yellow even when local stock is not counted; no invented purchase quantity',()=>{const s=inventoryWorkflow({...ledger,physical_estimate:null},{applications:[],forecast});assert.equal(demand(s,'fbp_forecast').status,'warning');assert.equal(demand(s,'fbp_forecast').purchase_quantity,null);assert.equal(s.purchase_quantity,null);});
