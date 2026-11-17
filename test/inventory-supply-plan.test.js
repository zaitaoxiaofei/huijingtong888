import test from 'node:test';import assert from 'node:assert/strict';
import {inventorySupplyPlan} from '../src/shared/inventory-supply-plan.js';
const base={physical_estimate:20,open_order_demand:10,fbp_reserved:0,incoming_quantity:5,current_incoming:0,current_shortage:0,flow_summary:{safety:10},fbp_inventory:{incomplete:false}};
const app=n=>[{status:'pending_review',shop_id:1,ozon_sku:'S',requested_quantity:n}];
const forecast=(target=40)=>({skus:[{shop_id:1,ozon_sku:'S',per_set_quantity:1,available:0,fbp_target:target,in_transit:0,committed_qty:0}]});
test('submitted FBP is required; safety remains optional and shared inbound is spent once',()=>{const p=inventorySupplyPlan(base,app(20),forecast());assert.equal(p.required_fbp,5);assert.equal(p.optional_local,10);assert.equal(p.optional_fbp,20);assert.equal(p.required_purchase+p.optional_purchase,35);});
test('forecast alone is yellow optional; a draft does not become a required application',()=>{const p=inventorySupplyPlan(base,[{...app(20)[0],status:'draft'}],forecast());assert.equal(p.required_purchase,0);assert.equal(p.optional_local,0);assert.equal(p.optional_fbp,35);});
test('existing inbound covers required work without generating duplicate purchases',()=>{const p=inventorySupplyPlan({...base,incoming_quantity:50},app(20),forecast());assert.equal(p.required_purchase,0);assert.equal(p.optional_purchase,0);assert.equal(p.fbp_waiting_incoming,10);});
test('orders take their allocated inbound; unbacked confirmed locks are not hidden after a count correction',()=>{const p=inventorySupplyPlan({...base,physical_estimate:0,fbp_reserved:8,current_shortage:7,current_incoming:3,incoming_quantity:5},app(2),forecast(0));assert.equal(p.required_fbs,7);assert.equal(p.required_fbp,8);assert.equal(p.unbacked_fbp_locks,8);});
test('unknown physical stock and application evidence are explicit; unknown official stock does not hide a submitted need',()=>{assert.equal(inventorySupplyPlan({...base,physical_estimate:-1},app(20),forecast()).known,false);assert.equal(inventorySupplyPlan(base,undefined,forecast()).required_fbp,null);const p=inventorySupplyPlan(base,app(20),null);assert.equal(p.required_fbp,5);assert.equal(p.optional_fbp,null);assert.equal(p.fbp_forecast_known,false);});

test('approved but unshipped FBP is second-priority demand; FBS uses the physical pool first',()=>{
 const ledger={...base,physical_estimate:17,open_order_demand:4,fbp_reserved:15,incoming_quantity:0,current_incoming:0,current_shortage:0,flow_summary:{safety:9}};
 const p=inventorySupplyPlan(ledger,[{status:'approved',requested_quantity:15}],null);
 assert.equal(p.required_fbs,0);assert.equal(p.fbs_physical_gap,0);assert.equal(p.formal_fbp_quantity,15);assert.equal(p.approved_fbp_quantity,15);assert.equal(p.submitted_fbp_quantity,0);
 assert.equal(p.fbp_ready_stock,13);assert.equal(p.required_fbp,2);assert.equal(p.optional_local,9);assert.equal(p.required_purchase,2);assert.equal(p.optional_purchase,9);
 const transit=inventorySupplyPlan({...ledger,incoming_quantity:2},[],null);assert.equal(transit.required_fbs,0);assert.equal(transit.fbp_waiting_incoming,2);assert.equal(transit.required_fbp,0);assert.equal(transit.optional_local,9);
 const allCovered=inventorySupplyPlan({...ledger,incoming_quantity:11},[],null);assert.equal(allCovered.required_purchase,0);assert.equal(allCovered.optional_purchase,0);
 const mixed=inventorySupplyPlan(ledger,[{status:'approved',requested_quantity:15},{status:'pending_review',requested_quantity:3}],null);assert.equal(mixed.formal_fbp_quantity,18);assert.equal(mixed.required_fbp,5);
});
test('actual dispatched stock is already absent from the physical pool and is not requested or locked again',()=>{
 const p=inventorySupplyPlan({...base,physical_estimate:2,open_order_demand:4,fbp_reserved:0,incoming_quantity:0,current_shortage:2,flow_summary:{safety:0}},[{status:'sent',requested_quantity:15}],null);
 assert.equal(p.formal_fbp_quantity,0);assert.equal(p.required_fbs,2);assert.equal(p.required_fbp,0);
});
