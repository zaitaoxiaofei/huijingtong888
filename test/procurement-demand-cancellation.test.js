import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {activeDemandCancellations,applyDemandCancellations,cancelledOrderPurchase} from '../src/shared/procurement-demand-cancellation.js';
import {inventoryWorkflow} from '../src/shared/inventory-workflow.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';
import {inventoryProcurementStatus} from '../src/shared/inventory-procurement-status.js';
import {supplementLiveProcurementRows} from '../src/services/procurement-live-demand.js';

process.env.DB_HOST ||= '127.0.0.1';process.env.DB_NAME ||= 'isolated_test';process.env.DB_USER ||= 'isolated_test';
const {createProcurementDemandCancellation,demandCancellationRevision}=await import('../src/services/procurement-demand-cancellation.js');

const source=(id,quantity=3)=>({order_item_id:id,order_id:id,product_id:200,quantity,stock_quantity:0,incoming_quantity:0,shortage_quantity:quantity,needs_fulfillment:true});
const event=(id,sourceRows,operation='cancel')=>({id,product_id:200,person_id:2,created_at:'2026-11-05 01:00:00',detail_json:{operation,cause:'supplier_out_of_stock',note:'厂家断货，订单由运营继续处理',sources:sourceRows}});
function state(orders,events){
  const total=orders.reduce((n,row)=>n+row.quantity,0),gap=orders.reduce((n,row)=>n+row.shortage_quantity,0);
  const value=inventoryWorkflow({physical_estimate:0,open_order_demand:total,fbp_reserved:0,current_shortage:gap,current_incoming:0,incoming_quantity:0,flow_summary:{safety:0},orders},{applications:[]});
  return applyDemandCancellations(value,orders,200,activeDemandCancellations(events));
}

test('fixed source decisions survive recomputation, preserve shortages, new orders, quantity growth and warnings',()=>{
  const orders=[source(11,3),source(12,2)],events=[event(1,[{order_item_id:11,order_id:11,quantity:3}])];
  const policy=state(orders,events);
  assert.equal(policy.order_demand,5);assert.equal(policy.physical_recorded,0);assert.equal(policy.incoming,0);
  assert.equal(policy.supply_plan.raw_required_fbs,5);assert.equal(policy.supply_plan.cancelled_fbs,3);assert.equal(policy.supply_plan.required_fbs,2);assert.equal(policy.purchase_quantity,2);
  assert.equal(state(orders,JSON.parse(JSON.stringify(events))).purchase_quantity,2,'persisted events reapply after restart');
  assert.equal(state([source(11,5),source(12,2)],events).purchase_quantity,4,'new quantity is not silently cancelled');
  assert.equal(state([source(11,1),source(12,2)],events).supply_plan.cancelled_fbs,1,'purchased or newly covered units are not suppressed again');
  const cancelled=state([source(11,3)],events);
  assert.equal(cancelled.supply_plan.required_fbs,0);assert.equal(cancelled.demands[0].physical_gap,3);
  assert.equal(inventoryProcurementStatus(cancelled,'orders'),'warning');
  const rows=[{product_id:200,workflow:cancelled}];
  assert.equal(inventoryWorkspacePage(rows,{task:'required'}).total,1);
  assert.equal(inventoryWorkspacePage(rows,{task:'cancelled'}).total,1);
  assert.equal(inventoryWorkspacePage(rows,{task:'cancelled'}).meta.cancelled,1);
  assert.ok(cancelled.review_reasons.some(reason=>reason.includes('订单缺货仍未解决')));
});

test('restoration is source-specific and no history limit loses older decisions',()=>{
  const events=Array.from({length:30},(_,i)=>event(i+1,[{order_item_id:i+1,order_id:i+1,quantity:1}]));
  events.push(event(31,[{order_item_id:2,order_id:2,quantity:1}],'restore'));
  const active=activeDemandCancellations(events.reverse());
  assert.equal(active.size,29);assert.equal(cancelledOrderPurchase(source(1,1),200,active).cancelled_purchase_quantity,1);
  assert.equal(cancelledOrderPurchase(source(2,1),200,active).actionable_shortage_quantity,1);
  assert.equal(cancelledOrderPurchase(source(1,1),201,active).cancelled_purchase_quantity,0,'another physical child is independent');
  assert.equal(cancelledOrderPurchase({...source(1,1),needs_fulfillment:0},200,active).cancelled_purchase_quantity,0,'closed orders do not stay in cancelled demand quantities');
});

test('legacy live projection does not recreate a reviewed cancelled demand but keeps new sources',()=>{
  const cancelled=activeDemandCancellations([event(1,[{order_item_id:11,order_id:11,quantity:3}])]);
  const coverage=new Map([[11,{order_id:11,needs_fulfillment:true,stock_location:'LOCAL',items:[source(11,3)]}],[12,{order_id:12,needs_fulfillment:true,stock_location:'LOCAL',items:[source(12,2)]}]]);
  const projected=supplementLiveProcurementRows([{product_id:200}],coverage,cancelled);
  assert.equal(projected.length,1);assert.equal(projected[0].source_order_item_id,12);assert.equal(projected[0].quantity,2);
  assert.equal(coverage.get(11).items[0].shortage_quantity,3,'factual coverage remains unchanged');
});

