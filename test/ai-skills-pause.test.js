import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as access from '../src/shared/ai-skills-access.js';
import * as permissions from '../src/shared/permissions.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { checkAiCreditProviderBoundary, withAiCreditProviderPermit } from '../src/services/ai-credit-provider-context.js';
const actor = (id, slug) => ({ personId: 9, roles: ['operations'], tenant: { id, slug, role: 'member', access_allowed: true } });
const customer = actor(42, 'customer-a'), internal = actor(7, 'default');

test('active enterprises can enter AI skills with existing business roles; missing context and expired membership remain blocked', () => {
  for (const subject of [customer, internal]) {
    assert.equal(access.aiSkillsAvailable(subject), true);
    for (const path of ['/product-workflows','/ai-variant-lab','/ai-product-material-optimizer','/ai-ecommerce-suite']) assert.equal(permissions.canAccessPage(subject, path), true, path);
  }
  assert.equal(access.aiSkillsAvailable({}), false);
  assert.equal(permissions.canAccessPage({ ...customer, roles: ['packing'] }, '/product-workflows'), false);
  assert.equal(permissions.canAccessPage({ ...customer, tenant: { ...customer.tenant, access_allowed: false } }, '/product-workflows'), false);
});

test('the customer skill menu is clickable and credits remain available', () => {
  const source = readFileSync(new URL('../frontend/admin/constants/navigation.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
  const icons = Object.fromEntries('House ListChecks ChartNoAxesCombined ChartColumn Store Sparkles Package Warehouse ShoppingCart TriangleAlert Wrench Settings MessageCircle'.split(' ').map(name => [name, name]));
  const context = vm.createContext({ ...icons, ...permissions, ...access }); vm.runInContext(source, context);
  const menus = context.navigationMenusForRole(customer), skills = menus.find(menu => menu.key === 'ai-skills');
  assert.ok(skills.children.length > 0); assert.ok(!skills.disabled); assert.ok(skills.children.every(child => !child.disabled));
  assert.ok(menus.some(menu => menu.children?.some(child => child.route === '/ai-credits')));
});

test('reviewed customer generation routes reopen while unknown routes remain isolated', () => {
  for (const parts of [['api','ai-generation','tasks'], ['api','product-workflows','templates'], ['api','ai-variant-lab','analyze-image']]) {
    assert.equal(tenantIsolationDecision(customer, parts, 'POST').allowed, true, parts.join('/'));
  }
  assert.equal(tenantIsolationDecision(customer, ['api','unreviewed-ai-service','generate'], 'POST').allowed, false);
  assert.equal(tenantIsolationDecision(customer, ['api','ai-credits','wallet'], 'GET').allowed, true);
});

test('default and customer images require the same funded wallet permit; text is free', async () => {
  for (const session of [customer, internal]) {
    const query = async sql => sql.includes('FROM tenants') ? [{ id: session.tenant.id, slug: session.tenant.slug, feature_flags_json: { ai_internal_mode_reviewed: true } }] : [{ tenant_id: session.tenant.id, status: 'active', available_points: '100', frozen_points: '0' }];
    await assert.rejects(checkAiCreditProviderBoundary(session, 'image', query), { code: 'AI_CREDIT_CAPABILITY_DISABLED' });
    assert.equal((await withAiCreditProviderPermit(session, 'image', () => checkAiCreditProviderBoundary(session, 'image', query))).mode, 'credits');
    assert.equal((await checkAiCreditProviderBoundary(session, 'text', async () => { throw new Error('Text is free'); })).mode, 'free');
  }
});
