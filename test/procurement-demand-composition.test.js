import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createPhysicalInventoryReader} from '../src/shared/inventory-composition.js';
import {expandCurrentProcurementDemands,procurementDemandAncestorIds} from '../src/services/procurement-demand-composition.js';
import {calculateOrderProcurementCoverage} from '../src/services/order-procurement-coverage.js';
import {inventorySupplyPlan} from '../src/shared/inventory-supply-plan.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';
const products=[1,2,3,4].map(id=>({id,name:`P${id}`,active:1}));
const edges=[{product_id:1,component_product_id:2,quantity:2},{product_id:2,component_product_id:3,quantity:3},{product_id:1,component_product_id:3,quantity:1}];
const composition={components:createPhysicalInventoryReader(products,edges)};
const demand=(product_id,quantity=1,other={})=>({order_id:10,order_item_id:11,root_product_id:1,posting_number:'test-1',product_id,quantity,stock_location:'LOCAL',needs_fulfillment:1,entered_transport:0,...other});
test('nested components multiply ratios and merge duplicate leaves within one order item',()=>{
 const rows=expandCurrentProcurementDemands([demand(2,2),demand(3,1)],composition);
 assert.equal(rows.length,1);assert.equal(rows[0].product_id,3);assert.equal(rows[0].quantity,7);assert.equal(rows[0].root_product_id,1);
 assert.deepEqual(procurementDemandAncestorIds([3],edges),[3,2,1]);
 const separate=expandCurrentProcurementDemands([demand(2),demand(2,1,{order_item_id:12})],composition);
 assert.equal(separate.length,2);
});
test('historical shipments and FBP demand are never reinterpreted using current compositions',()=>{
 for(const row of [demand(2,1,{needs_fulfillment:0,entered_transport:1}),demand(2,1,{stock_location:'FBP'})])assert.deepEqual(expandCurrentProcurementDemands([row],composition),[row]);
});
test('cyclic or foreign compositions block explicitly instead of silently omitting demand',()=>{
 const invalid={components:createPhysicalInventoryReader(products,[...edges,{product_id:3,component_product_id:1,quantity:1}])};
 assert.throws(()=>expandCurrentProcurementDemands([demand(2)],invalid),/订单 test-1.*循环.*库存管理/);
 const foreign={components:createPhysicalInventoryReader(products,[{product_id:2,component_product_id:99,quantity:1}])};
 assert.throws(()=>expandCurrentProcurementDemands([demand(2)],foreign),/不可访问/);
});
test('order gap and required purchase share leaf stock and incoming without duplicate parent demand',()=>{
 const demands=expandCurrentProcurementDemands([demand(2,2),demand(3,1)],composition);
 const c=calculateOrderProcurementCoverage({demands,stocks:[{product_id:3,ledger:3}],inbounds:[{id:1,product_id:3,quantity:2,status:'pending_arrival'}]});
 const order=c.get(10);assert.equal(order.shortage_quantity,2);assert.equal(order.items.length,1);
 const plan=inventorySupplyPlan({physical_estimate:3,open_order_demand:7,current_shortage:order.shortage_quantity,current_incoming:order.incoming_quantity,incoming_quantity:2,fbp_reserved:0,flow_summary:{safety:0}},[],{skus:[]});
 const page=inventoryWorkspacePage([{product_id:3,workflow:{supply_plan:plan}}],{task:'required'});
 assert.equal(page.total,1);assert.equal(page.rows[0].workflow.supply_plan.required_fbs,order.shortage_quantity);
});

test('order action clearly distinguishes cancelled shortage, active shortage and covered supply',()=>{
 const source=readFileSync(new URL('../frontend/orders/components/OrdersTable.vue',import.meta.url),'utf8');
 const label=vm.runInNewContext('('+source.slice(source.indexOf('function procurementActionLabel('),source.indexOf('\nfunction procurementActionClass('))+')');
 assert.equal(label({procurement_coverage:{shortage_quantity:3,cancelled_purchase_quantity:2,actionable_shortage_quantity:1}}),'待采购（缺 1；人工处理 2）');
 assert.equal(label({procurement_coverage:{shortage_quantity:1,cancelled_purchase_quantity:0}}),'待采购（缺 1）');
 assert.equal(label({procurement_coverage:{shortage_quantity:0,incoming_quantity:1}}),'采购在途');
});

test('cancelled shortages are manual handling records instead of required purchases',()=>{
 const all=[{product_id:49,workflow:{supply_plan:{known:true,cancelled_fbs:3,required_purchase:0,optional_purchase:5}}}];
 assert.equal(inventoryWorkspacePage(all,{task:'required'}).total,0);
 assert.equal(inventoryWorkspacePage(all,{task:'advisory'}).total,1);
});