function fixture(){
  const f={orders:[source(11,3),source(12,2)],events:[],writes:[],role:'procurement',active:true,invalidations:[]};
  const query=async(sql,args=[])=>{
    if(sql.includes('JOIN tenant_members tm ON tm.tenant_id = t.id'))return f.active?[{id:args[1],slug:args[1]===3?'b':'a',tenant_role:'member',business_roles_json:[f.role]}]:[];
    if(sql.includes('FROM tenants WHERE'))return [{id:args[0],slug:args[0]===3?'b':'a'}];
    if(sql.includes('SELECT owned.* FROM products'))return args[0]===200&&args[1]===2?[{id:200,tenant_id:2}]:[];
    if(sql.includes('SELECT id,detail_json FROM inventory_flow_events'))return f.events.filter(row=>JSON.parse(row.detail_json).request_key===args[2]);
    if(sql.includes('SELECT oi.id FROM order_items'))return args.filter(id=>f.orders.some(row=>row.order_item_id===id)).map(id=>({id}));
    if(sql.includes('FROM inventory_flow_events e'))return f.events;
    throw new Error('Unexpected SQL: '+sql);
  };
  const connection={query:async(...args)=>[await query(...args)],execute:async(sql,args)=>{
    f.writes.push({sql,args});
    if(sql.startsWith('INSERT INTO inventory_flow_events')){const row={id:f.events.length+1,product_id:args[1],person_id:args[2],detail_json:args[4]};f.events.push(row);return [{insertId:row.id}];}
    if(sql.startsWith('UPDATE procurement_requests'))return [{affectedRows:1}];
    throw new Error('Unexpected write: '+sql);
  }};
  const coverage=async()=>new Map(f.orders.map(row=>[row.order_id,{order_id:row.order_id,needs_fulfillment:row.needs_fulfillment,stock_location:'LOCAL',items:[row]}]));
  f.cancel=createProcurementDemandCancellation({transaction:work=>work(connection),coverage,invalidate:value=>f.invalidations.push(value),readState:async()=>state(f.orders,f.events)});
  f.revision=()=>demandCancellationRevision(f.orders,activeDemandCancellations(f.events),200);
  f.body=(extra={})=>({product_id:200,order_item_ids:[11],cause:'supplier_out_of_stock',note:'厂家断货，暂不采购；订单另行处理',request_key:randomUUID(),expected_revision:f.revision(),...extra});
  f.session={personId:2,tenant:{id:2,slug:'a'}};return f;
}

test('cancel/restore persists actor and reason, is idempotent after supply changes and never writes stock or orders',async()=>{
  const f=fixture(),body=f.body(),before=JSON.stringify(f.orders);
  const result=await f.cancel(body,f.session);
  assert.equal(result.state.purchase_quantity,2);assert.equal(result.sources[0].quantity,3);assert.equal(f.events.length,1);
  assert.equal(f.events[0].person_id,2);assert.equal(JSON.parse(f.events[0].detail_json).note,body.note);
  assert.equal(JSON.stringify(f.orders),before);
  assert.ok(f.writes.every(row=>/^(INSERT INTO inventory_flow_events|UPDATE procurement_requests)/.test(row.sql)));
  assert.match(f.writes[1].sql,/purchase_order_id IS NULL/);assert.match(f.writes[1].sql,/status IN\('suggested','pending','submitted'\)/);
  f.orders[0].shortage_quantity=1;
  assert.equal((await f.cancel(body,f.session)).duplicate,true);assert.equal(f.events.length,1);
  await assert.rejects(f.cancel({...body,note:'改过原因'},f.session),{statusCode:409});
  const restore=await f.cancel(f.body({operation:'restore',note:'核对后恢复采购'}),f.session);
  assert.equal(restore.state.purchase_quantity,3);assert.equal(restore.operation,'restore');assert.equal(f.events.length,2);
  assert.deepEqual(f.invalidations.at(-1),{tenantId:2,productIds:[200]});
});

test('live membership, tenant ownership, source changes and revisions are checked before writing',async()=>{
  const f=fixture();
  f.role='packing';await assert.rejects(f.cancel(f.body(),f.session),{statusCode:403});f.role='procurement';
  await assert.rejects(f.cancel(f.body(),{personId:2,tenant:{id:3,slug:'b'}}),{statusCode:404});
  f.active=false;await assert.rejects(f.cancel(f.body(),f.session),{statusCode:403});f.active=true;
  await assert.rejects(f.cancel(f.body({order_item_ids:[999]}),f.session),{statusCode:404});
  const stale=f.body();f.orders[0].shortage_quantity=2;await assert.rejects(f.cancel(stale,f.session),{statusCode:409});
  f.orders[0].needs_fulfillment=false;await assert.rejects(f.cancel(f.body(),f.session),{statusCode:409});
  f.orders[0].needs_fulfillment=true;f.orders[0].quantity_needs_review=true;await assert.rejects(f.cancel(f.body(),f.session),{statusCode:409});
  assert.equal(f.events.length,0);assert.equal(f.writes.length,0);
});
