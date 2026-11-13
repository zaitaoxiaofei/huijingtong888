import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dashboardForSession, dashboardMetricsForSession, canViewDashboardFinance } from '../src/shared/dashboard-visibility.js';
import { mobileDashboard } from '../src/shared/mobile-dashboard.js';
import { authorizeDashboardSession } from '../src/services/dashboard-access.js';
import { createProfitRoutes } from '../src/server/routes/profit.js';
import { createDashboardHandler } from '../src/server/routes/dashboard.js';
import { createMobileDashboardHandler } from '../src/server/routes/mobileDashboard.js';

const staff = { personId: 7, roles: ['operations'], tenant: { id: 2, slug: 'a', role: 'member' } };
const admin = { ...staff, tenant: { ...staff.tenant, role: 'admin' } };
const payload = {
 summary: { procurement_amount: 777716, fbp_inventory_value: 777701, month_shipping_cost: { revenue: 4200, item_quantity: 5, purchase_cost: 777702, purchase_cost_ratio: .2345, shipping_cost: 777703, shipping_cost_ratio: .3456, shops: [{ shop_name: 'A', revenue: 4200, purchase_cost: 777704 }] }, aftersales_loss: { return_rate: .01, return_quantity: 1, return_loss_cny: 777705, shops: [{ shop_name: 'A', return_quantity: 1, return_loss_cny: 777706 }] }, ai_usage: { cost: .038, balance: 777707, available: true, provider_secret: 'private-provider', people: [{ person_name: 'A', allocated_cost: .038 }] } },
 commerce: { date_key: '2026-11-12', today: { effective_revenue: 4200, effective_orders: 95, profit: 777708 }, yesterday: { effective_revenue: 4100, profit: 777709 }, profit_trend: { month_total_revenue: 162433, month_effective_orders: 3514, month_total_profit: 777710, daily: [{ date_key: '2026-11-12', revenue: 4200, profit: 777711 }] }, shops: [{ shop_name: 'A', effective_revenue: 4200, current_profit: 777712, purchase_cost: 777713 }], advertising: { today: { roi: 16.53, spend_cny: 14 }, month: { spend_cny: 6400 } } },
 snapshot: { status: 'building', partial: true }, alerts: { procurement: [{ product_name: 'A', total_quantity: 2, total_amount: 777717 }] }, private_extension: [{ net_profit: 777714, inventory_total_value: 777715 }]
};

test('all ordinary duties retain sales/orders/ROI but no profit, cost, valuation, loss or derived cost ratio at any depth', () => {
 for (const role of ['operations','packing','procurement','manager','technical','operator']) {
  const result = dashboardForSession(payload, { ...staff, roles: [role] });
  assert.equal(result.financial, false);
  assert.equal(result.commerce.today.effective_revenue, 4200);
  assert.equal(result.commerce.profit_trend.month_total_revenue, 162433);
  assert.equal(result.summary.month_shipping_cost.item_quantity, 5);
  assert.equal(result.summary.aftersales_loss.return_rate, .01);
  assert.equal(result.commerce.advertising.month.spend_cny, 6400);
  assert.equal(result.summary.ai_usage.cost, .038);
  assert.equal(result.summary.ai_usage.balance, null);
  assert.equal(result.summary.ai_usage.people[0].allocated_cost, .038);
  assert.ok(!JSON.stringify(result).includes('7777'));
  assert.ok(!JSON.stringify(result).includes('private-provider'));
  assert.equal(result.summary.month_shipping_cost.purchase_cost_ratio, undefined);
  assert.equal(result.summary.month_shipping_cost.shipping_cost_ratio, undefined);
  assert.equal(result.commerce.profit_trend.daily[0].profit, undefined);
 }
 assert.equal(payload.commerce.today.profit, 777708, 'a staff projection cannot mutate the shared administrator snapshot');
 assert.equal(payload.summary.ai_usage.balance, 777707);
});

test('existing administrator authority is retained, with enterprise membership required and provider balance still platform-only', () => {
 for (const subject of [admin, { ...staff, tenant: { ...staff.tenant, role: 'owner' } }, { ...staff, roles: ['admin'] }]) {
  assert.equal(canViewDashboardFinance(subject), true);
  const result = dashboardForSession(payload, subject);
  assert.equal(result.commerce.today.profit, 777708);
  assert.equal(result.summary.month_shipping_cost.purchase_cost, 777702);
  assert.equal(result.summary.ai_usage.balance, null);
 }
 assert.equal(canViewDashboardFinance({ platform_role: 'super_admin' }), false);
 const platform = dashboardForSession(payload, { ...admin, platform_role: 'super_admin' });
 assert.equal(platform.summary.ai_usage.balance, 777707);
});

test('ranking rows and both mobile projections enforce the same sensitive-field boundary', () => {
 const ranking = dashboardMetricsForSession({ rows: [{ revenue: 4200, order_count: 9, profit: 777708, purchase_cost: 777702, shipping_cost: 777703 }] }, staff);
 assert.deepEqual(ranking.rows, [{ revenue: 4200, order_count: 9 }]);
 const mobile = mobileDashboard(payload, staff);
 assert.equal(mobile.financial, false);
 assert.equal(mobile.metrics.today_revenue, 4200);
 assert.ok(!JSON.stringify(mobile).includes('7777'));
 const financial = mobileDashboard(payload, admin);
 assert.equal(financial.metrics.month_shipping_cost, 777703);
});

