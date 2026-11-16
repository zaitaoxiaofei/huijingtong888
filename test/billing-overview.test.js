import test from 'node:test';import assert from 'node:assert/strict';
import {overviewAmounts,sumOverviewAmounts} from '../frontend/admin/views/profit/billing-overview.js';
test('annual and monthly cards preserve profits, recorded corrections and unknown AI allocation',()=>{
 const summary={revenue:100,order_profit:60,net_profit:40,manual_expense:10,salary_expense:10,return_loss:50};
 const m=overviewAmounts(summary,{cost:.038});assert.equal(m.recorded_expenses,20);assert.equal(m.net_profit,40);assert.equal(m.ai_cost,.038);
 assert.equal(overviewAmounts(summary,{cost:4},{companyId:'2',shopId:'all'}).ai_cost,null);
 assert.equal(overviewAmounts(summary,{cost:4},{companyId:'all',shopId:'7'}).ai_cost,null);
 assert.equal(overviewAmounts(summary,{available:false,cost:0}).ai_cost,null);
 assert.equal(overviewAmounts(summary,{}).ai_cost,null);
 assert.equal(overviewAmounts(summary,{cost:0}).ai_cost,0);
 const annual=sumOverviewAmounts([m,overviewAmounts({...summary,net_profit:-1},{cost:.076})]);assert.equal(annual.net_profit,39);assert.equal(annual.recorded_expenses,40);assert.equal(annual.ai_cost,.114);
 assert.equal(sumOverviewAmounts([m,overviewAmounts(summary,{available:false})]).ai_cost,null);
});
