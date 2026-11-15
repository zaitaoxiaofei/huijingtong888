import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizePayrollEntry,PAYROLL_EMPLOYER_FIELDS,PAYROLL_EMPLOYEE_FIELDS} from '../src/shared/payroll-entry.js';
import {financeSubmissionRoute} from '../src/shared/finance-submissions.js';
import {authorizeApiRequest} from '../src/server/authorization.js';
const parts=fields=>Object.fromEntries(fields.map(([key])=>[key,0]));
const data=()=>({month:'2026-02',person_name:'员工甲',base:5500,tax:20,employer_items:{...parts(PAYROLL_EMPLOYER_FIELDS),pension:1000,medical:600},employee_items:{...parts(PAYROLL_EMPLOYEE_FIELDS),pension:400,medical:100}});
test('manual wages preserve company cost, deductions, cents and actual calendar month',()=>{
 const row=normalizePayrollEntry(data());assert.equal(row.net,4980);assert.equal(row.amount,7100);assert.equal(row.employer,1600);assert.equal(row.employee,500);assert.equal(row.expense_date,'2026-02-28');
 assert.equal(normalizePayrollEntry({...data(),month:'2028-02'}).expense_date,'2028-02-29');
 assert.equal(normalizePayrollEntry({...data(),employer_items:null,employee_items:null,employer:123.45,employee:23.45}).net,5456.55);
 assert.equal(normalizePayrollEntry({...data(),employer_items:null,employee_items:null,employer:123.45,employee:23.45}).amount,5623.45);
});
test('invalid identity, unknown contribution parts and negative net wages cannot save',()=>{
 for(const extra of [{month:'2026-13'},{person_name:''},{base:null},{base:true},{base:[]},{tax:-1},{employee_items:{pension:1}},{base:1},{employer_items:[]}])assert.throws(()=>normalizePayrollEntry({...data(),...extra}),{statusCode:400});
});
test('only finance reviewers use exact manual-entry and batch-payment routes',()=>{
 const session={personId:1,roles:['operations'],tenant:{id:2,slug:'a',role:'owner',plan_code:'monthly_team'}};
 for(const action of ['payroll-item','payroll-paid-batch']){
  const path=['api','finance-submissions',action];assert.equal(financeSubmissionRoute(path,'POST'),'reviewer');assert.equal(financeSubmissionRoute(path,'GET'),null);
  assert.equal(authorizeApiRequest({_session:session,method:'POST'},path).allowed,true);
  assert.equal(authorizeApiRequest({_session:{...session,tenant:{...session.tenant,role:'member'}},method:'POST'},path).allowed,false);
  assert.equal(authorizeApiRequest({_session:{...session,tenant:{...session.tenant,subscription_status:'trial'}},method:'POST'},path).allowed,false);
 }
});
