import test from 'node:test';import assert from 'node:assert/strict';
import {applyInventoryWorkspaceUpdates} from '../frontend/admin/utils/inventory-workspace-updates.js';
import {inventoryWorkflow} from '../src/shared/inventory-workflow.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';
const forecast={skus:[{shop_id:1,ozon_sku:'A',per_set_quantity:1,present:2,available:2,fbp_target:0,in_transit:0,committed_qty:0}]};
const state=(physical,shortage)=>inventoryWorkflow({physical_estimate:physical,open_order_demand:1,fbp_reserved:0,current_shortage:shortage,current_incoming:0,incoming_quantity:0,flow_summary:{safety:0}},{applications:[],forecast});
const before={product_id:1,workflow:state(-1,1)},saved=state(5,0);saved.calculated_at='2026-10-31T10:00:00Z';
function setup(task='all'){
 const page=inventoryWorkspacePage([before],{task});
 const result={...page,snapshot:{available:true,stale:true,refreshing:true,calculated_at:'2026-10-31T09:59:00Z'}};
 return{result,updates:new Map([[1,{workflow:saved}]]),criteria:{task}};
}
test('the screenshot case updates negative stock to physical 5 and free 4 despite an older cached page',()=>{
 const {result,updates,criteria}=setup();const r=applyInventoryWorkspaceUpdates(result,updates,criteria);
 assert.equal(r.rows[0].workflow.physical_recorded,5);assert.equal(r.rows[0].workflow.free,4);assert.equal(r.rows[0].workflow.supply_plan.required_fbs,0);
 assert.equal(r.meta.required,0);assert.equal(r.meta.review,0);assert.equal(result.rows[0].workflow.physical_recorded,-1,'cached source untouched');
 const repeat=applyInventoryWorkspaceUpdates(result,updates,criteria);assert.equal(repeat.rows[0].workflow.physical_recorded,5);assert.equal(repeat.meta.required,0);
});
test('a newly covered stock row exits must-buy immediately without waiting for the full refresh',()=>{
 const {result,updates,criteria}=setup('required');const r=applyInventoryWorkspaceUpdates(result,updates,criteria);assert.equal(r.total,0);assert.deepEqual(r.rows,[]);assert.equal(r.meta.required,0);
});
test('only a completed newer snapshot releases the live update; a stale late calculation cannot overwrite it',()=>{
 const {result,updates,criteria}=setup();
 const late={...result,snapshot:{...result.snapshot,calculated_at:'2026-10-31T10:01:00Z'}};
 assert.equal(applyInventoryWorkspaceUpdates(late,updates,criteria).rows[0].workflow.physical_recorded,5);assert.equal(updates.size,1);
 const ready={...result,rows:[{...before,workflow:saved}],snapshot:{available:true,stale:false,refreshing:false,calculated_at:'2026-10-31T10:02:00Z'}};
 assert.equal(applyInventoryWorkspaceUpdates(ready,updates,criteria),ready);assert.equal(updates.size,0);
});
test('updates do not subtract another page twice and clearing the session map discards private overlays',()=>{
 const {result,updates,criteria}=setup();const absent={...result,rows:[],total:0,meta:{...result.meta,required:0}};
 assert.equal(applyInventoryWorkspaceUpdates(absent,updates,criteria).meta.required,0);
 updates.clear();assert.equal(applyInventoryWorkspaceUpdates(result,updates,criteria),result);
});
