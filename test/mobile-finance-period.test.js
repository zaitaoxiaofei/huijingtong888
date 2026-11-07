import test from 'node:test';
import assert from 'node:assert/strict';
import {validMobileDate,previousMobileDate,validMobileMonth,mobileMonthRange,mobileMonthQuery,mobileAnnualTotals,mobileMoney,mobileInteger,mobileRatio} from '../frontend/admin/utils/mobile-finance-period.js';

test('mobile periods use calendar days across years and leap February without local timezone arithmetic',()=>{
  assert.equal(previousMobileDate('2026-01-01'),'2025-12-31');
  assert.equal(previousMobileDate('2024-03-01'),'2024-02-29');
  assert.equal(previousMobileDate('2025-03-01'),'2025-02-28');
  assert.equal(validMobileDate('2024-02-29','2026-11-06'),true);
  for(const day of ['2025-02-29','2026-11-07','2026-13-01','2026-2-01',''])assert.equal(validMobileDate(day,'2026-11-06'),false,day);
  assert.equal(validMobileMonth('2024-02','2026-11-06'),true);
  for(const month of ['2026-12','2026-00','2026-13','2026-2','2019-12'])assert.equal(validMobileMonth(month,'2026-11-06'),false,month);
  assert.deepEqual(mobileMonthRange('2024-02','2026-11-06'),['2024-02-01','2024-02-29']);
  assert.deepEqual(mobileMonthRange('2026-11','2026-11-06'),['2026-11-01','2026-11-06']);
});
test('a historical month keeps its company/shop and overview-year context',()=>{
  assert.deepEqual(mobileMonthQuery('2024-02','2026-11-06',{companyId:'8',shopId:'12',overviewYear:'2025'}),{month:'2024-02',from:'2024-02-01',to:'2024-02-29',companyId:'8',shopId:'12',overviewYear:'2025'});
});
test('annual presentation preserves real zero/expenses but never turns missing months or fields into zero',()=>{
  const zero={month_key:'2026-01',summary:{revenue:0,net_profit:-100,manual_expense:0,salary_expense:100}};
  const totals=mobileAnnualTotals([zero],['2026-01']);assert.equal(totals.revenue,0);assert.equal(totals.net_profit,-100);assert.equal(totals.expenses,100);
  assert.equal(mobileAnnualTotals([zero],['2026-01','2026-02']).revenue,null);
  assert.equal(mobileAnnualTotals([{month_key:'2026-01',summary:{revenue:0}}],['2026-01']).net_profit,null);
  assert.equal(mobileMoney(0),'¥ 0.00');assert.equal(mobileMoney(null),'—');assert.equal(mobileInteger(undefined),'—');assert.equal(mobileRatio(null),'—');assert.equal(mobileRatio(0),'0.0%');
});
