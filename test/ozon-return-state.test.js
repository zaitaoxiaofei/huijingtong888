import test from 'node:test';
import assert from 'node:assert/strict';
import {ozonReturnState,summarizeOzonReturns,ozonReturnFilterSql} from '../src/services/ozon-return-state.js';
test('refund, physical destruction and partial compensation stay distinct',()=>{
  const refund=ozonReturnState({state:{state:'MoneyReturned'}});
  assert.equal(refund.refund,'returned');assert.equal(refund.goods,'unknown');
  assert.equal(ozonReturnState({state:{state:'UtilizedByOzon'}}).goods,'disposed');
  assert.equal(ozonReturnState({state:{state:'UtilizingByOzon'}}).goods,'disposing');
  assert.equal(ozonReturnState({state:{state:'PartialCompensationReturnedByOzon'}}).refund,'partial');
});
test('cancelled requests and answered claims are not automatically returns',()=>{
  for(const state of ['Solved','Cancelled'])assert.equal(ozonReturnState({state:{state}}).rank,0);
  assert.equal(ozonReturnState({state:{state:'OnSellerClarification'}}).needs_review,true);
  assert.equal(ozonReturnState({state:{state:'UnexpectedNewState'}}).status,'possible_return');
});
test('multiple applications preserve refund proof even if a later request is cancelled',()=>{
  const result=summarizeOzonReturns([{return_id:1,state:{state:'MoneyReturned'},created_at:'2026-01-01'},
    {return_id:2,state:{state:'Cancelled'},created_at:'2026-02-01'}]);
  assert.equal(result.status,'refunded');assert.equal(result.refund_confirmed,true);
  assert.equal(result.refund_completed_at,null);assert.deepEqual(result.return_ids,['1','2']);
  assert.equal(summarizeOzonReturns([]),null);
});

test('official disposal aliases, return transit and platform checks are recognized without manual confirmation',()=>{
  for(const state of ['Utilized','UtilizedByOzon']){
    const r=ozonReturnState({state:{state}});assert.equal(r.status,'disposed');assert.equal(r.needs_review,false);assert.equal(r.action_owner,'none');
  }
  for(const state of ['Utilizing','UtilizingByOzon'])assert.equal(ozonReturnState({state:{state}}).status,'disposing');
  assert.equal(ozonReturnState({state:{state:'OnWay'}}).status,'return_in_transit');
  assert.equal(ozonReturnState({state:{state:'ReceivedBySeller'}}).status,'return_received');
  const platform=ozonReturnState({state:{state:'CheckingStatus'}});assert.equal(platform.group,'platform_processing');assert.equal(platform.needs_review,false);
});
test('only actual seller actions become user tasks; unknown states are system mapping work',()=>{
  const seller=summarizeOzonReturns([{return_id:1,state:{state:'OnSellerClarification'}}]);
  assert.equal(seller.requires_user_action,true);assert.equal(seller.system_review,false);assert.equal(seller.status,'seller_action_required');
  const unknown=summarizeOzonReturns([{return_id:1,state:{state:'FutureOfficialState'}}]);
  assert.equal(unknown.requires_user_action,false);assert.equal(unknown.system_review,true);assert.equal(unknown.label,'售后状态待识别');
});
test('a separate open application stays actionable even when another application was refunded',()=>{
 const r=summarizeOzonReturns([{return_id:1,state:{state:'MoneyReturned'}},{return_id:2,state:{state:'OnSellerApproval'}}]);
 assert.equal(r.refund_confirmed,true);assert.equal(r.requires_user_action,true);assert.equal(r.observations.length,2);
});

test("seller task filter includes pickup as well as seller clarification",()=>{
 const sql=ozonReturnFilterSql({id:1},"aftersale","o","seller_action");
 assert.match(sql,/ArrivedAtReturnPlace/);assert.match(sql,/OnSellerClarification/);
});
