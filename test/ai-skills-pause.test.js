import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as access from '../src/shared/ai-skills-access.js';
import * as permissions from '../src/shared/permissions.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { checkAiCreditProviderBoundary, withAiCreditProviderPermit } from '../src/services/ai-credit-provider-context.js';

const actor = (id, slug, extra = {}) => ({ personId: 9, roles: ['operations'], tenant: { id, slug, role: 'member', access_allowed: true }, ...extra });
const customer = actor(1, 'customer-a', { platform_role: 'super_admin' });
const internal = actor(7, 'default');
const paths = ['/ai-variant-lab', '/ai-variant-cases', '/ai-product-material-optimizer', '/ai-ecommerce-suite', '/workflow-materials', '/product-workflows', '/ai-material-optimization-records', '/ai-materials', '/ai-prompts'];

test('only the actual default space keeps AI skills; platform authority and a low tenant ID do not override the pause', () => {
  for (const path of paths) {
    assert.equal(permissions.canAccessPage(customer, path), false, path);
    if (path !== '/ai-prompts') assert.equal(permissions.canAccessPage(internal, path), true, path);
    assert.equal(access.isAiSkillsPage(path + '/detail?task=1'), true);
  }
  assert.equal(access.aiSkillsAvailable(internal), true);
  assert.equal(access.aiSkillsAvailable(customer), false);
  assert.equal(permissions.canAccessPage(customer, '/orders'), true);
  assert.equal(permissions.canAccessPage(customer, '/ai-credits'), true);
});

test('customer AI menu stays visible and disabled while credits remain separately usable', () => {
  const source=readFileSync(new URL('../frontend/admin/constants/navigation.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export ','');
  const icons=Object.fromEntries('ChatDotRound Coin DataAnalysis Document Finished Goods House MagicStick Setting ShoppingCart Tools WarningFilled'.split(' ').map(name=>[name,name]));
  const context=vm.createContext({...icons,...permissions,...access});vm.runInContext(source,context);
  const customerMenus=context.navigationMenusForRole(customer);
  const skills=customerMenus.find(menu=>menu.key==='ai-skills');
  assert.equal(skills.disabled,true);assert.ok(skills.children.length>0);assert.ok(skills.children.every(child=>child.disabled));
  assert.ok(customerMenus.some(menu=>menu.children?.some(child=>child.route==='/ai-credits'&&!child.disabled)));
  assert.ok(!context.navigationMenusForRole(internal).find(menu=>menu.key==='ai-skills').disabled);
});

test('HTTP writes cannot create or resume customer AI jobs; ordinary operations and credit reads remain available', () => {
  for(const resource of ['ai','ai-generation','ai-variant-lab','ai-material-optimization','ai-variant-draft-save','asset-variant-engine','product-workflows']) {
    assert.equal(tenantIsolationDecision(customer,['api',resource,'tasks'],'POST').code,'AI_SKILLS_DISABLED');
  }
  assert.equal(tenantIsolationDecision(customer,['api','ai-credits','wallet'],'GET').allowed,true);
  assert.equal(tenantIsolationDecision(customer,['api','orders'],'GET').allowed,true);
  assert.equal(tenantIsolationDecision(internal,['api','ai-generation','tasks'],'POST').allowed,true);
});

test('queued jobs, retries and provider permits cannot spend for a non-default space, even if its account is funded', async () => {
  let storage=0;
  const query=async()=>{storage++;throw new Error('No billing or provider access is allowed');};
  for(const kind of ['text','image','video']) {
    await assert.rejects(checkAiCreditProviderBoundary(customer,kind,query),{code:'AI_SKILLS_DISABLED',statusCode:403});
    await assert.rejects(withAiCreditProviderPermit(customer,kind,()=>checkAiCreditProviderBoundary(customer,kind,query)),{code:'AI_SKILLS_DISABLED'});
  }
  assert.equal(storage,0);
  const billing=await checkAiCreditProviderBoundary(internal,'text',async sql=>sql.includes('FROM tenants')?[{id:7,slug:'default',feature_flags_json:{}}]:[]);
  assert.equal(billing.mode,'free');
});

test('configuration-only matrix can save reviewed tenant rules while generation stays paused',()=>{
 assert.equal(permissions.canAccessPage(customer,'/asset-variant-center'),true);
 assert.equal(access.aiSkillsApiDecision(customer,['api','asset-variant-engine','rules'],'POST').allowed,true);
 assert.equal(access.aiSkillsApiDecision(customer,['api','asset-variant-engine','generate'],'POST').allowed,false);
});
