import test from 'node:test';
import assert from 'node:assert/strict';
import {procurementArrivalStage} from '../src/shared/inventory-procurement-stage.js';
test('arrival deadlines are reminders, never stock confirmation',()=>{
 const now=Date.parse('2026-10-30T08:00:00Z');
 const row=h=>({status:'pending_arrival',purchased_at:new Date(now-h*3600000).toISOString()});
 assert.equal(procurementArrivalStage(row(48),now).overdue,false);
 assert.equal(procurementArrivalStage(row(48.1),now).overdue,true);
 assert.equal(procurementArrivalStage(row(71.9),now).awaiting_inspection,false);
 const due=procurementArrivalStage(row(72),now);assert.equal(due.awaiting_inspection,true);assert.equal(due.label,'待验收 · 到货待确认');
 const actual=procurementArrivalStage({...row(1),received_at:new Date(now).toISOString()},now);assert.equal(actual.awaiting_inspection,true);assert.equal(actual.overdue,false);
 assert.equal(procurementArrivalStage({...row(100),status:'approved'},now).label,'已入库');
 assert.equal(procurementArrivalStage({status:'pending_arrival'},now).overdue,false);
 assert.equal(row(100).status,'pending_arrival');
});

import {authorizeApiRequest} from '../src/server/authorization.js';
import {tenantIsolationDecision} from '../src/server/tenant-isolation.js';
import {validateFlowSettings} from '../src/services/inventory-flow-rules.js';
test('node APIs remain exact-gated and production rules allow one day',()=>{
 const session=role=>({personId:2,roles:[role],tenant:{id:2,slug:'a',role:'member'}});
 for(const [verb,suffix] of [['GET','details'],['POST','node-action']]){
  const parts=['api','inventory-workflow',suffix];
  assert.equal(tenantIsolationDecision(session('packing'),parts,verb).allowed,true);
  assert.equal(authorizeApiRequest({method:verb,_session:session('packing')},parts).allowed,true);
 }
 assert.equal(authorizeApiRequest({method:'POST',_session:session('analytics')},['api','inventory-workflow','node-action']).allowed,false);
 assert.equal(tenantIsolationDecision(session('packing'),['api','inventory-workflow','unknown'],'POST').allowed,false);
 assert.equal(validateFlowSettings({production_days:1}).production_days,1);
 assert.throws(()=>validateFlowSettings({production_days:0}),/至少1天/);
});
test('editing cycle rules rechecks the current business duty',async()=>{
 const {createInventoryFlowRoutes}=await import('../src/server/routes/inventoryFlow.js');
 const session={personId:2,roles:['packing'],tenant:{id:2,slug:'a',role:'member'}};
 let fresh=session,calls=0;
 const routes=createInventoryFlowRoutes({readJson:async()=>({product_id:200}),authorize:async()=>fresh,
   flow:{saveSettings:async()=>{calls++;return {ok:true};}}});
 await assert.rejects(routes['POST /api/inventory-flow/settings']({_session:session}),{statusCode:403});
 fresh={...session,roles:['operations']};
 await routes['POST /api/inventory-flow/settings']({_session:session});assert.equal(calls,1);
});
