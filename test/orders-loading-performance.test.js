import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const composable = readFileSync(new URL('../frontend/orders/composables/useOrdersPage.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../frontend/orders/OrdersPage.vue', import.meta.url), 'utf8');
const service = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../scripts/init-mysql-schema.mjs', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function listHarness() {
  const requests = [], timers = [];
  const context = vm.createContext({
    AbortController, URLSearchParams, console,
    window: { clearTimeout() {}, setTimeout(fn) { timers.push(fn); return timers.length; } },
    ordersMetaTimer: 0, ordersMetaCacheKey: () => 'same-filter',
    ordersMetaCache: new Map(), ordersListCache: new Map(),
    ordersListAbort: { value: null }, ordersMetaAbort: { value: null },
    ordersMetaRequestKey: { value: '' }, ordersLoadToken: { value: 0 }, loading: { value: false },
    vm: { filters: { page: 1, status: 'pending_purchase' }, rows: [], meta: { total: 1, counts: { all: 42 } } },
    buildOrdersParams: (filters, extra) => new URLSearchParams({ ...filters, ...extra }),
    loadShopDictionary: async () => [], cacheOrdersList() {},
    buildStatusTabs: counts => counts, MARK_OPTIONS: [], PRINT_VIEWS: [], MORE_ACTIONS: [],
    ORDERS_LIST_CACHE_TTL_MS: 30000, ORDERS_META_DELAY_MS: 1200, DEFAULT_PAGE_SIZE: 20,
    loadOrdersMeta: () => new Promise(() => {}),
    apiClient: { get(url, options) { const task = deferred(); requests.push({ url, options, ...task }); return task.promise; } },
    ElMessage: { error() {} }
  });
  context.patch = payload => Object.assign(context.vm, payload);
  vm.runInContext(composable.match(/  async function loadOrders\(options = \{\}\) \{[\s\S]*?\n  }/)[0], context);
  return { context, requests, timers };
}

test('every tab returns rows without waiting for all-status counts and preserves existing badges', async () => {
  for (const status of ['pending_purchase', 'purchase_in_transit', 'purchase_records_missing', 'awaiting_packaging', 'awaiting_deliver', 'delivering', 'delivered', 'cancelled', 'dispute', 'all', 'unbound']) {
    const { context, requests, timers } = listHarness();
    context.vm.filters.status = status;
    const loaded = context.loadOrders({ includeCounts: true });
    assert.equal(new URLSearchParams(requests[0].url.split('?')[1]).get('includeCounts'), '0');
    requests[0].resolve({ rows: [{ id: 7 }], total: 3, counts: {} });
    await loaded;
    assert.equal(context.loading.value, false);
    assert.equal(context.vm.rows[0].id, 7);
    assert.equal(context.vm.meta.total, 3);
    assert.equal(context.vm.meta.counts.all, 42);
    assert.equal(timers.length, 1);
    timers[0](); // Deliberately unresolved counts do not hold the list promise.
  }
});

test('mutation refresh aborts old counts; late old rows cannot overwrite a newer tab', async () => {
  const { context, requests } = listHarness();
  const oldMeta = new AbortController();
  context.ordersMetaAbort.value = oldMeta;
  context.ordersMetaRequestKey.value = 'same-filter';
  context.ordersMetaCache.set('same-filter', {});
  const first = context.loadOrders();
  context.vm.filters.status = 'delivered';
  const second = context.loadOrders({ forceRefresh: true });
  assert.equal(oldMeta.signal.aborted, true);
  assert.equal(context.ordersMetaCache.size, 0);
  requests[1].resolve({ rows: [{ id: 2 }], total: 1 });
  await second;
  requests[0].resolve({ rows: [{ id: 1 }], total: 99 });
  await first;
  assert.equal(context.vm.rows[0].id, 2);
  assert.equal(context.vm.filters.status, 'delivered');
});

test('purchase save waits for persistence but not the following list refresh', async () => {
  const write = deferred(), refresh = deferred();
  let refreshed = false;
  const messages = [];
  const context = vm.createContext({
    orderProcurementDialog: { orderId: 1, selectedItemIds: [2], visible: true, submitting: false },
    validateProcurementPurchaseInputs: async () => true,
    procurementPurchasePayload: () => [],
    createOrderProcurementRequests: () => write.promise,
    loadOrders: () => { refreshed = true; return refresh.promise; },
    ElMessage: { success: message => messages.push(message), info() {}, error: message => messages.push(message) }
  });
  vm.runInContext(page.match(/async function submitOrderProcurement\(\) \{[\s\S]*?\n}/)[0], context);
  const saving = context.submitOrderProcurement();
  await Promise.resolve();
  assert.equal(context.orderProcurementDialog.visible, true);
  assert.equal(refreshed, false);
  write.resolve({ marked_count: 1, created_count: 1, purchase_order_no: 'P-1' });
  await saving;
  assert.equal(refreshed, true);
  assert.equal(context.orderProcurementDialog.submitting, false);
  assert.equal(context.orderProcurementDialog.visible, false);
  refresh.reject(new Error('Refresh failed'));
  await Promise.resolve();
  assert.equal(messages.length, 1, 'a committed purchase must not be reported as failed');
});

test('transport history index covers the correlated status/minimum-time lookup for new and existing databases', () => {
  assert.ok(schema.includes('KEY idx_order_history_transport (order_id, status, last_status_changed_at)'));
  assert.ok(schema.includes('CREATE INDEX idx_order_history_transport ON order_status_history (order_id, status, last_status_changed_at) ALGORITHM=INPLACE LOCK=NONE'));
});

test('order save does not scan unused global reservations and retains purchase confirmation', () => {
  const create = service.match(/export async function createOrderProcurementRequestsMysql\([\s\S]*?\n}/)[0];
  assert.ok(!create.includes('reservedRows'));
  assert.ok(create.includes('await confirmPurchaseOrderMysql'));
});

test('purchase price checks remain mandatory unless an exception reason is supplied', async () => {
  for (const anomalyReason of ['', 'Operator confirmed price']) {
    let historyReads = 0, costWrites = 0;
    const connection = {
      query: async () => [[{ id: 3, product_id: 4, actual_quantity: 1, amount: 120 }]],
      execute: async () => [{}]
    };
    const context = vm.createContext({
      ensureMysqlCutoverEnabled() {}, ensurePurchaseCostVersionSchemaMysql: async () => {},
      withMysqlTransaction: fn => fn(connection),
      mysqlConnectionQueryOne: async (_connection, sql) => sql.includes('purchase_orders') ? { status: 'pending_purchase' } : null,
      requireSessionPersonIdMysql: async () => 1,
      historicalPurchasedUnitCostMysql: async () => { historyReads++; return 100; },
      purchaseChannelSnapshotMysql: async () => ({}),
      recordPurchaseCostVersionMysql: async () => { costWrites++; },
      invalidateOrderProcurementCoverage() {}
    });
    vm.runInContext(service.match(/export async function confirmPurchaseOrderMysql\([\s\S]*?\n}/)[0].replace('export ', ''), context);
    if (!anomalyReason) {
      await assert.rejects(context.confirmPurchaseOrderMysql(1, {}), /上涨超过10%/);
      assert.equal(historyReads, 1);
      assert.equal(costWrites, 0);
    } else {
      await context.confirmPurchaseOrderMysql(1, { anomaly_reason: anomalyReason });
      assert.equal(historyReads, 0);
      assert.equal(costWrites, 1, 'cost history is still written even when the repeated validation query is skipped');
    }
  }
});
