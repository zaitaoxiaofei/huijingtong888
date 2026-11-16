import assert from "node:assert/strict";
import test from "node:test";
import { buildBillingGroups, billingExpenseGroup } from "../frontend/admin/views/profit/billing-groups.js";

test("six outgoing groups conserve every expense once and expose individual amounts", () => {
  const expenses = [ ["ai_subscription",700], ["salary",5000], ["team_building",200], ["temporary_labor",150], ["travel",30], ["subsidy",100], ["rent",2000], ["bank",2], ["withdrawal",3], ["currency_exchange",4], ["legacy_misc",6] ].map(([category, amount_cny]) => ({ category, amount_cny }));
  const summary = { revenue:10000, purchase_cost:120, domestic_shipping_cost:12, international_shipping_cost:23, commission_fee:5, ozon_service_fee:3, advertising_cost:7, other_fee:1, packaging_cost:2, return_loss:999, ai_cost:999 };
  const groups=buildBillingGroups(summary,expenses), byKey=Object.fromEntries(groups.map(g=>[g.key,g]));
  assert.equal(groups.length,7);
  assert.equal(byKey.income.amount,10000);
  assert.equal(byKey.income.children.find(x=>x.key==='platform_rewards').amount,null);
  assert.equal(byKey.goods.amount,120);
  assert.equal(byKey.logistics.amount,35);
  assert.equal(byKey.platform.amount,16);
  assert.equal(byKey.operating.amount,2708);
  assert.equal(byKey.personnel.amount,5480);
  assert.equal(byKey.funds.amount,9);
  assert.equal(groups.slice(1).reduce((sum,g)=>sum+g.amount,0),8368);
  assert.equal(byKey.personnel.children.find(x=>x.key==='team_building').amount,200);
  assert.equal(byKey.operating.children.find(x=>x.key==='legacy_misc').amount,6);
  assert.ok(!groups.some(g=>g.children.some(x=>x.key==='return_loss')));
  assert.equal(billingExpenseGroup('temporary_labor'),'personnel');
});

test("manual records keep cents exact and unknown categories stay visible", () => {
  const result=buildBillingGroups({},[{category:null,amount_cny:0.1},{category:'other',amount_cny:0.2}]);
  assert.equal(result.find(g=>g.key==='operating').children.find(x=>x.key==='other').amount,0.3);
});

test("source-record access follows monthly billing authority and finance plan gates", async () => {
  const { authorizeApiRequest } = await import('../src/server/authorization.js');
  const { subscriptionApiFeature } = await import('../src/shared/subscription-plan-features.js');
  const { isTenantPilotRoute } = await import('../src/server/tenant-pilot-routes.js');
  const parts=['api','monthly-billing-source-records'];
  const session={personId:1,roles:['operator'],tenant:{id:2,slug:'a',role:'owner',plan_code:'monthly_team',subscription_status:'active'}};
  assert.equal(authorizeApiRequest({_session:session,method:'GET'},parts).allowed,true);
  assert.equal(authorizeApiRequest({_session:{...session,tenant:{...session.tenant,role:'member'}},method:'GET'},parts).allowed,false);
  assert.equal(authorizeApiRequest({_session:{...session,tenant:{...session.tenant,subscription_status:'trial'}},method:'GET'},parts).allowed,false);
  assert.equal(authorizeApiRequest({_session:session,method:'POST'},parts).allowed,false);
  assert.equal(subscriptionApiFeature(parts),'finance');
  assert.equal(isTenantPilotRoute('monthly-billing-source-records','GET'),true);
  assert.equal(isTenantPilotRoute('monthly-billing-source-records','POST'),false);
});
