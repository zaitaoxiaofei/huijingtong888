import test from 'node:test';
import assert from 'node:assert/strict';
import { BETA_PLAN_PRICES_FEN, planFeatures, publicPlanDetails } from '../src/shared/subscription-plan-features.js';
import { DEFAULT_TENANT_PLAN_PRESETS } from '../src/services/tenant-plans.js';
import { canAccessPage } from '../src/shared/permissions.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { aiSkillsApiDecision, assertAiSkillsAvailable } from '../src/shared/ai-skills-access.js';
import { subscriptionAccessDecision } from '../src/server/subscription-access.js';
import { restoreBusinessTaskSession } from '../src/services/business-task-tenant.js';
const actor = code => ({ personId: 1, roles: ['admin'], tenant: { id: 20, slug: 'enterprise-a', role: 'owner', plan_code: code, subscription_status: code.startsWith('trial') ? 'trial' : 'active', access_allowed: true } });
test('six plans have the confirmed prices and quotas including the main account', () => {
  assert.deepEqual(Object.values(BETA_PLAN_PRICES_FEN), [990,1990,29900,39900,109900,899900]);
  const plans = DEFAULT_TENANT_PLAN_PRESETS.map(publicPlanDetails);
  assert.deepEqual(plans.map(x => [x.account_limit,x.shop_limit]), [[1,2],[1,2],[1,2],[3,10],[3,10],[3,10]]);
  assert.deepEqual(plans.map(x => x.price_fen), Object.values(BETA_PLAN_PRICES_FEN));
});
test('trial, basic and team gates agree on pages and actual APIs without blocking the home dashboard', () => {
  for (const code of Object.keys(BETA_PLAN_PRICES_FEN)) {
    const session = actor(code), features = planFeatures(session.tenant);
    for (const [path, feature, api] of [['/team-plan','tasks',['api','team','tasks']], ['/finance-center','finance',['api','finance-center','report']]]) {
      assert.equal(canAccessPage(session,path),features[feature],code+path);
      assert.equal(authorizeApiRequest({_session:session,method:'GET'},api).allowed,features[feature],code+api);
      assert.equal(subscriptionAccessDecision(session,api).allowed,features[feature]);
    }
    assert.equal(canAccessPage(session,'/product-workflows'),features.ai);
    assert.equal(aiSkillsApiDecision(session,['api','product-workflows','templates'],'POST').allowed,features.ai);
    if (!features.ai) assert.throws(()=>assertAiSkillsAvailable(session), /团队版/);
    assert.equal(canAccessPage(session,'/dashboard'),true);
    assert.equal(authorizeApiRequest({_session:session,method:'GET'},['api','dashboard']).allowed,true);
    assert.equal(subscriptionAccessDecision(session,['api','dashboard']).allowed,true);
    assert.equal(aiSkillsApiDecision(session,['api','ai-generation','tasks','abc','cancel'],'POST').allowed,true);
    assert.equal(authorizeApiRequest({_session:session,method:'PUT'},['api','tenants','plans']).allowed,false);
  }
});
test('restored background jobs use the current database plan rather than a saved team entitlement', async () => {
  let sql;
  const session = await restoreBusinessTaskSession('20',1,async statement=>{sql=statement;return [{id:20,slug:'enterprise-a',plan_code:'monthly',subscription_status:'active',tenant_role:'owner',business_roles_json:'["operations"]'}];});
  assert.match(sql,/t.plan_code/);assert.equal(planFeatures(session.tenant).ai,false);assert.equal(planFeatures(session.tenant).tasks,false);
});
