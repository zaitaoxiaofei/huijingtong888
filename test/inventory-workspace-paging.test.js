import test from 'node:test';
import assert from 'node:assert/strict';
import {createInventoryWorkspacePageCache} from '../frontend/admin/utils/inventory-workspace-pages.js';
import {inventoryWorkflow} from '../src/shared/inventory-workflow.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';
import {fbpSupplyState} from '../src/shared/fbp-supply-state.js';

const ledger={physical_estimate:10,open_order_demand:30,fbp_reserved:0,incoming_quantity:12,current_incoming:12,current_shortage:8,flow_summary:{safety:10}};
const applications=[{status:'pending_review',shop_id:2,ozon_sku:'A',requested_quantity:5}];
const forecast={skus:[{shop_id:2,ozon_sku:'A',available:0,per_set_quantity:1,fbp_target:20,in_transit:0,committed_qty:0}]};

test('a page is isolated by session/filters, expires and is bounded; manual writes can clear it',()=>{
 let now=0;const cache=createInventoryWorkspacePageCache({now:()=>now,ttl:20,max:2});
 cache.set('A','page=2',{rows:[2]});assert.deepEqual(cache.get('A','page=2'),{rows:[2]});
 assert.equal(cache.get('B','page=2'),null);assert.equal(cache.get('A','page=2&task=review'),null);
 now=21;assert.equal(cache.get('A','page=2'),null);
 for(let i=0;i<3;i++)cache.set('A','page='+i,{rows:[i]});assert.equal(cache.get('A','page=0'),null);
 cache.clear();assert.equal(cache.get('A','page=2'),null);
});

test('negative ledger evidence stays visible while procurement quantities remain unconfirmed, not zero',()=>{
 const r=inventoryWorkflow({...ledger,physical_estimate:-7},{applications,forecast});
 assert.equal(r.physical_recorded,-7);assert.equal(r.physical,null);assert.equal(r.supply_plan.required_purchase,null);
 assert.equal(r.safety_target,10);assert.equal(r.supply_plan.order_quantity,30);
 assert.match(r.review_reasons[0],/账面库存为负/);
 assert.equal(inventoryWorkspacePage([{product_id:1,workflow:r}],{task:'required'}).total,1);
});

test('missing SKU stocks explain uncertainty; a real synchronized zero is known',()=>{
 const missing=fbpSupplyState({...forecast,skus:[...forecast.skus,{...forecast.skus[0],ozon_sku:'B',available:null}]});
 assert.equal(missing.known,false);assert.equal(missing.missing_stock_count,1);assert.match(missing.unknown_reason,/缺少 1 个SKU/);
 assert.match(fbpSupplyState({skus:[]}).unknown_reason,/未绑定/);
 assert.equal(fbpSupplyState(forecast).known,true);
});

test('purchases on the road cover demand once; partial coverage leaves only the remaining purchase gap',()=>{
 const partial=inventoryWorkflow(ledger,{applications,forecast});
 assert.equal(partial.supply_plan.required_fbs,8);assert.equal(partial.supply_plan.required_fbp,5);
 assert.equal(partial.supply_plan.fbs_waiting_incoming,12);assert.equal(partial.incoming,12);
 const covered=inventoryWorkflow({...ledger,incoming_quantity:80,current_incoming:20,current_shortage:0},{applications,forecast});
 assert.equal(covered.supply_plan.required_purchase,0);assert.equal(covered.supply_plan.optional_purchase,0);
 assert.equal(inventoryWorkspacePage([{product_id:1,workflow:covered}],{task:'required'}).total,0);
 assert.equal(inventoryWorkspacePage([{product_id:1,workflow:covered}],{task:'incoming'}).total,1);
});
