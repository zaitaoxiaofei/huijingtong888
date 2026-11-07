import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateLocalInventorySafety} from '../src/services/inventory-flow-summary-model.js';
import {calculateFlowProduct,validateFlowSettings} from '../src/services/inventory-flow-rules.js';

test('manual local safety applies consistently to summary and flow, including zero and restoring auto',()=>{
 const now=new Date('2026-10-30T12:00:00Z'),product={production_lead_days:7,warehouse_logistics_days:2,created_days:30},ledger={product,orders:[{order_id:1,order_item_id:1,entered_transport:true,stock_location:'LOCAL',quantity:7,transport_at:'2026-10-29T00:00:00Z'}]};
 const skus=[{per_set_quantity:1,available:0,sales:{fbs7:7,d14:7,fbp14:0},present:0}],balance={physical_stock:100,open_order_demand_qty:10,fbp_reserved_qty:0};
 for(const override of [null,5,0]){
  const settings=validateFlowSettings({local_safety_override:override,local_safety_override_note:'销量变化'});
  const local=calculateLocalInventorySafety(ledger,settings,now),flow=calculateFlowProduct(product,balance,skus,settings,'2026-10-30');
  assert.equal(local.recommended_safety_qty,9);assert.equal(flow.recommended_safety_qty,9);assert.equal(local.safety_qty,override??9);assert.equal(flow.safety_qty,override??9);assert.equal(flow.free_qty,90-(override??9));
 }
 assert.throws(()=>validateFlowSettings({local_safety_override:-1}),/整数/);assert.throws(()=>validateFlowSettings({local_safety_override:1.5}),/整数/);
});
