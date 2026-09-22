import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const service = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const view = readFileSync(new URL('../frontend/admin/views/procurement/ProcurementWorkspaceView.vue', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function workspace() {
  const requests = [], errors = [];
  const context = vm.createContext({
    AbortController, disposed: false, rowsController: null, loading: { value: false },
    demandRefreshing: { value: false }, state: { rows: [], total: 0 }, queryString: () => 'page=1',
    ElMessage: { error: message => errors.push(message), warning: message => errors.push(message) },
    apiClient: Object.fromEntries(['get', 'post'].map(method => [method, (url, options) => {
      const task = deferred(); requests.push({ method, url, options, ...task }); return task.promise;
    }]))
  });
  vm.runInContext(view.slice(view.indexOf('async function loadRows('), view.indexOf('async function loadOptions(')), context);
  return { context, requests, errors };
}

test('procurement first paint does not wait for demand reconciliation', async () => {
  const { context, requests } = workspace();
  const load = context.loadRows();
  assert.equal(requests[0].method, 'get');
  requests[0].resolve({ rows: [{ id: 1 }], total: 1 });
  await load;
  assert.equal(context.state.rows[0].id, 1);
  const refresh = context.refreshWorkbench();
  assert.equal(context.demandRefreshing.value, true);
  assert.equal(context.loading.value, false);
  await context.refreshWorkbench();
  assert.equal(requests.length, 2, 'repeated refreshes are coalesced');
  requests[1].resolve({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  requests[2].resolve({ rows: [{ id: 2 }], total: 1 });
  await refresh;
  assert.equal(context.state.rows[0].id, 2);
  assert.equal(context.demandRefreshing.value, false);
  const mount = view.slice(view.indexOf('onMounted(async'), view.indexOf('</script>'));
  assert.match(mount, /loadRows\(\)/);
  assert.doesNotMatch(mount, /loadRows\(\{ refreshDemand/);
});

test('late procurement search responses cannot overwrite newer results', async () => {
  const { context, requests, errors } = workspace();
  const old = context.loadRows();
  const latest = context.loadRows();
  assert.equal(requests[0].options.signal.aborted, true);
  requests[1].resolve({ rows: [{ id: 2 }], total: 1 });
  await latest;
  requests[0].resolve({ rows: [{ id: 1 }], total: 1 });
  await old;
  assert.equal(context.state.rows[0].id, 2);
  assert.equal(errors.length, 0);
  const refresh = context.refreshWorkbench();
  requests[2].reject(new Error('refresh unavailable'));
  await refresh;
  assert.equal(context.state.rows[0].id, 2, 'refresh failure preserves visible records');
  assert.equal(errors.length, 1);
});

test('profit ranking limits classification to the Beijing date range with matching SQL parameters', async () => {
  const calls = [];
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {},
    normalizeMysqlDateTime: date => date.toISOString().slice(0, 19).replace('T', ' '),
    buildOrderOutcomeSql: () => ({ effectiveSale: 'TRUE', afterDeliveryReturn: 'FALSE', rejectedUnclaimed: 'FALSE' }),
    terminalOrderLossSqlMysql: () => '0', returnLossTotalSqlMysql: () => '0',
    mysqlQuery: async (sql, params) => { calls.push({ sql, params }); return []; },
    mysqlQueryOne: async (sql, params) => { calls.push({ sql, params }); return { total: 0 }; }
  });
  vm.runInContext(service.slice(service.indexOf('function shanghaiDateKeyToUtcDateTimeMysql('), service.indexOf('function profitDateExpressionWhereMysql('))
    + service.slice(service.indexOf('export async function profitRankingMysql('), service.indexOf('function monthRangeMysql(')).replace('export ', ''), context);
  for (const fast of ['0', '1']) {
    calls.length = 0;
    await context.profitRankingMysql({ dimension: 'shop', from: '2026-09-21', to: '2026-09-22', keyword: 'store', fast });
    for (const { sql, params } of calls) {
      assert.match(sql, /FROM orders o\s+WHERE 1=1 AND o\.ordered_at >= \? AND o\.ordered_at < \?\s+GROUP BY/);
      assert.equal((sql.match(/\?/g) || []).length, params.length);
      assert.deepEqual(Array.from(params.slice(0, 5)), ['2026-09-20 16:00:00', '2026-09-22 16:00:00', '2026-09-20 16:00:00', '2026-09-22 16:00:00', '%store%']);
    }
  }
});

test('background admission preserves dedicated orders lane and frees capacity after completion', () => {
  const context = vm.createContext({ process: { env: {} } });
  vm.runInContext(server.slice(server.indexOf('const backgroundModuleLanes ='), server.indexOf('function backgroundModuleLaneStatus(')), context);
  assert.equal(context.claimBackgroundModuleLane('finance', 'finance-sync'), '');
  assert.equal(context.claimBackgroundModuleLane('analytics', 'analytics-sync'), 'background_capacity');
  assert.equal(context.claimBackgroundModuleLane('orders', 'order-sync'), '');
  assert.equal(context.claimBackgroundModuleLane('customer_messages', 'message-sync'), '');
  assert.equal(context.claimBackgroundModuleLane('orders', 'another-sync'), 'order-sync');
  context.releaseBackgroundModuleLane('finance', 'wrong-job');
  assert.equal(context.claimBackgroundModuleLane('inventory', 'stock-sync'), 'background_capacity');
  context.releaseBackgroundModuleLane('finance', 'finance-sync');
  assert.equal(context.claimBackgroundModuleLane('inventory', 'stock-sync'), '');
});

test('single-order procurement reconciles only related products but keeps cross-order allocation', async () => {
  const calls = [];
  const context = vm.createContext({
    ensureStockLocationSchemaMysql: async () => {}, ensureProductCompositionSchemaMysql: async () => {},
    localStockLocationPredicateMysql: () => '1=1', chinaDateSqlMysql: column => column,
    orderStatusSqlMysql: () => '1=1',
    mysqlQuery: async () => [{ order_id: 1, order_item_id: 7, product_id: 10 }, { order_id: 2, order_item_id: 8, product_id: 10 }],
    orderProcurementCoverageMysql: async options => {
      calls.push(options);
      return new Map([[1, { stock_location: 'LOCAL', items: [{ order_item_id: 7, product_id: 10, stock_quantity: 1, incoming_quantity: 0, shortage_quantity: 0 }] }],
        [2, { stock_location: 'LOCAL', items: [{ order_item_id: 8, product_id: 10, stock_quantity: 0, incoming_quantity: 0, shortage_quantity: 1 }] }]]);
    }
  });
  vm.runInContext(service.slice(service.indexOf('async function orderProcurementCandidateRowsMysql('), service.indexOf('async function orderProcurementMissingItemsMysql(')), context);
  const rows = await context.orderProcurementCandidateRowsMysql(1);
  assert.deepEqual(Array.from(calls[0].productIds), [10]);
  assert.equal(rows.length, 2, 'other orders competing for the same stock stay in the allocation');
  assert.equal(rows[0].current_stock, 1);
  assert.equal(rows[1].operational_shortage, 1);
  const save = service.slice(service.indexOf('export async function createOrderProcurementRequestsMysql('), service.indexOf('export async function updateProcurementRequestMysql('));
  assert.doesNotMatch(save, /await orderProcurementCoverageMysql\(\)/);
  assert.match(save, /await orderUsesFbpStockMysql\(orderId\)/);
});
