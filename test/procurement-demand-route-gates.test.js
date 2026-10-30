import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeApiRequest} from '../src/server/authorization.js';
import {tenantIsolationDecision} from '../src/server/tenant-isolation.js';

const routes=[
 ['GET','demand-details',['packing','procurement','operations']],
 ['GET','purchase-arrivals',['packing','procurement','operations']],
 ['POST','local-safety',['procurement','operations']],
 ['POST','purchase-arrivals',['procurement']],
 ['POST','demand-request',['packing','procurement','operations']]
];
test('procurement detail routes preserve exact tenant gates and business duties in both enterprises',()=>{
 for(const tenant of [{id:1,slug:'default',role:'member'},{id:42,slug:'customer',role:'member'}]){
  for(const [method,action,allowed] of routes){
   const parts=['api','inventory-workflow',action];
   for(const role of ['packing','procurement','operations','technical']){
    const session={person_id:123,roles:[role],tenant};
    assert.equal(tenantIsolationDecision(session,parts,method).allowed,true);
    assert.equal(authorizeApiRequest({method,_session:session},parts).allowed,allowed.includes(role),`${tenant.slug} ${role} ${method} ${action}`);
   }
   assert.equal(tenantIsolationDecision({person_id:123,roles:['procurement']},parts,method).allowed,false);
   assert.equal(tenantIsolationDecision({person_id:123,roles:['procurement'],tenant},[...parts,'unreviewed'],method).allowed,false);
   assert.equal(tenantIsolationDecision({person_id:123,roles:['procurement'],tenant},parts,'DELETE').allowed,false);
  }
 }
});
