import test from 'node:test';
import assert from 'node:assert/strict';
import {selectOrderPage,retainSelectedOrders} from '../frontend/orders/utils/order-selection.js';
import {withOglDispatch,oglBoundStatusSql,oglDispatchedStatusSql,oglPhysicalDispatchSql} from '../src/services/ogl-dispatch-state.js';
import {oglOrderReviewSignature} from '../src/services/ogl-dispatch.js';
import {createOglCarriageClient} from '../src/services/ogl-carriage-client.js';
import {orderStateKey} from '../frontend/orders/constants/orders-ui.js';

test('page checkbox merges and subtracts only that page, retaining selections and action metadata elsewhere',()=>{
 const a=[{id:1,shop_name:'A'},{id:2,shop_name:'B'}],b=[{id:3,shop_name:'C'},{id:4,shop_name:'D'}];
 let selected=selectOrderPage(new Set(),a,true),records=retainSelectedOrders(new Map(),a,selected);
 selected=selectOrderPage(selected,b,true);records=retainSelectedOrders(records,b,selected);
 assert.deepEqual([...selected],[1,2,3,4]);assert.equal(records.get(1).shop_name,'A');
 selected=selectOrderPage(selected,b,false);records=retainSelectedOrders(records,b,selected);
 assert.deepEqual([...selected],[1,2]);assert.deepEqual([...records.keys()],[1,2]);
 assert.equal(selectOrderPage(selected,[{id:0},{id:-3},{id:'broken'}],true).size,2);
 assert.equal(retainSelectedOrders(records,[],new Set()).size,0,'tenant/session reset clears off-page snapshots');
});

test('an off-page updated row replaces its selected snapshot without restoring explicitly removed orders',()=>{
 let map=retainSelectedOrders(new Map(),[{id:1,status:'awaiting_deliver'}],new Set([1]));
 map=retainSelectedOrders(map,[{id:1,status:'delivering'}],new Set([1]));assert.equal(map.get(1).status,'delivering');
 assert.equal(retainSelectedOrders(map,[{id:1}],new Set()).size,0);
});

test('official and system bindings both wait for handover; only physical dispatch becomes shipped and platform transport wins',()=>{
 const order={id:1,shop_id:20,status:'awaiting_deliver',logistics_carrier:'ogl'};
 const member={order_id:1,active_order_id:1,batch_id:7,default_shop_id:20,official_carriage_id:'901',batch_status:'preparing',official_status:'observed',official_member:1};
 for(const official of [1,0]){
  const bound=withOglDispatch(order,{...member,official_member:official});
  assert.equal(bound.display_status,'ogl_bound');assert.equal(orderStateKey(bound),'ogl_bound');
  assert.equal(bound.ogl_dispatch.dispatched,false);assert.equal(bound.ogl_dispatch.association_label,official?'Ozon':'系统');
  const handed=withOglDispatch(order,{...member,official_member:official,dispatched_at:'2026-10-31 01:00:00'});
  assert.equal(handed.display_status,'ogl_dispatched');assert.equal(handed.ogl_dispatch.dispatched,true);
  for(const [status,expected]of [['posting_in_transit','delivering'],['delivered','delivered'],['cancelled','cancelled']]){
   const live=withOglDispatch({...order,status},{...member,official_member:official});assert.equal(orderStateKey(live),expected);
  }
 }
 assert.equal(withOglDispatch(order,{...member,withdrawn_at:'now'}).display_status,undefined);
 assert.equal(withOglDispatch(order,{...member,official_carriage_id:null}).display_status,undefined);
 assert.match(oglBoundStatusSql('o','evidence'),/COALESCE/);
 assert.match(oglDispatchedStatusSql('o','evidence'),/physical_dispatch/);
 assert.match(oglPhysicalDispatchSql(),/dispatched_at IS NOT NULL/,'binding never becomes inventory-consumption evidence');
});

test('review proof changes when either a manual mark or note changes',()=>{
 const original={mark_type:'manual_check',mark_note:'仓库已检查'};
 assert.equal(oglOrderReviewSignature(original),oglOrderReviewSignature({...original}));
 assert.notEqual(oglOrderReviewSignature(original),oglOrderReviewSignature({...original,mark_note:'暂缓发货'}));
 assert.notEqual(oglOrderReviewSignature(original),oglOrderReviewSignature({...original,mark_type:'missing'}));
});

test('Ozon validation diagnostics retain safe field names and mapped codes, never remote secrets or contacts',async()=>{
 const client=createOglCarriageClient({fetchImpl:async()=>new Response(JSON.stringify({code:'INVALID_ARGUMENT',message:'departure_date invalid; Api-Key=private-secret; phone=13800000000; posting PRIVATE-POSTING',details:[{field:'delivery_method_id'}]}),{status:400})});
 await assert.rejects(client.request({ozon_client_id:'real-client',ozon_api_key:'real-key'},'/v1/carriage/create',{}),e=>{
  assert.match(e.message,/departure_date/);assert.match(e.message,/delivery_method_id/);assert.match(e.message,/\/v1\/carriage\/create/);
  assert.doesNotMatch(e.message,/private-secret|13800000000|PRIVATE-POSTING|real-key/);assert.equal(e.remoteCode,'INVALID_ARGUMENT');assert.equal(e.unknown,false);return true;
 });
});
