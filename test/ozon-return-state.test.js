import test from 'node:test';
import assert from 'node:assert/strict';
import {ozonReturnState,summarizeOzonReturns} from '../src/services/ozon-return-state.js';
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
