import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { canAccessPage } from '../src/shared/permissions.js';

const paths=['monthly-billing-details','monthly-billing-orders','payroll/setup','payroll/period'];
function decision(session,path,method='GET') {
 const parts=['api',...path.split('/')];const req={method,_session:session};
 return {auth:authorizeApiRequest(req,parts),isolation:tenantIsolationDecision(session,parts,method)};
}
test('enterprise finance read access agrees at menu, authorization and isolation gates',()=>{
 for(const [id,slug] of [[1,'default'],[2,'a'],[3,'b']]) for(const role of ['owner','admin']){
  const session={personId:6,roles:['operations'],tenant:{id,slug,role}};
  for(const path of paths){const result=decision(session,path);assert.equal(result.auth.allowed,true,`${slug}/${role}/${path} auth`);assert.equal(result.isolation.allowed,true,`${slug}/${role}/${path} isolation`);}
  for(const page of ['/finance-center','/finance/payroll','/profit/monthly-billing','/profit/monthly-billing/orders','/profit/aftersales'])assert.equal(canAccessPage(session,page),true,page);
 }
});
test('ordinary operations staff and global legacy role labels do not grant private finance access',()=>{
 for(const roles of [['operations'],['admin'],['manager','operations']]){
  const session={personId:8,roles,tenant:{id:1,slug:'default',role:'member'}};
  for(const path of paths)assert.equal(decision(session,path).auth.allowed,false,path);
  for(const page of ['/finance/payroll','/profit/monthly-billing'])assert.equal(canAccessPage(session,page),false,page);
 }
});
test('read openings do not authorize payroll writes, financial repairs or guessed subpaths',()=>{
 const session={personId:6,roles:['operations'],tenant:{id:2,slug:'a',role:'owner'}};
 for(const path of paths)for(const method of ['POST','PUT','DELETE'])assert.equal(decision(session,path,method).auth.allowed,false,`${method} ${path}`);
 for(const path of ['payroll/setup/extra','payroll/period/1','monthly-billing-details/export','monthly-billing-orders/1','profits/recalculate-historical'])assert.equal(decision(session,path).auth.allowed,false,path);
 assert.equal(decision(session,'profit-snapshots/refresh','POST').auth.allowed,false);
 for(const page of ['/settings','/platform-accounts','/profit/reconciliation'])assert.equal(canAccessPage(session,page),false,page);
});
