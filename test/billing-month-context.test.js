import test from 'node:test';
import assert from 'node:assert/strict';
import {billingDateRange} from '../frontend/admin/utils/billing-period.js';
import {canAccessPage} from '../src/shared/permissions.js';
import {authorizeApiRequest} from '../src/server/authorization.js';
import {payrollTemplate,readWorkbook,parsePayroll} from '../src/services/finance-workbooks.js';
test('billing routes resolve historical months, leap years and current partial month',()=>{
 const today='2026-11-01';
 assert.deepEqual(billingDateRange({year:2026,month:1},today),['2026-01-01','2026-01-31']);
 assert.deepEqual(billingDateRange({year:2026,month:2},today),['2026-02-01','2026-02-28']);
 assert.deepEqual(billingDateRange({year:2024,month:2},today),['2024-02-01','2024-02-29']);
 assert.deepEqual(billingDateRange({year:2026,month:11},today),['2026-11-01','2026-11-01']);
 assert.deepEqual(billingDateRange({from:'2026-03-01',to:'2026-04-01',month:11},today),['2026-03-01','2026-04-01']);
 assert.deepEqual(billingDateRange({from:'2026-02-30',to:'2026-03-31',year:2026,month:2},today),['2026-02-01','2026-02-28']);
});
test('inventory capital costs remain enterprise-admin-only on desktop, mobile and API',()=>{
 const admin={roles:['operations'],tenant:{id:2,slug:'a',role:'admin'}},member={roles:['admin'],tenant:{id:2,slug:'a',role:'member'}};
 for(const path of ['/finance/inventory-capital','/mobile/inventory-capital']){assert.equal(canAccessPage(admin,path),true);assert.equal(canAccessPage(member,path),false);}
 const parts=['api','finance-center','inventory-capital-details'];
 assert.equal(authorizeApiRequest({method:'GET',_session:admin},parts).allowed,true);
 assert.equal(authorizeApiRequest({method:'GET',_session:member},parts).allowed,false);
 assert.equal(authorizeApiRequest({method:'POST',_session:admin},parts).allowed,false);
});
test('historical payroll template retains requested company and January cost date',async()=>{
 const companies=[{id:2,name:'历史工资测试公司'}];
 const book=await readWorkbook(await payrollTemplate({companies,month:'2026-01'}));
 const sheet=book.getWorksheet('工资表');assert.equal(sheet.getCell('A3').value,'公司名称：历史工资测试公司');
 assert.equal(sheet.getCell('L3').value,'2026年');assert.equal(sheet.getCell('M3').value,'1月');
 sheet.getRow(6).values=[1,'部门','测试甲',1000,100,0,0,0,0,0,100,50,0,0,0,50,0,950];
 const [row]=await parsePayroll(Buffer.from(await book.xlsx.writeBuffer()),{companies});
 assert.equal(row.month,'2026-01');assert.equal(row.expense_date,'2026-01-31');assert.equal(row.amount,1100);
});
