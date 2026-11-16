import test from 'node:test';
import assert from 'node:assert/strict';
import {billingProfitTotals} from '../src/shared/billing-profit.js';
import {buildBillingGroups} from '../frontend/admin/views/profit/billing-groups.js';
test('report profits subtract every recorded cost once and keep company overhead separate',()=>{
 const summary={revenue:1000,purchase_cost:100,domestic_shipping_cost:10,international_shipping_cost:20,packaging_cost:5,commission_fee:30,ozon_service_fee:2,advertising_cost:8,other_fee:1,profit:999,operating_profit:999,return_loss:888};
 const expenses=[{category:'rent',amount_cny:100},{category:'salary',amount_cny:200},{category:'ai_subscription',amount_cny:7},{category:'domestic_shipping',amount_cny:3},{category:'packaging',amount_cny:-2}];
 const totals=billingProfitTotals(summary,expenses);assert.equal(totals.order_profit,823);assert.equal(totals.net_profit,516);assert.equal(totals.net_profit_margin,.516);
 const groups=buildBillingGroups(summary,expenses);assert.equal(1000-groups.slice(1).reduce((n,g)=>n+g.amount,0),totals.net_profit);
 assert.equal(groups.find(g=>g.key==='logistics').children.find(c=>c.key==='domestic_shipping_cost').amount,13);
 assert.equal(groups.find(g=>g.key==='operating').children.filter(c=>c.key==='packaging').length,0);
 assert.equal(billingProfitTotals({...summary,manual_expense:108,salary_expense:200,order_expense:1}).net_profit,516);
});
test('profits use integer cents, allow losses and do not silently deduct unbooked wages or estimated AI usage',()=>{
 const result=billingProfitTotals({revenue:.3,purchase_cost:.1,packaging_cost:.2,ai_cost:100,unapproved_salary:100},[{category:'rent',amount_cny:.01}]);assert.equal(result.order_profit,0);assert.equal(result.net_profit,-.01);
});
