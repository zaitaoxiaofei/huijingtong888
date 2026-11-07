import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mergeDashboardSections } from '../src/shared/dashboard-sections.js';

const backend = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const frontend = readFileSync(new URL('../frontend/admin/views/DashboardView.vue', import.meta.url), 'utf8');
const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));
function extract(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end).replace(/^export /, '');
}
const builderSource = extract(backend, 'async function buildDashboardPayloadMysql', 'async function rebuildDashboardSnapshotMysql');
function builderContext(overrides = {}) {
  return {
    orderListTenantScopeMysql: async id => ({ id }), dashboardShopPredicateMysql: () => '1=1',
    todayDateKeyMysql: () => '2026-10-30', invalidateDashboardCachesMysql() {},
    profitOrderedAtUtcRangeMysql: () => ({ whereSql: '', params: [] }),
    mysqlQueryOne: async () => ({ order_max_id: 10 }),
    dateKeyMysql: value => value.toISOString().slice(0, 10),
    addDaysMysql: (value, days) => new Date(value.getTime() + days * 86400000),
    latestDashboardAdDateMysql: async () => '',
    async mapWithConcurrencyMysql(tasks, limit, load) {
      let index = 0;
      const results = [];
      await Promise.all(Array.from({ length: limit }, async () => {
        while (index < tasks.length) {
          const position = index++;
          results[position] = await load(tasks[position]);
        }
      }));
      return results;
    },
    dashboardRecentCommerceMysql: async () => ({ today: { effective_orders: 9, profit: 80 }, yesterday: {}, shops: [] }),
    dashboardProfitTrendSummaryMysql: async () => ({ month_profit: 100 }),
    dashboardMonthShippingCostSummaryMysql: async () => ({ order_outcomes_available: true, order_count: 9 }),
    dashboardAdSummaryMysql: async () => ({ spend_cny: 10 }),
    dashboardFbpInventoryValueMysql: async () => ({ value: 30, quantity: 3 }),
    dashboardAftersalesLossSummaryMysql: async () => ({}), dashboardAiUsageMysql: async () => ({}),
    stockAlertsMysql: async () => ({ rows: [], meta: {} }),
    procurementRequestsMysql: async () => ({ rows: [], total: 0 }),
    roundMoneyMysql: value => Number(value || 0), ...overrides
  };
}

test('core daily/monthly metrics are published while slow inventory and procurement scans remain pending', async () => {
  const stock = deferred(), purchase = deferred();
  let progress = {}, finished = false;
  const build = vm.runInNewContext(`(${builderSource})`, builderContext({
    stockAlertsMysql: () => stock.promise, procurementRequestsMysql: () => purchase.promise
  }));
  const work = build({ tenantId: '2', onProgress: patch => { progress = mergeDashboardSections(progress, patch); } });
  work.then(() => { finished = true; });
  await turn();
  assert.equal(finished, false);
  assert.equal(progress.commerce.today.effective_orders, 9);
  assert.equal(progress.commerce.today.profit, 80);
  assert.equal(progress.commerce.profit_trend.month_profit, 100);
  assert.equal(progress.summary.month_order_outcomes.effective_orders, 9);
  assert.equal(progress.commerce.advertising.today.spend_cny, 10);
  stock.resolve({ rows: [], meta: {} }); purchase.resolve({ rows: [], total: 0 });
  const final = await work;
  assert.equal(final.commerce.today.profit, 80);
  assert.equal(final.summary.month_order_outcomes.effective_orders, 9);
});

test('a failing auxiliary scan does not erase completed metrics or produce a saved zero snapshot', async () => {
  let progress = {};
  const build = vm.runInNewContext(`(${builderSource})`, builderContext({ stockAlertsMysql: async () => { throw Error('slow section failed'); } }));
  await assert.rejects(build({ onProgress: patch => { progress = mergeDashboardSections(progress, patch); } }), /slow section failed/);
  assert.equal(progress.commerce.today.profit, 80);
  assert.equal(progress.summary.fbp_inventory_value, 30);
});

