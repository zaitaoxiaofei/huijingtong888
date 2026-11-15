import test from 'node:test';
import assert from 'node:assert/strict';
import {financePeriods,financeMatrix,financeSourceShops} from '../src/shared/company-finance-report.js';
import {financeOriginalName} from '../src/services/finance-original-name.js';
const line=(month,metric,amount,shop_id=1,currency='CNY')=>({month,metric,amount,shop_id,currency});
test('monthly 12, quarterly 4, annual 1 include correct boundaries and do not confuse missing with zero',()=>{
 const lines=[line('2026-01','已确认商品销售额',100),line('2026-03','销售退回冲减额',20),line('2026-04','佣金',3),line('2026-10','佣金',0),line('2026-12','已确认商品销售额',40),line('2027-01','佣金',999),line('2026-04','佣金',999,1,'RUB')];
 for(const [mode,count]of [['month',12],['quarter',4],['year',1]]){
  const m=financeMatrix(lines,'2026',mode);assert.equal(m.periods.length,count);
  const income=m.rows.find(r=>r.id==='income');assert.equal(Object.values(income.cells).reduce((n,v)=>n+(v||0),0),120);
  assert.equal(Object.values(m.rows.find(r=>r.id==='platform').cells).reduce((n,v)=>n+(v||0),0),3);
 }
 const m=financeMatrix(lines,'2026','month');assert.equal(m.rows[2].cells['2026-10'],0);assert.equal(m.rows[2].cells['2026-11'],null);
 const q=financeMatrix(lines,'2026','quarter');assert.equal(q.rows[0].cells['2026-Q1'],80);assert.equal(q.rows[0].cells['2026-Q4'],40);assert.equal(q.rows[0].cells['2026-Q2'],null);
 assert.throws(()=>financePeriods('2026','bad'));assert.throws(()=>financePeriods('bad','month'));
});
test('shared costs appear once at company scope and purchased inventory is separate from sold goods costs',()=>{
 const lines=[line('2026-10','AI使用费',10,0),line('2026-10','商品采购支出',150),line('2026-10','已售商品采购成本',100),line('2026-10','设备采购支出',500)];
 const m=financeMatrix(lines,'2026','year');assert.equal(m.rows.find(r=>r.id==='software').cells['2026'],10);assert.equal(m.rows.find(r=>r.id==='goods').cells['2026'],100);assert.equal(m.rows.find(r=>r.id==='assets').cells['2026'],650);assert.equal(m.rows.find(r=>r.id==='assets').sign,0);
 assert.deepEqual(financeSourceShops(lines,[{id:1,name:'Z店'},{id:2,name:'C店'}]).map(s=>[s.name,s.lines.length]),[['公司共用',1],['Z店',3],['C店',0]]);
});
test('Cyrillic original names retain spaces and Unicode while path components and controls are removed',()=>{
 assert.equal(financeOriginalName('C:\\Downloads\\Счёт-фактура № 123.pdf'),'Счёт-фактура № 123.pdf');
 assert.equal(financeOriginalName('../Акт услуг\r\n.xlsx'),'Акт услуг.xlsx');
 assert.throws(()=>financeOriginalName('..'));assert.throws(()=>financeOriginalName('я'.repeat(256)+'.pdf'));
});
