import test from 'node:test';import assert from 'node:assert/strict';
import {recordedExpenseLines}from '../src/services/finance-recorded-expenses.js';
import {financeMatrix}from '../src/shared/company-finance-report.js';
const row=(id,category,amount,extra={})=>({id,category,amount_cny:amount,month_key:'2026-10',description:'原费用说明',...extra});
test('registered expenses preserve zero, signed corrections, estimates and unknown categories without guessing currency conversions',()=>{
 const lines=recordedExpenseLines([row(1,'software',700,{source_type:'user_cost_default',shop_id:2}),row(2,'ai_tokens',0),row(3,'rent',-100),row(4,'custom',55),row(5,'salary',9000)]);
 assert.deepEqual(lines.map(l=>l.amount),[700,0,-100,55]);assert.equal(lines[0].shop_id,2);assert.equal(lines[0].amount_status,'estimated');assert.equal(lines[0].source.includes('原费用说明'),true);assert.equal(lines[3].metric,'登记费用：custom');assert.equal(lines[0].month,'2026-10');
 for(const value of [null,'',NaN,Infinity])assert.throws(()=>recordedExpenseLines([row(1,'software',value)]),/人民币金额/);
 assert.throws(()=>recordedExpenseLines([row(1,'software',10),row(1,'software',10)]),/重复/);
});
test('voucher attachments provide evidence without increasing monetary rows; payroll-only documents remain separate',()=>{
 const lines=recordedExpenseLines([row(1,'software',700),row(2,'internet',100)], [{id:3,expense_id:1,attachment_url:'/uploads/team-attachments/a.pdf'},{id:4,expense_id:1,attachment_url:'/uploads/team-attachments/b.pdf'},{id:5,expense_id:2,attachment_url:null}]);
 assert.equal(lines.length,2);assert.equal(lines[0].linked_evidence.length,2);assert.equal(lines[1].linked_evidence.length,0);
 for(const [mode,count]of [['month',12],['quarter',4],['year',1]]){const m=financeMatrix(lines,'2026',mode);assert.equal(m.periods.length,count);assert.equal(Object.values(m.rows.find(x=>x.id==='software').cells).reduce((a,b)=>a+(b||0),0),700);assert.equal(Object.values(m.rows.find(x=>x.id==='premises').cells).reduce((a,b)=>a+(b||0),0),100);}
});