function routeContext() {
  const context = {
    ensureMysqlCutoverEnabled() {}, orderListTenantScopeMysql: async id => ({ id }),
    shouldRefreshDashboardMysql: query => query.refresh === '1', dashboardDateKeyMysql: () => '2026-10-30',
    dashboardSnapshotKeyMysql: (day, tenant) => `${tenant}:${day}`,
    dashboardSnapshotRefreshJobsMysql: new Map(), dashboardSnapshotProgressMysql: new Map(),
    loadDashboardSnapshotMysql: async (_day, tenant) => ({ commerce: { today: { profit: Number(tenant) } }, snapshot: { status: 'snapshot' } }),
    pendingDashboardPayloadMysql: () => ({ snapshot: { status: 'building' } })
  };
  const queued = [];
  context.queueDashboardSnapshotRefreshMysql = options => queued.push(options);
  const route = vm.runInNewContext(`(${extract(backend, 'export async function dashboardMysql', 'export async function inventoryMysql')})`, context);
  return { context, route, queued };
}

test('snapshot polls return saved metrics without foreground aggregates or repeated rebuilds', async () => {
  const { route, queued } = routeContext();
  const result = await route({ snapshotOnly: '1' }, '2');
  assert.equal(result.commerce.today.profit, 2);
  assert.equal(queued.length, 0);
  await route({}, '2');
  assert.equal(queued.length, 1); // Normal visits always refresh live order data asynchronously.
  assert.equal(queued[0].tenantId, '2');
});

test('in-progress data stays tenant/date scoped and repeated refreshes share the running job', async () => {
  const { context, route, queued } = routeContext();
  context.dashboardSnapshotRefreshJobsMysql.set('2:2026-10-30', {});
  context.dashboardSnapshotProgressMysql.set('2:2026-10-30', { commerce: { today: { profit: 222 } }, snapshot: { status: 'building' } });
  assert.equal((await route({}, '2')).commerce.today.profit, 222);
  assert.equal(queued.length, 0);
  assert.equal((await route({ snapshotOnly: '1' }, '3')).commerce.today.profit, 3);
});

test('partial section merge preserves completed ads, summary and freshness metadata', () => {
  const merged = mergeDashboardSections({ snapshot: { status: 'building' }, summary: { ai_usage: { amount: 4 } }, commerce: { today: { profit: 8 }, advertising: { today: { spend_cny: 10 } } } }, { commerce: { advertising: { month: { spend_cny: 20 } } } });
  assert.equal(merged.commerce.today.profit, 8);
  assert.equal(merged.commerce.advertising.today.spend_cny, 10);
  assert.equal(merged.commerce.advertising.month.spend_cny, 20);
  assert.equal(merged.summary.ai_usage.amount, 4);
  assert.equal(merged.snapshot.status, 'building');
});

test('frontend publishes metrics before requesting optional ranking/stock panels', async () => {
  const metrics = deferred();
  const calls = [], ref = value => ({ value });
  const context = {
    dashboardRequestSeq: 0, selectedDate: ref('2026-10-30'), hasDashboardLoaded: ref(false),
    dashboardSnapshotRefreshAttempts: 0, loading: ref(false), refreshing: ref(false), snapshotBuilding: ref(false),
    currentApiCacheScope: () => 'tenant2', readDashboardSessionCache: () => null,
    getDashboardWithRetry: url => { calls.push(url); return metrics.promise; },
    loadOverviewPanels: () => calls.push('optional-panels'), mergeDashboardPayload: payload => calls.push(payload.commerce.today.profit),
    writeDashboardSessionCache() {}, scheduleDashboardSnapshotReload() {}, ElMessage: { error() {}, warning() {} }, console
  };
  const load = vm.runInNewContext(`(${extract(frontend, 'async function loadDashboard', 'async function loadTopInventory')})`, context);
  const work = load();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/api\/dashboard\?/);
  metrics.resolve({ snapshot: { status: 'building' }, commerce: { today: { profit: 80 } } });
  await work;
  assert.deepEqual(calls.slice(1), [80, 'optional-panels']);
  assert.equal(context.loading.value, false);
});

