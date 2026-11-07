import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeMobileDashboardDate, mobileDashboardPeriod } from '../src/shared/mobile-dashboard.js';
import { shanghaiDateKey } from '../src/shanghai-time.js';
import { canAccessPage, pagePermission } from '../src/shared/permissions.js';
import { createMobileDashboardHandler } from '../src/server/routes/mobileDashboard.js';

test('mobile dates use Beijing today, exact calendar days, and explicit aliases across month/year/leap boundaries', () => {
  const today = shanghaiDateKey(new Date('2026-01-31T16:00:00.000Z'));
  assert.equal(today, '2026-02-01');
  assert.equal(normalizeMobileDashboardDate({}, today), today);
  for (const date of ['2024-02-29', '2025-12-31', '2026-01-31']) {
    for (const key of ['date', 'dateKey', 'date_key']) assert.equal(normalizeMobileDashboardDate({ [key]: date }, today), date);
  }
  assert.equal(normalizeMobileDashboardDate({ date: ' 2026-01-31 ', date_key: '2026-01-31' }, today), '2026-01-31');
  assert.deepEqual(mobileDashboardPeriod('2025-12-31'), { month_key: '2025-12', from: '2025-12-01', to: '2025-12-31', timezone: 'Asia/Shanghai' });
});

test('mobile invalid or future dates refuse explicitly instead of changing to today', () => {
  for (const date of ['', null, 20260131, ['2026-01-31'], '2025-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '0999-01-01', '2026-01-01T00:00:00Z', '2026-1-1', 'not-a-date']) {
    assert.throws(() => normalizeMobileDashboardDate({ date }, '2026-11-06'), { statusCode: 400, code: 'MOBILE_DASHBOARD_DATE_INVALID' });
  }
  assert.throws(() => normalizeMobileDashboardDate({ date: '2026-01-31', date_key: '2026-01-30' }, '2026-11-06'), { statusCode: 400 });
  assert.throws(() => normalizeMobileDashboardDate({ date: '2026-11-07' }, '2026-11-06'), { statusCode: 400, code: 'MOBILE_DASHBOARD_DATE_FUTURE' });
});

test('mobile authorization precedes date validation and invalid dates never start dashboard or financial work', async () => {
  const calls = [];
  const subject = { personId: 7, roles: ['operations'], tenant: { id: 2, slug: 'a', role: 'owner' } };
  const handler = createMobileDashboardHandler({ authorize: async () => { calls.push('authorize'); return subject; },
    dashboard: async () => { calls.push('dashboard'); return {}; }, finance: async () => { calls.push('finance'); return {}; } });
  for (const view of ['mobile', 'mobile-finance']) for (const date of ['2025-02-29', '9999-01-01']) {
    await assert.rejects(handler({ query: { view, date, refresh: '1' } }), { statusCode: 400 });
  }
  assert.deepEqual(calls, Array(4).fill('authorize'));
  const revoked = createMobileDashboardHandler({ authorize: async () => { throw Object.assign(new Error('Revoked'), { statusCode: 403 }); }, dashboard: async () => assert.fail('must not load'), finance: async () => assert.fail('must not load') });
  await assert.rejects(revoked({ query: { view: 'mobile', date: 'invalid' } }), { statusCode: 403 });
});

test('mobile historical/polling requests carry the selected day and fresh session enterprise without trusting query ownership', async () => {
  const owner = { personId: 7, roles: ['packing'], tenant: { id: 2, slug: 'a', role: 'owner' } };
  const calls = [];
  const handler = createMobileDashboardHandler({ authorize: async () => owner,
    dashboard: async (query, tenantId) => { calls.push({ kind: 'dashboard', query, tenantId }); return { commerce: { date_key: query.date, today: { effective_orders: 3 } } }; },
    finance: async (query, tenantId) => { calls.push({ kind: 'finance', query, tenantId }); return { date_key: query.date }; } });
  const selected = '2024-02-29';
  const response = await handler({ _session: { tenant: { id: 3 } }, query: { view: 'mobile', date_key: selected, snapshotOnly: '1', tenant_id: '3' } });
  assert.equal(response.date_key, selected);
  await handler({ query: { view: 'mobile-finance', date: selected, tenant_id: '3' } });
  await handler({ query: { view: 'mobile' } });
  assert.equal(calls[0].query.date, selected);
  assert.equal(calls[0].query.snapshotOnly, '1');
  assert.equal(calls[1].query.date, selected);
  assert.equal(calls[2].query.date, shanghaiDateKey());
  assert(calls.every(call => call.tenantId === 2));
  const staff = createMobileDashboardHandler({ authorize: async () => ({ ...owner, tenant: { ...owner.tenant, role: 'member' } }), dashboard: async () => ({}), finance: async () => assert.fail('staff must not load finance') });
  await assert.rejects(staff({ query: { view: 'mobile-finance', date: selected } }), { statusCode: 403 });
});

test('the actual mobile financial entry preserves monthly billing reads and marks inventory as a current snapshot', async () => {
  const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function mobileDashboardFinanceMysql('), end = source.indexOf('export async function dashboardMysql(', start);
  const reads = [];
  const context = vm.createContext({ Date, ensureMysqlCutoverEnabled() {}, normalizeMobileDashboardDate, mobileDashboardPeriod,
    orderListTenantScopeMysql: async id => ({ id: Number(id), defaultTenant: Number(id) === 1 }),
    monthlyProcurementInventorySummaryMysql: async (from, to, scope) => { reads.push({ from, to, scope }); return { purchase_total_amount: scope.id * 21, inventory_total_value: 100, local_inventory_value: null, fbp_inventory_value: 30, in_transit_value: 10 }; } });
  vm.runInContext(source.slice(start, end).replace('export ', ''), context);
  const response = await context.mobileDashboardFinanceMysql({ date: '2024-02-29', tenant_id: 3 }, 2);
  assert.deepEqual(reads, [{ from: '2024-02-01', to: '2024-02-29', scope: { id: 2, defaultTenant: false } }]);
  assert.equal(response.month_purchase_amount, 42);
  assert.equal(response.local_inventory_value, null, 'unknown values stay unknown');
  assert.equal(response.inventory_basis, 'current');
  assert.equal(response.period.to, response.date_key);
  assert.equal(response.period.timezone, 'Asia/Shanghai');
  assert(!Number.isNaN(Date.parse(response.inventory_snapshot_at)));
  await assert.rejects(context.mobileDashboardFinanceMysql({ date: '9999-01-01' }, 2), { statusCode: 400 });
  assert.equal(reads.length, 1, 'invalid date cannot issue finance reads');
});

test('mobile financial pages match existing enterprise finance authority without legacy-role expansion', () => {
  const paths = ['/mobile/finance', '/mobile/monthly-billing'];
  for (const role of ['owner', 'admin']) for (const tenant of [{ id: 1, slug: 'default' }, { id: 2, slug: 'a' }]) {
    const user = { personId: 7, roles: ['packing'], tenant: { ...tenant, role } };
    for (const path of paths) { assert.equal(pagePermission(path), 'finance'); assert.equal(canAccessPage(user, path), true); }
  }
  for (const roles of [['packing'], ['admin'], ['manager', 'operations']]) for (const path of paths) assert.equal(canAccessPage({ roles, tenant: { id: 1, role: 'member' } }, path), false);
  for (const path of paths) {
    assert.equal(canAccessPage({ platform_role: 'super_admin' }, path), false);
    assert.equal(canAccessPage({ platform_role: 'super_admin', tenant: { id: 2, role: 'member' } }, path), true);
    assert.equal(canAccessPage({ roles: ['packing'], tenant: { id: 2, role: 'owner', access_allowed: false } }, path), false);
  }
});
