import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';
import {inventoryWorkflow} from '../src/shared/inventory-workflow.js';
import {applyInventoryWorkspaceUpdates} from '../frontend/admin/utils/inventory-workspace-updates.js';
const forecast={skus:[{shop_id:1,ozon_sku:'A',available:88,present:88,fbp_target:104,per_set_quantity:1,in_transit:0,committed_qty:0}]};
const state=(physical,applications=[])=>inventoryWorkflow({physical_estimate:physical,open_order_demand:0,fbp_reserved:0,incoming_quantity:0,current_incoming:0,current_shortage:0,flow_summary:{safety:0}},{applications,forecast});

test('stocked FBP forecast is a stocking suggestion, not a purchase replenishment',()=>{
 const workflow=state(2187),row={product_id:1,workflow};
 assert.equal(workflow.supply_plan.optional_purchase,0);assert.equal(workflow.supply_plan.fbp_forecast_quantity,16);
 assert.equal(inventoryWorkspacePage([row],{task:'advisory'}).total,0);
 const result=inventoryWorkspacePage([row],{task:'fbp-stocking'});assert.equal(result.total,1);assert.equal(result.meta['fbp-stocking'],1);assert.equal(result.meta.advisory,0);
 assert.equal(workflow.supply_plan.forecast_ready_stock,16);
});
test('actual procurement gaps remain actionable while the forecast has its own stocking category',()=>{
 const row={product_id:1,workflow:state(0)};
 assert.equal(row.workflow.supply_plan.optional_purchase,16);assert.equal(inventoryWorkspacePage([row],{task:'advisory'}).total,1);assert.equal(inventoryWorkspacePage([row],{task:'fbp-stocking'}).total,1);
});
test('confirmed applications leave suggestions and do not duplicate the same forecast',()=>{
 const workflow=state(0,[{status:'pending_review',shop_id:1,ozon_sku:'A',requested_quantity:16}]),row={product_id:1,workflow};
 assert.equal(workflow.supply_plan.fbp_forecast_quantity,0);assert.equal(inventoryWorkspacePage([row],{task:'fbp-stocking'}).total,0);assert.equal(inventoryWorkspacePage([row],{task:'required'}).total,1);
});
test('unknown forecasts stay in review and do not appear as a confirmed suggestion',()=>{
 const row={product_id:1,workflow:{supply_plan:{known:true,required_purchase:0,optional_purchase:0,fbp_forecast_quantity:16,fbp_forecast_known:false}}};
 assert.equal(inventoryWorkspacePage([row],{task:'fbp-stocking'}).total,0);assert.equal(inventoryWorkspacePage([row],{task:'review'}).total,1);
});
test('stocking suggestions keep filters, stable paging and live counters after confirmation',()=>{
 const rows=Array.from({length:55},(_,i)=>({product_id:i+1,workflow:state(2187)}));
 const page=inventoryWorkspacePage(rows,{task:'fbp-stocking',page:2,pageSize:20});assert.equal(page.total,55);assert.deepEqual(page.rows.map(row=>row.product_id),Array.from({length:20},(_,i)=>i+21));
 assert.equal(inventoryWorkspacePage(rows,{task:'fbp-stocking',product_id:3}).total,1);assert.equal(inventoryWorkspacePage(rows,{task:'fbp-stocking',scope:'orders'}).total,0);
 const initial=inventoryWorkspacePage([rows[0]],{task:'fbp-stocking'});const next=state(2187,[{status:'pending_review',shop_id:1,ozon_sku:'A',requested_quantity:16}]);next.calculated_at='2026-11-04T08:00:00Z';
 const patched=applyInventoryWorkspaceUpdates({...initial,snapshot:{stale:true}},new Map([[1,{workflow:next}]]),{task:'fbp-stocking'});assert.equal(patched.total,0);assert.equal(patched.meta['fbp-stocking'],0);assert.equal(patched.rows.length,0);
});