test('slow ranking and FBP opportunities do not keep shop capacity loading', async () => {
  const limits = deferred(), ranking = deferred(), opportunities = deferred();
  const context = {
    overviewRequestSeq: 0, selectedDate: { value: '2026-10-30' }, shopLimitsLoading: { value: false },
    shopProductLimits: { value: [] }, dashboard: { value: { summary: {} } }, currentApiCacheScope: () => 'tenant2',
    getDashboardWithRetry: url => url.includes('limits') ? limits.promise : opportunities.promise,
    loadTopInventory: () => ranking.promise
  };
  const load = vm.runInNewContext(`(${extract(frontend, 'async function loadOverviewPanels', 'function scheduleDashboardSnapshotReload')})`, context);
  const work = load();
  limits.resolve({ rows: [{ shop_id: 20 }] }); await turn();
  assert.equal(context.shopLimitsLoading.value, false);
  assert.equal(context.shopProductLimits.value[0].shop_id, 20);
  ranking.resolve(); opportunities.resolve({ summary: {} }); await work;
});

test('refresh job publishes partial sections, shares duplicate work, and clears progress only after success', async () => {
  const result = deferred(); let startCount = 0, publish;
  const context = {
    todayDateKeyMysql: () => '2026-10-30', dashboardSnapshotKeyMysql: (day, tenant) => `${tenant}:${day}`,
    dashboardSnapshotRefreshJobsMysql: new Map(), dashboardSnapshotProgressMysql: new Map(),
    mergeDashboardSections, pendingDashboardPayloadMysql: () => ({ snapshot: { status: 'building' } }),
    rebuildDashboardSnapshotMysql: options => { startCount++; publish = options.onProgress; return result.promise; }, console
  };
  const queue = vm.runInNewContext(`(${extract(backend, 'function queueDashboardSnapshotRefreshMysql', 'function pendingDashboardPayloadMysql')})`, context);
  const options = { dateKey: '2026-10-30', tenantId: '2', snapshot: { commerce: { today: { profit: 1 } } } };
  queue(options); queue(options);
  assert.equal(startCount, 1);
  publish({ commerce: { today: { profit: 80 } } });
  assert.equal(context.dashboardSnapshotProgressMysql.get('2:2026-10-30').commerce.today.profit, 80);
  result.resolve(); await context.dashboardSnapshotRefreshJobsMysql.get('2:2026-10-30');
  assert.equal(context.dashboardSnapshotProgressMysql.size, 0);
  assert.equal(context.dashboardSnapshotRefreshJobsMysql.size, 0);
});

test('failed refresh retains current core metrics for polling instead of rolling back to an older snapshot', async () => {
  const result = deferred(); let publish;
  const context = {
    todayDateKeyMysql: () => '2026-10-30', dashboardSnapshotKeyMysql: () => '2:2026-10-30',
    dashboardSnapshotRefreshJobsMysql: new Map(), dashboardSnapshotProgressMysql: new Map(),
    mergeDashboardSections, pendingDashboardPayloadMysql: () => ({ snapshot: { status: 'building' } }),
    rebuildDashboardSnapshotMysql: options => { publish = options.onProgress; return result.promise; }, console: { warn() {} }
  };
  const queue = vm.runInNewContext(`(${extract(backend, 'function queueDashboardSnapshotRefreshMysql', 'function pendingDashboardPayloadMysql')})`, context);
  queue({ tenantId: '2' }); publish({ commerce: { today: { profit: 80 } } });
  result.reject(Error('auxiliary failure')); await context.dashboardSnapshotRefreshJobsMysql.get('2:2026-10-30');
  const partial = context.dashboardSnapshotProgressMysql.get('2:2026-10-30');
  assert.equal(partial.commerce.today.profit, 80);
  assert.equal(partial.snapshot.status, 'partial');
  assert.equal(context.dashboardSnapshotRefreshJobsMysql.size, 0);
});