test('desktop refresh and snapshot polls use fresh membership, scoped enterprise and no-store, including downgrades', async () => {
 const calls = [];
 const handler = createDashboardHandler({ authorize: async () => staff, dashboard: async (query, tenant) => { calls.push({ query, tenant }); return payload; } });
 for (const query of [{}, { refresh: '1', tenant_id: '999' }, { snapshotOnly: '1' }]) {
  const req = { query, _session: admin };
  const result = await handler(req);
  assert.equal(result.financial, false);
  assert.ok(!JSON.stringify(result).includes('7777'));
  assert.equal(req._sensitiveResponse, true);
 }
 assert(calls.every(call => call.tenant === 2));
 const revoked = createDashboardHandler({ authorize: async () => { throw Object.assign(new Error('revoked'), { statusCode: 403 }); }, dashboard: async () => assert.fail('revoked membership must never read the snapshot') });
 await assert.rejects(revoked({ _session: admin, query: { refresh: '1' } }), { statusCode: 403 });
 const mobile = createMobileDashboardHandler({ authorize: async () => staff, dashboard: async () => payload, finance: async () => assert.fail('staff must not read finance') });
 await assert.rejects(mobile({ _session: admin, query: { view: 'mobile-finance' } }), { statusCode: 403 });
});


test('an explicit server downgrade also purges an older administrator client snapshot', () => {
 const result = dashboardForSession({ ...payload, financial: false }, admin);
 assert.equal(result.financial, false);
 assert.ok(!JSON.stringify(result).includes('7777'));
});


test('platform financial access requires a current explicit grant and cannot replace an enterprise membership', async () => {
 const session = { ...staff, platform_role: 'super_admin' };
 for (const active of [true, false]) {
  const queries = [];
  const current = await authorizeDashboardSession(session, async (sql, params) => {
   queries.push({ sql, params });
   return sql.includes('platform_grants') ? (active ? [{ person_id: 7 }] : []) : [{ id: 2, slug: 'a', tenant_role: 'member', business_roles_json: ['operations'] }];
  });
  assert.equal(canViewDashboardFinance(current), active);
  assert.equal(queries.length, 2);
  assert.match(queries[1].sql, /active=1/);
 }
 await assert.rejects(authorizeDashboardSession(session, async () => []), { statusCode: 403 });
});

test('homepage ranking handler strips confidential values after refreshing the requesting membership', async () => {
 const routes = createProfitRoutes({ authorize: async () => staff, services: { profitRanking: async (query, tenant) => {
  assert.equal(tenant, 2); return { rows: [{ revenue: 4200, profit: 777708, total_cost: 777702 }] };
 } } });
 const req = { _session: admin };
 const result = await routes['GET /api/profit-ranking'](req, new URL('http://local/api/profit-ranking?tenant_id=999'));
 assert.deepEqual(result.rows, [{ revenue: 4200 }]);
 assert.equal(req._sensitiveResponse, true);
});


test('the browser session cache persists only public metrics even for an administrator', () => {
 const source = readFileSync(new URL('../frontend/admin/views/DashboardView.vue', import.meta.url), 'utf8');
 const start = source.indexOf('function writeDashboardSessionCache('), end = source.indexOf('function dashboardSessionCacheKey(', start);
 let stored;
 const write = vm.runInNewContext(`(${source.slice(start, end)})`, {
  window: { sessionStorage: { setItem(key, value) { stored = JSON.parse(value); } } },
  dashboardSessionCacheKey: () => 'admin-cache', dashboardForSession, authStore: { user: { ...admin, platform_role: 'super_admin' } }
 });
 write('2026-11-12', payload);
 assert.equal(stored.financial, false);
 assert.equal(stored.commerce.today.effective_revenue, 4200);
 assert.ok(!JSON.stringify(stored).includes('7777'));
 assert.ok(!JSON.stringify(stored).includes('private-provider'));
 assert.equal(payload.commerce.today.profit, 777708);
});


test('reading an older administrator cache also strips private fields before the first authenticated response', () => {
 const source = readFileSync(new URL('../frontend/admin/views/DashboardView.vue', import.meta.url), 'utf8');
 const start = source.indexOf('function readDashboardSessionCache('), end = source.indexOf('function writeDashboardSessionCache(', start);
 const read = vm.runInNewContext(`(${source.slice(start, end)})`, {
  window: { sessionStorage: { getItem() { return JSON.stringify(payload); } } },
  dashboardSessionCacheKey: () => 'admin-cache', dashboardForSession, authStore: { user: admin }
 });
 const cached = read('2026-11-12');
 assert.equal(cached.financial, false);
 assert.equal(cached.commerce.today.effective_revenue, 4200);
 assert.ok(!JSON.stringify(cached).includes('7777'));
});
