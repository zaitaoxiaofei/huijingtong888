import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryWorkflow,procurementDemandType} from '../src/shared/inventory-workflow.js';
const base={physical_estimate:200,open_order_demand:10,fbp_reserved:0,current_shortage:0,incoming_quantity:0,current_incoming:0,flow_summary:{safety:100,local_days:10,applications:[]}};
test('allocation protects actual orders, then safety, then submitted FBP; draft never buys',()=>{
 const draft=inventoryWorkflow(base,{applications:[{status:'draft',requested_quantity:300}]});
 assert.equal(draft.free,90);assert.equal(draft.requested,0);assert.equal(draft.purchase_quantity,0);assert.equal(draft.demands[2].status,'success');assert.equal(draft.demands[2].process_status,'draft');
 const submitted=inventoryWorkflow(base,{applications:[{status:'pending_review',requested_quantity:150}]});
 assert.deepEqual(submitted.demands.map(d=>d.purchase_quantity),[0,0,60]);assert.equal(submitted.purchase_quantity,60);assert.equal(submitted.free,90);
});
test('confirmed FBP is locked exactly once; historical shipment never creates a new shortage',()=>{
 const state=inventoryWorkflow({...base,fbp_reserved:90},{applications:[{status:'approved',requested_quantity:150},{status:'sent',requested_quantity:300}]});
 assert.equal(state.free,0);assert.equal(state.purchase_quantity,0);assert.equal(state.requested,0);
});
test('inbound is consumed by actual shortage, safety, then FBP, without increasing physical availability',()=>{
 const state=inventoryWorkflow({...base,physical_estimate:3,open_order_demand:10,current_shortage:0,current_incoming:7,incoming_quantity:120},{applications:[{status:'pending_review',requested_quantity:20}]});
 assert.deepEqual(state.demands.map(d=>d.purchase_quantity),[0,0,7]);assert.equal(state.free,0);assert.equal(state.demands[0].status,'warning');assert.equal(state.demands[1].status,'warning');assert.match(state.incoming_note,/晚于交付期限/);
});
test('unknown physical, protection or application data never claims a known procurement total',()=>{
 for(const patch of [{physical_estimate:-1},{physical_estimate:null},{flow_summary:{safety:null,applications:[]}}]){
 const state=inventoryWorkflow({...base,...patch});assert.equal(state.free,null);assert.equal(state.purchase_quantity,null);assert.equal(state.demands[0].status,'unknown');
 }
 const state=inventoryWorkflow({...base,flow_summary:{safety:100,applications_pending:true}});
 assert.equal(state.demands[2].status,'unknown');assert.equal(state.purchase_quantity,null);
});
test('multiple people remind one supply pool without multiplying the recommended quantity',()=>{
 const requests=[{quantity:20,status:'submitted',demand_type:'warehouse_request',request_reason_code:'flow_local_safety'},{quantity:20,status:'pending',demand_type:'warehouse_request',request_reason_code:'flow_local_safety'},{quantity:80,status:'suggested',demand_type:'warehouse_request',request_reason_code:'flow_local_safety'}];
 const state=inventoryWorkflow(base,{requests});assert.equal(state.demands[1].submitted_quantity,20);assert.equal(state.demands[1].requests.length,3);assert.equal(state.demands[1].status,'success');assert.equal(state.demands[1].process_status,'request_submitted');assert.equal(state.purchase_quantity,0);
});
test('FBP opportunity remains advisory, source and demand type stay separate',()=>{
 const state=inventoryWorkflow(base,{forecast:{skus:[{suggested_qty:100,available:0}]}});
 assert.equal(state.demands[2].status,'success');assert.equal(state.demands[2].advisory_status,'opportunity');assert.equal(state.purchase_quantity,0);assert.equal(state.free,90);
 assert.equal(procurementDemandType({demand_type:'warehouse_request',request_reason_code:'flow_real_order'}),'real_order');
 assert.equal(procurementDemandType({demand_type:'warehouse_request',request_reason_code:'flow_fbp_stock'}),'fbp_stock');
 assert.equal(procurementDemandType({demand_type:'warehouse_request',source_order_item_id:1}),'local_safety');
});

test('339 physical minus 8 orders and 40 safety covers 20 FBP: green supply, pending review separately',()=>{
 const state=inventoryWorkflow({...base,physical_estimate:339,open_order_demand:8,flow_summary:{safety:40,applications:[]}},{applications:[{status:'pending_review',requested_quantity:20}]});
 assert.equal(state.free,291);assert.equal(state.requested,20);assert.equal(state.purchase_quantity,0);assert.equal(state.stock_status,'success');assert.equal(state.demands[2].status,'success');assert.equal(state.demands[2].process_status,'pending_review');
});

test('confirming then shipping FBP preserves available quantity without double deduction',()=>{
 const make=(physical,locked)=>inventoryWorkflow({...base,physical_estimate:physical,open_order_demand:8,fbp_reserved:locked,flow_summary:{safety:40,applications:[]}},{applications:locked?[{status:'approved',requested_quantity:20}]:[{status:'sent',requested_quantity:20}]});
 const confirmed=make(339,20),sent=make(319,0);assert.equal(confirmed.free,271);assert.equal(sent.free,271);assert.equal(confirmed.requested,0);assert.equal(sent.requested,0);assert.equal(sent.stock_status,'success');
});
