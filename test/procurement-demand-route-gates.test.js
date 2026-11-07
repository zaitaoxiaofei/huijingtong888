import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeApiRequest} from '../src/server/authorization.js';
import {tenantIsolationDecision} from '../src/server/tenant-isolation.js';

const routes=[
 ['GET','demand-details',['packing','procurement','operations']],
 ['GET','purchase-arrivals',['packing','procurement','operations']],
 ['POST','local-safety',['procurement','operations']],
 ['POST','purchase-arrivals',['procurement']],
 ['POST','cancel-demand',['procurement']],
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

test('demand cancellation and restoration admit only the reviewed POST route with procurement duty',()=>{
 const parts=['api','inventory-workflow','cancel-demand'];
 for(const tenant of [{id:1,slug:'default',role:'member'},{id:42,slug:'customer',role:'member'}]){
  const session={person_id:123,roles:['procurement'],tenant};
  for(const method of ['GET','HEAD','PUT','PATCH','DELETE']){
   assert.equal(tenantIsolationDecision(session,parts,method).allowed,false,`${tenant.slug} ${method}`);
   assert.equal(authorizeApiRequest({method,_session:session},parts).allowed,false,`${tenant.slug} ${method}`);
  }
  for(const path of ['cancel-demand/restore','cancel-demand-extra','cancel-demand/123','cancel-demand/']){
   const candidate=['api','inventory-workflow',...path.split('/')];
   assert.equal(tenantIsolationDecision(session,candidate,'POST').allowed,false,`${tenant.slug} ${path}`);
   assert.equal(authorizeApiRequest({method:'POST',_session:session},candidate).allowed,false,`${tenant.slug} ${path}`);
  }
  const mixed={...session,roles:['packing','procurement']};
  assert.equal(tenantIsolationDecision(mixed,parts,'POST').allowed,true);
  assert.equal(authorizeApiRequest({method:'POST',_session:mixed},parts).allowed,true);
 }
 for(const tenant of [null,{id:42},{slug:'customer'}]){
  assert.equal(tenantIsolationDecision({person_id:123,roles:['procurement'],tenant},parts,'POST').allowed,false);
 }
 assert.equal(authorizeApiRequest({method:'POST'},parts).allowed,false);
});
