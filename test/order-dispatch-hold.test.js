import assert from 'node:assert/strict';
import test from 'node:test';
import {orderHasDispatchHold} from '../src/shared/order-dispatch-hold.js';
import {orderStateKey} from '../frontend/orders/constants/orders-ui.js';
import {withOglDispatch} from '../src/services/ogl-dispatch-state.js';
import {oglTransportDeadlineHint} from '../frontend/orders/utils/ogl-transport-deadline.js';

const order={id:1,shop_id:20,status:'awaiting_deliver',logistics_carrier:'ogl',ordered_at:'2026-11-01T00:00:00Z',printed_at:'2026-11-01T01:00:00Z'};
const member={batch_id:1,official_carriage_id:'901',official_member:1,default_shop_id:20,official_status:'observed',batch_status:'preparing'};
test('every manual mark holds unfinished orders, including printed bound orders, until no mark is selected',()=>{
 for(const mark_type of ['quality','urgent','follow','issue','solved','vip','special','other']){
  const marked=withOglDispatch({...order,mark_type},member);
  assert.equal(marked.display_status,'awaiting_deliver',mark_type);assert.equal(orderStateKey(marked),'awaiting_deliver');
  assert.equal(marked.ogl_dispatch.stage,'held');assert.equal(marked.ogl_dispatch.awaiting_print,false);assert.equal(marked.ogl_dispatch.bound,true);
  assert.match(oglTransportDeadlineHint(marked,Date.parse(order.ordered_at)),/剩余/);
  const cleared=withOglDispatch({...order,mark_type:'',mark_note:'保留备注'},member);
  assert.equal(orderStateKey(cleared),'ogl_bound');assert.equal(orderHasDispatchHold(cleared),false);
 }
 for(const status of ['awaiting_packaging','awaiting_deliver','posting_registered','sent_by_seller']){
  const marked={...order,status,mark_type:'follow'};assert.equal(orderStateKey(marked),'awaiting_deliver');
  assert.equal(withOglDispatch(marked,null).display_status,'awaiting_deliver');
 }
 assert.equal(orderHasDispatchHold({...order,mark_type:' ',mark_note:'备注不是标记'}),false);
});
test('manual marks never demote actual physical dispatch, transport or terminal evidence',()=>{
 const marked={...order,mark_type:'issue'};
 for(const status of ['delivering','posting_in_transit','delivered','cancelled','returned_to_seller','arbitration','posting_received_by_buyer','posting_driver_pick_up','shipped']){
  assert.equal(orderHasDispatchHold({...marked,status}),false,status);
  assert.notEqual(orderStateKey(withOglDispatch({...marked,status},member)),'awaiting_deliver',status);
 }
 const physical=withOglDispatch(marked,{...member,dispatched_at:'2026-11-01T02:00:00Z'});
 assert.equal(orderHasDispatchHold(physical),false);assert.equal(orderStateKey(physical),'ogl_dispatched');
 assert.equal(orderHasDispatchHold({...marked,delivered_at:'2026-11-01T02:00:00Z'}),false);
});
